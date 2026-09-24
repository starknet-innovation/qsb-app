import { assertSolverPin, solverRelease } from "../src/lib/provenance";
import { NETWORK_ID } from "../src/lib/network";
import { transactionsEnabled, rehearsalAddressAllowed } from "./network";
import { chain } from "./chain";
import { store } from "./store";
import { validationTick } from "./validation-search";
import { Runpod } from "./providers";
import { release, type Job, type PublicVault } from "../src/lib/model";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { z } from "zod";
import { searchVersion, workRange, subsetRank } from "./search-ranges";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
const secretsClient = new SecretsManagerClient({
  region: process.env.AWS_REGION,
});
const cpuClient = new LambdaClient({ region: process.env.AWS_REGION });
type Event = { owner: string; jobId: string; revision: number; polls?: number };
const candidateOutput = z.object({
  status: z.enum(["completed", "interrupted", "failed", "exhausted"]),
  stage: z.string(),
  manifestHash: z.string(),
  attempt: z.number().int(),
  candidates: z.array(z.string().max(16384)).max(32),
  kernelCommit: z.literal(release.kernelCommit),
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
// Runtime-only credential resolution. Never return credentials, provider headers,
// or raw exceptions from this boundary to callers or logs.
async function configuredRunpod() {
  const secretArn = process.env.RUNPOD_SECRET_ARN,
    endpoint = process.env.RUNPOD_ENDPOINT_ID;
  if (!secretArn || !endpoint) throw new Error("ComputeConfigurationRequired");
  try {
    const secret = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    const key = z
      .object({ apiKey: z.string().min(1) })
      .parse(JSON.parse(secret.SecretString || "{}")).apiKey;
    return new Runpod(endpoint, key);
  } catch {
    throw new Error("ComputeCredentialUnavailable");
  }
}
// Only identifiers enter workflow history. Recovery secrets never enter AWS.
export async function handler(event: Event | { action: "providerHealth" }) {
  // IAM-only Lambda diagnostic; no HTTP route exposes it. This reads provider
  // health only and cannot start compute or bypass the transaction release gate.
  if ("action" in event) {
    z.object({ action: z.literal("providerHealth") })
      .strict()
      .parse(event);
    const provider = await configuredRunpod();
    return {
      endpointId: process.env.RUNPOD_ENDPOINT_ID,
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
    return validationTick(event, row, store, await configuredRunpod(), cpu);
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
    job.status = "failed";
    job.error = "Production QSB validation is not complete.";
    await save();
    return { ...event, done: true };
  }
  const secretArn = process.env.RUNPOD_SECRET_ARN,
    endpoint = process.env.RUNPOD_ENDPOINT_ID;
  if (!secretArn || !endpoint || !process.env.REFERENCE_FUNCTION) {
    job.status = "paused";
    job.error = "Compute and verification configuration required.";
    await save();
    return { ...event, done: true };
  }
  const runpod = await configuredRunpod();
  if (job.status === "paused") {
    if (job.runpodId) {
      const pending = await runpod.status(job.runpodId);
      if (["IN_QUEUE", "IN_PROGRESS"].includes(pending.status)) {
        await runpod.cancel(job.runpodId);
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
  if ((vault.network ?? "mainnet") !== NETWORK_ID)
    throw new Error("VaultNetworkMismatch");
  await chain.assertNetwork();
  if (vault.configuration && !job.solver) throw new Error("SolverPinRequired");
  // Legacy jobs retain the historical release explicitly, never the current default.
  const selected = job.solver
    ? assertSolverPin(job.solver, vault)
    : solverRelease("qsb-config-a-ranked-v2-2791ed0");
  if (
    selected.searchVersion !== searchVersion ||
    selected.kernelCommit !== release.kernelCommit ||
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
        "Submission outcome unknown. Reconcile Runpod before resuming.";
      delete job.oneSubmissionAllowed;
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
    job.status = "searching";
    delete job.retryRequested;
    delete job.oneSubmissionAllowed;
    await save();
    const result = await runpod.run({
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
    job.runpodId = result.id;
    await store.put({ ...row, version: row.version + 2, job }, row.version + 1);
    return {
      ...event,
      done: false,
      waitSeconds: 5,
      polls: (event.polls || 0) + 1,
    };
  }
  const result = await runpod.status(job.runpodId);
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
              .max(expectedRange.sequence! + expectedRange.sequenceCount! - 1),
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
        job.error = "Search range exhausted; a reviewed new range is required.";
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
  job.updatedAt = new Date().toISOString();
  await save();
  return {
    ...event,
    done: ["paused", "awaiting_authorization"].includes(job.status),
    polls: (event.polls || 0) + 1,
    waitSeconds: job.status === "queued" ? 0 : 5,
  };
}
