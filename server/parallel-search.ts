import { z } from "zod";
import { deployedSolver } from "./solver-deployment";
import {
  assertPaidSolverContract,
  assertSolverPin,
  solverRelease,
} from "../src/lib/provenance";
import { NETWORK_ID } from "../src/lib/network";
import { transactionsEnabled } from "./network";
import { chain } from "./chain";
import { configuredCompute, computeConfigured } from "./compute-provider";
import {
  release,
  type Job,
  type PublicVault,
  type SearchSlot,
} from "../src/lib/model";
import { searchVersion, workRange } from "./search-ranges";
import { gpuSpendLimits, nextGpuReservation } from "./gpu-spend";
import {
  OWNER_GPU_BUDGET_REACHED,
  OwnerGpuBudget,
  ownerAllowed,
  saveGpuReservation,
} from "./owner-limits";
import {
  HOST_HIT_CAPACITY,
  publishedHitRecords,
} from "./hit-capacity";
import { candidateOutput, applyVerifiedHit } from "./candidate-output";
import { meterChunk } from "./gpu-usage";
import { UnreadableOutput, type ComputeStatus } from "./aws-batch";
import type { Row, Store } from "./store";

type Event = { owner: string; jobId: string; revision: number; polls?: number };
type Cpu = (payload: unknown) => Promise<any>;

export const UNKNOWN_SUBMISSION =
  "Submission outcome unknown. Reconcile compute provider before resuming.";
const ACTIVE = ["IN_QUEUE", "IN_PROGRESS"];
const STOPPED = ["FAILED", "CANCELLED", "TIMED_OUT"];
const TERMINAL = ["failed", "awaiting_authorization", "submitted", "confirmed"];

/** The single-submission fields of a job, as a slot, or none. Pure: never mutates. */
function legacySlot(job: Job): SearchSlot | undefined {
  if (job.stage === "verification") return undefined;
  const base = {
    stage: job.stage,
    attempt: job.attempt,
    batchSubmission: job.batchSubmission,
    submissionStartedAt: job.submissionStartedAt ?? "",
  };
  if (job.runpodId) return { ...base, runpodId: job.runpodId };
  // Searching without a provider ID: the paid POST outcome is unknown, as on the single-GPU
  // path, even for older records that saved no request identity. Keep it as an ID-less slot
  // so the unknown-outcome pause applies; reconcile then refuses it for lack of an identity.
  const unknown =
    job.status === "searching" ||
    (job.status === "paused" && Boolean(job.error?.includes("Submission outcome unknown")));
  return unknown ? base : undefined;
}

/** In-flight paid submissions, whichever way the job stores them. */
export function searchSlots(job: Job): SearchSlot[] {
  if (job.parallelSlots) return job.parallelSlots;
  const slot = legacySlot(job);
  return slot ? [slot] : [];
}

/** Move a single-submission job's in-flight submission into `parallelSlots`. */
function adoptSlots(job: Job): SearchSlot[] {
  if (!job.parallelSlots) {
    job.parallelSlots = searchSlots(job);
    delete job.runpodId;
    delete job.batchSubmission;
    delete job.submissionStartedAt;
  }
  return job.parallelSlots;
}

function remove(slots: SearchSlot[], slot: SearchSlot) {
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
}

/**
 * One coordinator tick for a withdrawal that may use several GPUs at once. Each chunk is
 * its own paid submission: its intent (slot) and GPU-time reservation are saved before
 * its POST, a slot without a provider ID is an unknown outcome for an operator to
 * reconcile, and nothing is ever resubmitted automatically. Stage order and CPU checks
 * are the single-GPU path's; only chunks of one stage run side by side.
 */
/** Start no new paid POST after this long in one tick, so a slow tick can't time out
 * mid-submission (the coordinator Lambda allows 90 seconds). The next tick fills the rest. */
export const FILL_DEADLINE_MS = 20_000;

