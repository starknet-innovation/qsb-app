import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { z } from "zod";
import { withdrawalSchema, type Job } from "../lib/model";
import { NETWORK_ID } from "../lib/network";

const subset = z
  .array(z.number().int().min(0).max(149))
  .length(9)
  .refine((values) => new Set(values).size === 9, "Duplicate subset index");

/** Public coordinator output only. Recovery state, passphrases and keys are not fields. */
export const coordinatorSolvedResultSchema = z
  .object({
    format: z.literal("qsb-coordinator-public-solved-result-v1"),
    network: z.literal("mainnet"),
    jobId: z.string().uuid(),
    vaultId: z.string().uuid(),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    manifest: withdrawalSchema,
    solution: z
      .object({
        sequence: z.number().int().min(0).max(0xffffffff),
        locktime: z.number().int().min(0).max(0xffffffff),
        round1: subset,
        round2: subset,
      })
      .strict(),
    mainnetEnabled: z.literal(false),
    broadcastAuthorized: z.literal(false),
  })
  .strict();

export type CoordinatorSolvedResult = z.infer<
  typeof coordinatorSolvedResultSchema
>;

export const coordinatorSignedResultSchema = z
  .object({
    format: z.literal("qsb-coordinator-public-signed-result-v1"),
    network: z.literal("mainnet"),
    jobId: z.string().uuid(),
    vaultId: z.string().uuid(),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    rawTxHex: z.string().regex(/^(?:[a-f0-9]{2})+$/),
    txid: z.string().regex(/^[a-f0-9]{64}$/),
    helperSighash: z.literal("SIGHASH_ALL"),
    helperSignatureVerified: z.literal(true),
    qsbConsensusProven: z.literal(false),
    chainInclusionProven: z.literal(false),
    mainnetEnabled: z.literal(false),
    broadcastAuthorized: z.literal(false),
  })
  .strict();

export type CoordinatorSignedResult = z.infer<
  typeof coordinatorSignedResultSchema
>;

const digest = (value: string) =>
  hex.encode(sha256(new TextEncoder().encode(value)));

/**
 * Project the job record the Step Functions coordinator writes at
 * awaiting_authorization. The projection drops operational fields.
 */
export function coordinatorPublicSolvedResult(
  job: Job,
): CoordinatorSolvedResult {
  if (NETWORK_ID !== "mainnet")
    throw new Error("Solved results are delivered on Bitcoin mainnet.");
  if (job.status !== "awaiting_authorization" || job.stage !== "verification")
    throw new Error("Coordinator has not published a solved result.");
  if (!job.solution) throw new Error("Coordinator solved result is incomplete.");
  const manifestHash = digest(JSON.stringify(job.manifest));
  if (
    manifestHash !== job.manifestHash ||
    job.id !== job.manifest.idempotencyKey ||
    job.vaultId !== job.manifest.vaultId
  )
    throw new Error("Coordinator manifest binding differs.");
  return coordinatorSolvedResultSchema.parse({
    format: "qsb-coordinator-public-solved-result-v1",
    network: "mainnet",
    jobId: job.id,
    vaultId: job.vaultId,
    manifestHash,
    manifest: job.manifest,
    solution: {
      sequence: job.solution.sequence,
      locktime: job.solution.locktime,
      round1: job.solution.round1,
      round2: job.solution.round2,
    },
    mainnetEnabled: false,
    broadcastAuthorized: false,
  });
}
