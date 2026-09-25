import { deployedSolver } from "./solver-deployment";
import {
  assertPaidSolverContract,
  assertSolverPin,
  solverRelease,
} from "../src/lib/provenance";
import { NETWORK_ID } from "../src/lib/network";
import { transactionsEnabled, rehearsalAddressAllowed } from "./network";
import { chain } from "./chain";
import { store } from "./store";
import { validationTick } from "./validation-search";
import { configuredCompute, computeConfigured } from "./compute-provider";
import { release, type Job, type PublicVault } from "../src/lib/model";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { searchVersion, workRange, subsetRank } from "./search-ranges";
import { gpuSpendLimits, nextGpuReservation } from "./gpu-spend";
import {
  HOST_HIT_CAPACITY,
  publishedHitRecords,
} from "./runtime/coverage-ledger";
const cpuClient = new LambdaClient({ region: process.env.AWS_REGION });
type Event = { owner: string; jobId: string; revision: number; polls?: number };
const candidateOutput = z.object({
  status: z.enum(["completed", "interrupted", "failed", "exhausted"]),
  stage: z.string(),
  manifestHash: z.string(),
  attempt: z.number().int(),
  candidates: z.array(z.string().max(16384)).max(32),
  kernelCommit: z.string().regex(/^[a-f0-9]{40}$/),
  checkpoint: z.enum(["range-complete", "requires-verification-or-resume"]),
  workRange: z
    .object({
      version: z.literal(searchVersion),
      start: z.string().regex(/^\d+$/),
      count: z.number().int().positive(),
      sequence: z.number().int().optional(),
      sequenceCount: z.number().int().optional(),
      locktime: z.number().int().optional(),
    })
    .strict(),
});
async function cpu(payload: unknown) {
  const response = await cpuClient.send(
    new InvokeCommand({
      FunctionName: process.env.REFERENCE_FUNCTION,
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  if (response.FunctionError || !response.Payload)
    throw new Error("ReferenceVerificationFailed");
  return JSON.parse(Buffer.from(response.Payload).toString());
}
// Only identifiers enter workflow history. Recovery secrets never enter AWS.
export async function handler(event: Event | { action: "providerHealth" }) {
  // IAM-only Lambda diagnostic; no HTTP route exposes it. This reads provider
  // health only and cannot start compute or bypass the transaction release gate.
  if ("action" in event) {
    z.object({ action: z.literal("providerHealth") })
      .strict()
      .parse(event);
    const provider = await configuredCompute();
    return {
      provider: "aws-batch",
      queue: process.env.AWS_BATCH_JOB_QUEUE,
      health: await provider.health(),
    };
  }
  const pk = `OWNER#${event.owner}`,
    sk = `JOB#${event.jobId}`,
    row = await store.get(pk, sk);
  if (!row) throw new Error("JobNotFound");
  const job = row.job as Job;
  if (event.revision !== job.revision) return { ...event, done: true };
  if (event.owner.startsWith("regtest:") && row.validation) {
    const legacyState = row.validation as {
      active?: { id?: string }[];
      cancel?: string[];
    };
    if (
      job.computeProvider !== "aws-batch" &&
      (legacyState.active?.some((x) => x.id) || legacyState.cancel?.length)
    ) {
      job.status = "paused";
      job.error =
        "Legacy provider job requires reconciliation before AWS migration.";
      await store.put({ ...row, version: row.version + 1, job }, row.version);
      return { ...event, done: true };
    }
    job.computeProvider = "aws-batch";
    return validationTick(event, row, store, await configuredCompute(), cpu);
  }
  const save = () =>
    store.put({ ...row, version: row.version + 1, job }, row.version);
  if (
    ["failed", "awaiting_authorization", "submitted", "confirmed"].includes(
      job.status,
    )
  )
    return { ...event, done: true };
  if (!transactionsEnabled || !rehearsalAddressAllowed(event.owner)) {
    // Capture an uncertain POST before replacing the searching status marker.
    // Otherwise /resume could mistake this paused job for unsubmitted work.
    if (job.status === "searching" && !job.runpodId) {
      if (!job.error?.includes("Submission outcome unknown"))
        job.error = `Submission outcome unknown. Reconcile compute provider before resuming.${job.error ? ` ${job.error}` : ""}`;
      delete job.oneSubmissionAllowed;
    }
    // A deployment rollback must leave paid work reconcilable/resumable.
    // Preserve all IDs, attempt markers, reservations and earlier blocking errors.
    job.status = "paused";
    const disabledReason = !transactionsEnabled
      ? `${NETWORK_ID === "mainnet" ? "Mainnet" : "Network"} disabled by deployment.`
      : "Wallet is not allowed by deployment configuration.";
    if (!job.error?.includes(disabledReason))
      job.error = `${disabledReason}${job.error ? ` ${job.error}` : ""}`;
    await save();
    return { ...event, done: true };
  }
  if (!computeConfigured() || !process.env.REFERENCE_FUNCTION) {
    if (job.status === "searching" && !job.runpodId) {
      if (!job.error?.includes("Submission outcome unknown"))
        job.error = `Submission outcome unknown. Reconcile compute provider before resuming.${job.error ? ` ${job.error}` : ""}`;
      delete job.oneSubmissionAllowed;
    }
    job.status = "paused";
    const reason = "Compute and verification configuration required.";
    if (!job.error?.includes(reason))
      job.error = `${reason}${job.error ? ` ${job.error}` : ""}`;
    await save();
    return { ...event, done: true };
  }
  // Resume may queue a job that already owns a paid provider submission.
  // Persist polling state before external reads so even a transient failure leaves
  // it eligible for operator reconciliation, without issuing another POST.
  if (job.status === "queued" && job.runpodId) {
    job.status = "searching";
    await save();
    row.version++;
  }
  if (job.runpodId && job.computeProvider !== "aws-batch") {
    job.status = "paused";
    job.error =
      "Legacy provider job requires reconciliation before AWS migration.";
    await save();
    return { ...event, done: true };
  }
  const provider = await configuredCompute();
  if (job.status === "paused") {
    if (job.runpodId) {
      const pending = await provider.status(job.runpodId, job.batchSubmission);
      if (["IN_QUEUE", "IN_PROGRESS"].includes(pending.status)) {
        await provider.cancel(job.runpodId);
        // A cancellation acknowledgement is not a terminal job status. Keep
        // polling the durable id, including after a coordinator restart.
        return {
          ...event,
          done: false,
          waitSeconds: 5,
          polls: (event.polls || 0) + 1,
        };
      }
    }
    return { ...event, done: true };
  }
  const vaultRow = await store.get(pk, `VAULT#${job.vaultId}`);
  if (!vaultRow) throw new Error("VaultNotFound");
  const vault = vaultRow.vault as PublicVault;
  if (vault.network !== NETWORK_ID) throw new Error("VaultNetworkMismatch");
  await chain.assertNetwork();
  if (vault.configuration && !job.solver) throw new Error("SolverPinRequired");
  // Legacy jobs retain the historical release explicitly, never the current default.
  const selected = job.solver
    ? assertSolverPin(job.solver, vault)
    : solverRelease("qsb-config-a-ranked-v2-2791ed0");
  if (
    selected.searchVersion !== searchVersion ||
    selected.generatorCommit !== release.qsbCommit
  )
    throw new Error("SolverRuntimeMismatch");
  const referenceInput = {
    publicStateJson: vault.publicStateJson,
    manifest: job.manifest,
    stage: job.stage,
    ...(job.solution
      ? { sequence: job.solution.sequence, locktime: job.solution.locktime }
      : {}),
  };
  if (!job.runpodId) {
    // An uncertain billable submission is reconciled by an operator, never replayed.
    // scripts/reconcile-submission.ts records a provider id or one later submission.
    if (job.status === "searching") {
      job.status = "paused";
      job.error =
        "Submission outcome unknown. Reconcile compute provider before resuming.";
      delete job.oneSubmissionAllowed;
      await save();
      return { ...event, done: true };
    }
    let reservedSeconds: number;
    try {
      reservedSeconds = nextGpuReservation(
        job,
        gpuSpendLimits.executionTimeoutMs,
      );
      if (reservedSeconds > gpuSpendLimits.maxJobGpuSeconds)
        throw new Error(
          "GPU-time budget reached. Further GPU work needs a reviewed budget change.",
        );
    } catch (error) {
      job.status = "paused";
      job.error =
        error instanceof Error ? error.message : "GPU-time accounting invalid.";
      await save();
      return { ...event, done: true };
    }
    // Reject exhausted/invalid stage ranges before reserving paid work.
    try {
      workRange(job.stage, job.attempt);
    } catch {
      job.status = "paused";
      job.error = "Search range exhausted; a reviewed new range is required.";
      await save();
      return { ...event, done: true };
    }
    const parameters = z
      .object({
        parameterBase64: z.string().max(140000),
        parameterSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .parse(await cpu({ ...referenceInput, action: "export" }));
    const key = `${job.stage}:${job.solution?.sequence ?? ""}:${job.solution?.locktime ?? ""}`;
    if (
      job.parameterHashes?.[key] &&
      job.parameterHashes[key] !== parameters.parameterSha256
    )
      throw new Error("SolverParametersChanged");
    job.parameterHashes = {
      ...job.parameterHashes,
      [key]: parameters.parameterSha256,
    };
    let submit: import("./aws-batch").PreparedRun;
    try {
      deployedSolver(selected.id);
      assertPaidSolverContract(selected);
      submit = await provider.prepareRun(selected.image, {
        protocol: selected.protocol,
        kernelCommit: selected.kernelCommit,
        manifestHash: job.manifestHash,
        stage: job.stage,
        attempt: job.attempt,
        searchVersion,
        ...parameters,
        ...(job.solution
          ? { sequence: job.solution.sequence, locktime: job.solution.locktime }
          : {}),
      });
    } catch {
      job.status = "paused";
      job.error =
        "Solver contract, compute provider configuration or public input upload unconfirmed; nothing was submitted. Resume after correcting preparation.";
      await save();
      return { ...event, done: true };
    }
    // This reservation and the never-resubmit marker share the same conditional
    // write. No result status refunds time, including a lost POST response.
    job.gpuBudgetReservedSeconds = reservedSeconds;
    job.gpuSubmissions = (job.gpuSubmissions ?? 0) + 1;
    job.status = "searching";
    job.computeProvider = "aws-batch";
    job.batchSubmission = submit.identity;
    delete job.batchReplacementFor;
    job.submissionStartedAt = new Date().toISOString();
    delete job.retryRequested;
    delete job.oneSubmissionAllowed;
    await save();
    const result = await submit();
    job.runpodId = result.id;
    await store.put({ ...row, version: row.version + 2, job }, row.version + 1);
    return {
      ...event,
      done: false,
      waitSeconds: 5,
      polls: (event.polls || 0) + 1,
    };
  }
  const result = await provider.status(job.runpodId, job.batchSubmission);
  if (["FAILED", "CANCELLED", "TIMED_OUT"].includes(result.status)) {
    if (job.retryRequested) {
      delete job.runpodId;
      delete job.retryRequested;
      job.status = "queued";
    } else {
      job.status = "paused";
      job.error =
        "Compute interrupted. Resume will repeat this bounded range without skipping it.";
    }
  }
  if (result.status === "COMPLETED") {
    const output = candidateOutput.parse(result.output);
    const expectedRange = workRange(job.stage, job.attempt);
    if (
      output.kernelCommit !== selected.kernelCommit ||
      output.manifestHash !== job.manifestHash ||
      output.stage !== job.stage ||
      output.attempt !== job.attempt
    )
      throw new Error("CandidateContextMismatch");
    for (const field of [
      "version",
      "start",
      "count",
      "sequence",
      "sequenceCount",
      "locktime",
    ] as const)
      if (output.workRange[field] !== expectedRange[field])
        throw new Error("CandidateRangeMismatch");
    job.computeSeconds += (result.executionTime || 0) / 1000;
    // The historical worker truncates at 64 and still reports range-complete.
    // An exact 64-record file is not credited as a finished range.
    const records = publishedHitRecords(output.candidates);
    if (records >= HOST_HIT_CAPACITY) {
      delete job.retryRequested;
      job.status = "failed";
      job.error = "GPU hit output exceeds supported capacity.";
    } else {
      const checked = await cpu({
        ...referenceInput,
        action: "verify",
        candidates: output.candidates,
      });
      if (checked.valid === true) {
        delete job.retryRequested;
        if (job.stage === "pinning") {
          const hit = z
            .object({
              sequence: z
                .number()
                .int()
                .min(expectedRange.sequence!)
                .max(
                  expectedRange.sequence! + expectedRange.sequenceCount! - 1,
                ),
              locktime: z
                .number()
                .int()
                .min(expectedRange.locktime!)
                .max(1744600000 - 1),
            })
            .parse(checked);
          job.solution = { ...hit, round1: [], round2: [] };
          job.stage = "round1";
        } else {
          const indices = z
            .array(z.number().int().min(0).max(149))
            .length(9)
            .parse(checked.indices);
          const rank = subsetRank(indices);
          if (
            rank < BigInt(expectedRange.start) ||
            rank >= BigInt(expectedRange.start) + BigInt(expectedRange.count)
          )
            throw new Error("CandidateOutsideAssignedRange");
          if (!job.solution || new Set(indices).size !== 9)
            throw new Error("InvalidReferenceResult");
          if (job.stage === "round1") {
            job.solution.round1 = indices;
            job.stage = "round2";
          } else if (job.stage === "round2") {
            job.solution.round2 = indices;
            job.stage = "verification";
          } else throw new Error("UnexpectedStage");
        }
        job.attempt = 0;
        delete job.runpodId;
        job.status =
          job.stage === "verification" ? "awaiting_authorization" : "queued";
      } else if (output.candidates.length && checked.derOnly !== true) {
        job.status = "paused";
        job.error = "GPU candidates failed independent CPU verification.";
      } else if (
        output.status === "completed" &&
        output.checkpoint === "range-complete"
      ) {
        delete job.retryRequested;
        job.attempt++;
        delete job.runpodId;
        job.status = "queued";
        try {
          workRange(job.stage, job.attempt);
        } catch {
          job.status = "paused";
          job.error =
            "Search range exhausted; a reviewed new range is required.";
        }
      } else {
        if (job.retryRequested) {
          delete job.runpodId;
          delete job.retryRequested;
          job.status = "queued";
        } else {
          job.status = "paused";
          job.error =
            "Incomplete work unit. Resume repeats this bounded range; it has not been skipped.";
        }
      }
    }
  }
  job.updatedAt = new Date().toISOString();
  await save();
  return {
    ...event,
    done: ["paused", "failed", "awaiting_authorization"].includes(job.status),
    polls: (event.polls || 0) + 1,
    waitSeconds: job.status === "queued" ? 0 : 5,
  };
}
