import { z } from "zod";
import raw from "./gpu-spend.json";

/**
 * Coordinator GPU spend limits from server/gpu-spend.json.
 * workersMax, workersMin, and executionTimeoutMs are applied to the Runpod
 * endpoint before a paid submission. maxJobAttempts bounds both the attempt
 * index and the number of submissions for one job. One attempt cannot run
 * longer than executionTimeoutMs, so 40 attempts are at most 10 hours on the
 * single allowed worker. This module does not evaluate the experimental GPU
 * USD ceiling and does not set release.mainnetEnabled or broadcastAuthorized.
 */
const schema = z
  .object({
    workersMax: z.literal(1),
    workersMin: z.literal(0),
    executionTimeoutMs: z.literal(900000),
    maxJobAttempts: z.literal(40),
  })
  .strict();

export const gpuSpendLimits = schema.parse(raw);
