import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { z } from "zod";
import { assertNoCredentialMaterial } from "./credential-material";

/**
 * Transaction ids and inclusion evidence for the submit and status routes. Nothing here
 * broadcasts or contacts a chain provider or miner. A transport result is not inclusion.
 */

export class MinerInclusionError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "MinerInclusionError";
  }
}

const hash64 = z.string().regex(/^[a-f0-9]{64}$/i);

function lower(value: string): string {
  return value.toLowerCase();
}

function readTransaction(rawTxHex: string): btc.Transaction {
  if (!/^(?:[a-f0-9]{2})+$/i.test(rawTxHex) || rawTxHex.length > 150000)
    throw new MinerInclusionError("ExactSpendMismatch");
  try {
    return btc.Transaction.fromRaw(hex.decode(rawTxHex), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
  } catch {
    throw new MinerInclusionError("ExactSpendMismatch");
  }
}

export function transactionId(rawTxHex: string): string {
  return readTransaction(rawTxHex).id;
}

const inclusionSchema = z
  .object({
    httpStatus: z.number().int().optional(),
    preflightAllowed: z.boolean().optional(),
    mempoolAccepted: z.boolean().optional(),
    minerReportedConfirmed: z.boolean().optional(),
    section7Closed: z.boolean().optional(),
    chain: z
      .object({
        confirmed: z.boolean(),
        confirmations: z.number().int().nonnegative().optional(),
        blockHash: z.string().optional(),
        blockHeight: z.number().int().nonnegative().optional(),
        txid: z.string().optional(),
      })
      .strict()
      .optional(),
    expectedTxid: hash64,
  })
  .strict();

export type InclusionJudgment = {
  format: "qsb-inclusion-judgment-v1";
  structurallyComplete: boolean;
  independentlyConfirmed: false;
  preflightIsInclusion: false;
  httpSuccessIsInclusion: false;
  section7Closed: false;
  observedByThisCheckout: false;
  overclaim: boolean;
  reason: string;
  limits: readonly string[];
};

const INCLUSION_LIMITS = [
  "This helper does not contact a chain provider or miner.",
  "A caller-supplied block record is structural completeness, not independent confirmation.",
  "HTTP success, a mempool preflight, and a miner-reported confirmation are not inclusion.",
  "A matching block hash, height, and transaction id do not close section 7 in this checkout.",
] as const;

export function judgeInclusionEvidence(input: unknown): InclusionJudgment {
  assertNoCredentialMaterial(input);
  const parsed = inclusionSchema.safeParse(input);
  if (!parsed.success) throw new MinerInclusionError("InclusionEvidenceRejected");
  const evidence = parsed.data;
  const overclaim = evidence.section7Closed === true;
  const chain = evidence.chain;
  const blockHash = chain?.blockHash?.toLowerCase();
  const txid = chain?.txid?.toLowerCase();
  const blockOk = Boolean(
    chain?.confirmed === true &&
      (chain.confirmations ?? 0) >= 1 &&
      blockHash &&
      /^[a-f0-9]{64}$/.test(blockHash) &&
      chain.blockHeight !== undefined &&
      txid === lower(evidence.expectedTxid),
  );
  let reason: string;
  if (overclaim)
    reason =
      "A report cannot close section 7. This checkout did not observe the chain.";
  else if (blockOk)
    reason =
      "The supplied record is structurally complete. This helper did not query a chain provider, so it is not independent confirmation, and it does not close section 7.";
  else if (
    evidence.preflightAllowed === true ||
    evidence.mempoolAccepted === true
  )
    reason = "A mempool preflight is not inclusion.";
  else if (evidence.minerReportedConfirmed === true)
    reason = "A miner-reported confirmation is not independent block inclusion.";
  else if (evidence.httpStatus === 200)
    reason = "HTTP success is not inclusion.";
  else
    reason =
      "Independent inclusion requires a confirmed block hash, block height, and the same transaction id.";
  return {
    format: "qsb-inclusion-judgment-v1",
    structurallyComplete: blockOk,
    independentlyConfirmed: false,
    preflightIsInclusion: false,
    httpSuccessIsInclusion: false,
    section7Closed: false,
    observedByThisCheckout: false,
    overclaim,
    reason,
    limits: INCLUSION_LIMITS,
  };
}

const ESPLORA_OBSERVED_LIMITS = [
  "This status route queried Esplora for this transaction id.",
  "HTTP success, a mempool preflight, and a miner-reported confirmation are not inclusion.",
  "An Esplora status does not close section 7 in this checkout.",
] as const;

export type EsploraInclusionReport = {
  format: "qsb-inclusion-judgment-v1";
  structurallyComplete: boolean;
  independentlyConfirmed: boolean;
  preflightIsInclusion: false;
  httpSuccessIsInclusion: false;
  section7Closed: false;
  observedByThisCheckout: boolean;
  overclaim: boolean;
  reason: string;
  limits: readonly string[];
};

/** The status route's judgment. Confirmation text is used only after its Esplora query. */
export function reportEsploraInclusion(
  judgment: InclusionJudgment,
  queriedThisRoute: boolean,
): EsploraInclusionReport {
  const observed =
    queriedThisRoute && judgment.structurallyComplete && !judgment.overclaim;
  if (!observed) {
    return {
      ...judgment,
      independentlyConfirmed: false,
      observedByThisCheckout: false,
    };
  }
  return {
    format: "qsb-inclusion-judgment-v1",
    structurallyComplete: true,
    independentlyConfirmed: true,
    preflightIsInclusion: false,
    httpSuccessIsInclusion: false,
    section7Closed: false,
    observedByThisCheckout: true,
    overclaim: false,
    reason:
      "This status route queried Esplora and received a confirmed block hash, block height, and the same transaction id. That observation does not close section 7.",
    limits: ESPLORA_OBSERVED_LIMITS,
  };
}
