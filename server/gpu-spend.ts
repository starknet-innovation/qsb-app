import { z } from "zod";
import raw from "./gpu-spend.json";

/** Single bundled per-job execution-time allowance, reviewed before deployment. */
export const gpuSpendSchema = z
  .object({
    workersMax: z.literal(1),
    workersMin: z.literal(0),
    executionTimeoutMs: z.number().int().positive().max(900000),
    maxJobGpuSeconds: z.number().int().positive().max(31_536_000),
  })
  .strict();

export const gpuSpendLimits = gpuSpendSchema.parse(raw);

/** Retain worst-case reservations permanently: failure, short execution, retries
 * and stage changes never refund them. computeSeconds is telemetry, not a ledger.
 * Legacy counted submissions used a 900-second timeout; never undercharge them.
 */
export function nextGpuReservation(
  job: {
    gpuBudgetReservedSeconds?: number;
    gpuSubmissions?: number;
    computeSeconds: number;
  },
  executionTimeoutMs: number,
): number {
  const nonnegative = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (!Number.isFinite(job.computeSeconds) || job.computeSeconds < 0)
    throw new Error("GPU-time accounting invalid; reconcile before resuming.");
  let reserved = job.gpuBudgetReservedSeconds;
  if (reserved === undefined) {
    if (job.gpuSubmissions !== undefined && nonnegative(job.gpuSubmissions)) {
      reserved = job.gpuSubmissions * 900;
    } else
      throw new Error(
        "GPU-time accounting unavailable; reconcile before resuming.",
      );
  }
  if (
    !nonnegative(reserved) ||
    (job.gpuSubmissions !== undefined && !nonnegative(job.gpuSubmissions))
  )
    throw new Error("GPU-time accounting invalid; reconcile before resuming.");
  const next =
    Math.max(reserved, Math.ceil(job.computeSeconds)) +
    Math.ceil(executionTimeoutMs / 1000);
  if (!nonnegative(next))
    throw new Error("GPU-time accounting overflow; reconcile before resuming.");
  return next;
}
