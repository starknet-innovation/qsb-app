/** Partial canceled work is retained but contributes no completed work or hits. */
type NativeJob = { status: string; statusReason?: string; stoppedAt?: number };
const cancellation = "QSB operator/coordinator cancellation";

export function completedNativeReceipt(job: NativeJob, status: string): boolean {
  if (status === "completed") return true;
  if (job.status === "FAILED" && job.statusReason === cancellation) return false;
  throw Error("Unexpected incomplete native result");
}

export function supersededCancellation(job: NativeJob, winningCompletions: number[]): void {
  if (job.status !== "FAILED" || job.statusReason !== cancellation
    || !Number.isSafeInteger(job.stoppedAt) || job.stoppedAt! <= 0
    || !winningCompletions.some(t => Number.isSafeInteger(t) && t > 0 && t <= job.stoppedAt!))
    throw Error("Cancellation lacks an earlier CPU-validated winning unit for the same packet");
}