export async function parallelTick(event: Event, row: Row, store: Store, cpu: Cpu) {
  const tickStarted = Date.now();
  const job = row.job as Job;
  const pk = `OWNER#${event.owner}`;
  let version = row.version;
  // The job as last saved: metering saves from it (see `meter` below).
  let saved = structuredClone(job);
  const persist = async () => {
    await store.put({ ...row, version: version + 1, job }, version);
    version += 1;
    saved = structuredClone(job);
  };
  const next = (done: boolean, waitSeconds = 5) => ({
    ...event,
    done,
    ...(done ? {} : { waitSeconds }),
    polls: (event.polls || 0) + 1,
  });

  if (job.runpodId && job.computeProvider !== "aws-batch") {
    job.status = "paused";
    job.error = "Legacy provider job requires reconciliation before AWS migration.";
    await persist();
    return { ...event, done: true };
  }
  const adopted = !job.parallelSlots;
  const slots = adoptSlots(job);
  if (adopted) await persist();
  const terminal = TERMINAL.includes(job.status);
  if (terminal && slots.length === 0) return { ...event, done: true };

  const unknown = () => slots.some((s) => !s.runpodId);
  if (
    !terminal &&
    (!transactionsEnabled || !ownerAllowed(event.owner))
  ) {
    // As on the single-GPU path: running chunks are not cancelled; resume polls them.
    if (job.status === "searching" && unknown()) {
      if (!job.error?.includes("Submission outcome unknown"))
        job.error = `${UNKNOWN_SUBMISSION}${job.error ? ` ${job.error}` : ""}`;
      delete job.oneSubmissionAllowed;
    }
    job.status = "paused";
    const disabledReason = !transactionsEnabled
      ? "Mainnet disabled by deployment."
      : "Wallet is not allowed by deployment configuration.";
    if (!job.error?.includes(disabledReason))
      job.error = `${disabledReason}${job.error ? ` ${job.error}` : ""}`;
    await persist();
    return { ...event, done: true };
  }
  if (!computeConfigured() || !process.env.REFERENCE_FUNCTION) {
    if (terminal) return { ...event, done: true };
    if (job.status === "searching" && unknown()) {
      if (!job.error?.includes("Submission outcome unknown"))
        job.error = `${UNKNOWN_SUBMISSION}${job.error ? ` ${job.error}` : ""}`;
      delete job.oneSubmissionAllowed;
    }
    job.status = "paused";
    const reason = "Compute and verification configuration required.";
    if (!job.error?.includes(reason))
      job.error = `${reason}${job.error ? ` ${job.error}` : ""}`;
    await persist();
    return { ...event, done: true };
  }
  // A resumed job may already own paid submissions: persist polling state first.
  if (job.status === "queued" && slots.some((s) => s.runpodId)) {
    job.status = "searching";
    await persist();
  }
  const provider = await configuredCompute();
  // A chunk newly seen finished is metered on the job and on its last-saved copy, and that copy
  // is saved at once. So a failure later in the tick (a status call, a rejected or unreadable
  // output, a timeout) can't lose its GPU time, and none of the tick's unfinished changes, such
  // as a dropped slot whose range isn't recorded as done yet, are saved with it.
  const meter = async (slot: SearchSlot, r: ComputeStatus) => {
    if (!meterChunk(job, slot, r)) return;
    const copy = saved.parallelSlots?.find((s) => s.runpodId === slot.runpodId);
    if (!copy || !meterChunk(saved, copy, r)) return;
    await store.put({ ...row, version: version + 1, job: saved }, version);
    version += 1;
  };
  // One chunk's status, metered before the caller acts on it.
  const observe = async (slot: SearchSlot) => {
    try {
      const r = await provider.status(slot.runpodId!, slot.batchSubmission);
      await meter(slot, r);
      return r;
    } catch (error) {
      // Finished, but its output can't be read or checked: it still used the GPU. The original
      // error is what the operator needs; a failed save is metered on the next poll.
      if (error instanceof UnreadableOutput) await meter(slot, error.finished).catch(() => {});
      throw error;
    }
  };

  // Paused: stop running chunks and keep every provider ID for resume. Finished: stop
  // and drop leftover chunks (a later stage no longer needs them).
  if (job.status === "paused" || terminal) {
    let running = false,
      changed = false;
    for (const slot of [...slots]) {
      if (!slot.runpodId) continue;
      const r = await observe(slot);
      if (ACTIVE.includes(r.status)) {
        // A cancellation acknowledgement is not terminal: keep polling the ID.
        await provider.cancel(slot.runpodId);
        running = true;
      } else if (terminal) {
        remove(slots, slot);
        changed = true;
      }
    }
    if (changed) await persist();
    return running ? next(false) : { ...event, done: true };
  }

  const vaultRow = await store.get(pk, `VAULT#${job.vaultId}`);
  if (!vaultRow) throw new Error("VaultNotFound");
  const vault = vaultRow.vault as PublicVault;
  if (vault.network !== NETWORK_ID) throw new Error("VaultNetworkMismatch");
  await chain.assertNetwork();
  if (vault.configuration && !job.solver) throw new Error("SolverPinRequired");
  const selected = job.solver
    ? assertSolverPin(job.solver, vault)
    : solverRelease("qsb-config-a-ranked-v2-2791ed0");
  if (
    selected.searchVersion !== searchVersion ||
    selected.generatorCommit !== release.qsbCommit
  )
    throw new Error("SolverRuntimeMismatch");
  // A slot saved before a POST that never recorded its ID: never replay it.
  if (job.status === "searching" && unknown()) {
    job.status = "paused";
    job.error = UNKNOWN_SUBMISSION;
    delete job.oneSubmissionAllowed;
    await persist();
    return { ...event, done: true };
  }
  const referenceInput = () => ({
    publicStateJson: vault.publicStateJson,
    manifest: job.manifest,
    stage: job.stage,
    ...(job.solution
      ? { sequence: job.solution.sequence, locktime: job.solution.locktime }
      : {}),
  });

  // An explicit resume allows each chunk it found in flight to be repeated once if it turns
  // out to have stopped, however many ticks that takes. Chunks sent later never inherit it.
  if (job.retryRequested) {
    for (const s of slots) s.retryOnStop = true;
    delete job.retryRequested;
  }
  // Poll every chunk. Results are credited only after the same checks as one GPU.
  let stop: { stage: string; error: string } | undefined;
  // A failed CPU check needs operator review: it outranks any other pause reason.
  let review: { stage: string; error: string } | undefined;
  const completed = new Set(job.completedAttempts ?? []);
  for (const slot of [...slots]) {
    const r = await observe(slot);
    const current = slot.stage === job.stage && job.status !== "failed";
    if (!current) {
      // Superseded by a verified hit or a failed job: stop it, never credit it.
      if (ACTIVE.includes(r.status)) await provider.cancel(slot.runpodId!);
      else remove(slots, slot);
      continue;
    }
    if (STOPPED.includes(r.status)) {
      remove(slots, slot);
      if (!slot.retryOnStop)
        stop ??= {
          stage: slot.stage,
          error: "Compute interrupted. Resume will repeat this bounded range without skipping it.",
        };
      continue;
    }
    if (r.status !== "COMPLETED") continue;
    const output = candidateOutput.parse(r.output);
    const expectedRange = workRange(slot.stage, slot.attempt);
    if (
      output.kernelCommit !== selected.kernelCommit ||
      output.manifestHash !== job.manifestHash ||
      output.stage !== slot.stage ||
      output.attempt !== slot.attempt
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
    job.computeSeconds += (r.executionTime || 0) / 1000;
    remove(slots, slot);
    // The historical worker truncates at 64 and still reports range-complete.
    if (publishedHitRecords(output.candidates) >= HOST_HIT_CAPACITY) {
      job.status = "failed";
      job.error = "GPU hit output exceeds supported capacity.";
      continue;
    }
    const checked = await cpu({
      ...referenceInput(),
      action: "verify",
      candidates: output.candidates,
    });
    if (checked.valid === true) {
      applyVerifiedHit(job, checked, expectedRange);
      job.attempt = 0;
      completed.clear();
      job.status =
        job.stage === "verification" ? "awaiting_authorization" : "queued";
    } else if (output.candidates.length && checked.derOnly !== true) {
      // Keep the chunk and its provider ID for the operator review this blocks resume on.
      slots.push(slot);
      review ??= { stage: slot.stage, error: "GPU candidates failed independent CPU verification." };
    } else if (
      output.status === "completed" &&
      output.checkpoint === "range-complete"
    ) {
      // Chunks finish out of order: `attempt` only moves past contiguous completed ones.
      completed.add(slot.attempt);
      while (completed.has(job.attempt)) {
        completed.delete(job.attempt);
        job.attempt++;
      }
    } else if (!slot.retryOnStop) {
      stop ??= {
        stage: slot.stage,
        error: "Incomplete work unit. Resume repeats this bounded range; it has not been skipped.",
      };
    }
  }
  job.completedAttempts = [...completed].sort((a, b) => a - b);
  // A reason in a stage that a verified hit has already finished no longer matters.
  const reason = [review, stop].find((r) => r?.stage === job.stage);
  if (reason && ["queued", "searching"].includes(job.status)) {
    job.status = "paused";
    job.error = reason.error;
  }

  // Fill free GPUs with the lowest chunks not yet done or running. Superseded chunks
  // still occupy a GPU until they stop, so they count against workersMax.
  if (["queued", "searching"].includes(job.status)) {
    const assigned = new Set(
      slots.filter((s) => s.stage === job.stage).map((s) => s.attempt),
    );
    let attempt = job.attempt;
    let parameters: { parameterBase64: string; parameterSha256: string } | undefined;
    let sent = 0;
    const ownerBudget = await OwnerGpuBudget.open(store, event.owner);
    while (slots.length < gpuSpendLimits.workersMax) {
      if (Date.now() - tickStarted > FILL_DEADLINE_MS) break;
      while (assigned.has(attempt) || completed.has(attempt)) attempt++;
      try {
        workRange(job.stage, attempt);
      } catch {
        if (assigned.size === 0) {
          job.status = "paused";
          job.error = "Search range exhausted; a reviewed new range is required.";
        }
        break;
      }
      let reservedSeconds: number;
      try {
        reservedSeconds = nextGpuReservation(job, gpuSpendLimits.executionTimeoutMs);
        if (reservedSeconds > gpuSpendLimits.maxJobGpuSeconds)
          throw new Error(
            "GPU-time budget reached. Further GPU work needs a reviewed budget change.",
          );
        // An owner budget only adds a refusal; the per-job cap above still applies.
        ownerBudget?.check(job, reservedSeconds);
      } catch (error) {
        // Let running chunks finish; pause once nothing else is in flight.
        if (slots.length === 0) {
          job.status = "paused";
          job.error = error instanceof Error ? error.message : "GPU-time accounting invalid.";
        }
        break;
      }
      if (!parameters) {
        parameters = z
          .object({
            parameterBase64: z.string().max(140000),
            parameterSha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(await cpu({ ...referenceInput(), action: "export" }));
        const key = `${job.stage}:${job.solution?.sequence ?? ""}:${job.solution?.locktime ?? ""}`;
        if (
          job.parameterHashes?.[key] &&
          job.parameterHashes[key] !== parameters.parameterSha256
        )
          throw new Error("SolverParametersChanged");
        job.parameterHashes = { ...job.parameterHashes, [key]: parameters.parameterSha256 };
      }
      let submit: import("./aws-batch").PreparedRun;
      try {
        deployedSolver(selected.id);
        assertPaidSolverContract(selected);
        submit = await provider.prepareRun(selected.image, {
          protocol: selected.protocol,
          kernelCommit: selected.kernelCommit,
          manifestHash: job.manifestHash,
          stage: job.stage,
          attempt,
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
        break;
      }
      // Preparation can be slow: once this tick has sent a chunk, re-check the deadline
      // before committing to another paid POST (nothing is reserved or sent yet; the
      // uploaded public input is simply unused). The first chunk always goes ahead, as on
      // the single-GPU path, so a slow preparation can't stall the search.
      if (sent > 0 && Date.now() - tickStarted > FILL_DEADLINE_MS) break;
      // This slot, its reservation and the never-resubmit marker share one conditional
      // write before the paid POST, with the owner's GPU budget when one is set. No
      // result refunds time, including a lost response.
      const slot: SearchSlot = {
        stage: job.stage as SearchSlot["stage"],
        attempt,
        batchSubmission: submit.identity,
        submissionStartedAt: new Date().toISOString(),
      };
      const reserved = await saveGpuReservation(
        store,
        row,
        version,
        job,
        reservedSeconds,
        ownerBudget,
        (next) => {
          next.gpuBudgetReservedSeconds = reservedSeconds;
          next.gpuSubmissions = (next.gpuSubmissions ?? 0) + 1;
          next.status = "searching";
          next.computeProvider = "aws-batch";
          next.parallelSlots!.push(slot);
          delete next.batchReplacementFor;
          delete next.oneSubmissionAllowed;
        },
      );
      if (!reserved) {
        // Another withdrawal of this owner used the budget after the check: as above.
        if (slots.length === 0) {
          job.status = "paused";
          job.error = OWNER_GPU_BUDGET_REACHED;
        }
        break;
      }
      version += 1;
      saved = structuredClone(job);
      assigned.add(attempt);
      const result = await submit();
      slot.runpodId = result.id;
      await persist();
      sent++;
    }
  }
  job.updatedAt = new Date().toISOString();
  await persist();
  const draining = slots.length > 0;
  const done =
    job.status === "paused" ||
    (["failed", "awaiting_authorization"].includes(job.status) && !draining);
  return done
    ? { ...event, done: true, polls: (event.polls || 0) + 1 }
    : next(false, job.status === "queued" && !draining ? 0 : 5);
}
