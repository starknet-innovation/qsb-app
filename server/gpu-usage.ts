import type { Job, JobUsage, SearchSlot } from "../src/lib/model";
import type { ComputeStatus } from "./aws-batch";

const FINISHED: ComputeStatus["status"][] = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"];

/**
 * Add a finished chunk's AWS Batch time to the job's `usage`, once: the slot is marked, so a
 * chunk kept for operator review, or observed again by a later tick, isn't counted twice.
 * Returns whether it changed the job. Measurement only: it never decides what is submitted,
 * credited or cancelled, so a chunk without usable times is counted as unmeasured, not refused.
 */
export function meterChunk(job: Job, slot: SearchSlot, result: ComputeStatus): boolean {
  if (slot.metered || !FINISHED.includes(result.status)) return false;
  const usage: JobUsage = (job.usage ??= { chunks: 0, failed: 0, runMs: 0, queueMs: 0, unmeasured: 0 });
  usage.chunks += 1;
  if (result.status !== "COMPLETED") usage.failed += 1;
  const { createdAt, startedAt, stoppedAt } = result.timing ?? {};
  if (startedAt !== undefined && stoppedAt !== undefined && stoppedAt >= startedAt) {
    usage.runMs += stoppedAt - startedAt;
    if (createdAt !== undefined && startedAt >= createdAt) usage.queueMs += startedAt - createdAt;
  } else usage.unmeasured += 1;
  slot.metered = true;
  return true;
}
