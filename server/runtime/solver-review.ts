import { z } from "zod";
import type { HoldSolverBinding } from "./coverage-ledger";
import holdSolverReceiptJson from "../../docs/source-build/20260924/solver-build-receipt.json";

// Historical coverage metadata only. CUDA review/build tooling moved to qsb-solver.
const holdReceiptSchema = z
  .object({
    binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceLockSha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.literal("HOLD"),
    historicalBinaryAttestation: z.literal(false),
    flags: z.array(z.string()).min(1),
  })
  .passthrough();

/** The inlined HOLD solver receipt. This checkout does not enroll or execute it. */
export function readHoldSolverBinding(): HoldSolverBinding {
  const receipt = holdReceiptSchema.parse(holdSolverReceiptJson);
  if (
    !receipt.flags.includes("-DZLAB_TRIM=0") ||
    !receipt.flags.includes("-DQSB_PAIR_SHARED=0")
  )
    throw new Error("HOLD solver receipt is not the ranked generic build");
  return {
    binarySha256: receipt.binarySha256,
    status: "HOLD",
    enrolled: false,
    historicalBinaryAttestation: false,
  };
}
