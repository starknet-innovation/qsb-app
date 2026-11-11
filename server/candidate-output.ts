import { rankSubset } from "../src/pqb-core/grind";
import { pinNonceOf } from "../src/pqb-core/spend";
import { z } from "zod";
import type { Job } from "../src/lib/model";
import { searchVersion, subsetRank, workRange } from "./search-ranges";

/** A GPU worker's result for one bounded work unit. */
export const candidateOutput = z.object({
  status: z.enum(["completed", "interrupted", "failed", "exhausted"]),
  stage: z.string(),
  manifestHash: z.string(),
  attempt: z.number().int(),
  candidates: z.array(z.string().max(16384)).max(32),
  kernelCommit: z.string().regex(/^[a-f0-9]{40}$/),
  checkpoint: z.enum(["range-complete", "requires-verification-or-resume"]),
  workRange: z
    .object({
      version: z.enum([searchVersion, "pqb-ranked-v2"]),
      start: z.string().regex(/^\d+$/),
      count: z.number().int().positive(),
      sequence: z.number().int().optional(),
      sequenceCount: z.number().int().optional(),
      locktime: z.number().int().optional(),
      locktimeCount: z.number().int().optional(),
      prefixStart: z.string().regex(/^\d+$/).optional(),
      prefixCount: z.number().int().positive().optional(),
    })
    .strict(),
});

/** Record a CPU-verified hit from the unit `expectedRange` and advance to the next stage. */
export function applyVerifiedHit(
  job: Job,
  checked: Record<string, unknown>,
  expectedRange: ReturnType<typeof workRange>,
  attempt = job.attempt,
) {
  if (job.solver?.descriptor.protocol === "pqb-v1") {
    applyPqbHit(job, checked, expectedRange, attempt);
    return;
  }
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
    return;
  }
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

function applyPqbHit(job: Job, checked: Record<string, unknown>, range: ReturnType<typeof workRange>, attempt: number) {
  const candidate = z.string().max(200).parse(checked.candidate);
  if (job.stage === "pinning") {
    const sequence = z.number().int().parse(checked.sequence), locktime = z.number().int().parse(checked.locktime);
    const nonce = pinNonceOf(locktime, sequence);
    if (nonce === null || nonce < BigInt(range.start) || nonce >= BigInt(range.start) + BigInt(range.count))
      throw new Error("CandidateOutsideAssignedRange");
    job.solution = { sequence, locktime, round1: [], round2: [], pqb: { pinning: candidate } };
    job.stage = "round1";
    job.pqbNextPinAttempt = attempt + 1;
    return;
  }
  const indices = z.array(z.number().int().min(0).max(108)).parse(checked.indices);
  const expected = job.stage === "round1" ? 8 : 9;
  if (!job.solution?.pqb || indices.length !== expected || new Set(indices).size !== expected)
    throw new Error("InvalidReferenceResult");
  const used = job.stage === "round2" ? job.solution.round1 : [];
  const live = Array.from({ length: 109 }, (_, j) => j).filter(j => !used.includes(j));
  const positions = indices.map(i => live.indexOf(i));
  if (positions.some(i => i < 0)) throw new Error("InvalidReferenceResult");
  const rank = rankSubset(positions, live.length);
  if (rank < BigInt(range.start) || rank >= BigInt(range.start) + BigInt(range.count))
    throw new Error("CandidateOutsideAssignedRange");
  if (job.stage === "round1") {
    job.solution.round1 = indices;
    job.solution.pqb.round0 = candidate;
    job.stage = "round2";
  } else if (job.stage === "round2") {
    job.solution.round2 = indices;
    job.solution.pqb.round1 = candidate;
    job.stage = "verification";
  } else throw new Error("UnexpectedStage");
}
