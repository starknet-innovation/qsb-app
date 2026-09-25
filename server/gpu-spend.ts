import { z } from "zod";
import raw from "./gpu-spend.json";

/** Bundled single source of truth. The lifetime count includes retries and all
 * stages; range indices are bounded separately by workRange. This is a finite
 * execution allowance, not an invoice cap or a probability-of-success promise.
 */
export const gpuSpendSchema = z
  .object({
    workersMax: z.literal(1),
    workersMin: z.literal(0),
    executionTimeoutMs: z.number().int().positive().max(900000),
    maxJobAttempts: z.number().int().positive().max(1_000_000),
  })
  .strict();

export const gpuSpendLimits = gpuSpendSchema.parse(raw);
