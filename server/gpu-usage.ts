import type { Job, JobUsage, SearchSlot } from "../src/lib/model";
import type { ComputeStatus } from "./aws-batch";

const FINISHED: ComputeStatus["status"][] = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];

/**
 * Add a finished chunk's AWS Batch time to the job's `usage`, once: the slot is marked, so a
 * chunk kept for operator review, or observed again by a later tick, isn't counted twice.
 * Returns whether it changed the job. Measurement only: it never decides what is submitted,
 * credited or cancelled, so a chunk without usable times is counted as unmeasured, not refused.
 *
 * The two intervals are taken independently. Run time is `startedAt` to `stoppedAt`; a failed or
 * cancelled chunk with no start time never started and ran for none, while a completed one did
 * run, so its run time is unknown. Queue time is `createdAt` to `startedAt`, or to `stoppedAt` for
 * a chunk that never started. A chunk is unmeasured when either interval it has is missing or
 * out of order; whatever it does have still counts.
 */
export function meterChunk(job: Job, slot: SearchSlot, result: ComputeStatus): boolean {
  if (slot.metered || !FINISHED.includes(result.status)) return false;
  const usage: JobUsage = (job.usage ??= { chunks: 0, failed: 0, runMs: 0, queueMs: 0, unmeasured: 0 });
  usage.chunks += 1;
  if (result.status !== "COMPLETED") usage.failed += 1;
  const { createdAt, startedAt, stoppedAt } = result.timing ?? {};
  const span = (from?: number, to?: number) =>
    from !== undefined && to !== undefined && to >= from ? to - from : undefined;
  const ran = startedAt !== undefined || result.status === "COMPLETED";
  const run = ran ? span(startedAt, stoppedAt) : 0;
  const queue = span(createdAt, ran ? startedAt : stoppedAt);
  if (run !== undefined) usage.runMs += run;
  if (queue !== undefined) usage.queueMs += queue;
  if (run === undefined || queue === undefined) usage.unmeasured += 1;
  slot.metered = true;
  return true;
}
