import { hex } from "@scure/base";
import { withdrawalSchema, type Job } from "../src/lib/model";
import { outputScript } from "../src/lib/transactions";
import { MinerInclusionError } from "./runtime/miner-inclusion";
import { assertWithdrawalSpendAgainstJob } from "./transaction-checks";

const MIN_SEQUENCE = 0x80000000;
const MIN_LOCKTIME = 500000000;
const MAX_LOCKTIME = 1744599999;

/** Fields the public CPU handler balances, plus the verified solution's sequence and locktime. */
export type StoredSpendRecord = {
  helper: { txid: string; vout: number; valueSats: string };
  funding: { txid: string; vout: number; valueSats: string };
  outputScript: string;
  outputValue: string;
  fee: string;
  sequence: number;
  locktime: number;
};

function mismatch(): never {
  throw new MinerInclusionError("ExactSpendMismatch");
}

function verifiedIndices(values: number[]): boolean {
  return (
    values.length === 9 &&
    new Set(values).size === 9 &&
    values.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 149,
    )
  );
}

/**
 * Build the withdrawal spend from the stored job. Amounts and the destination
 * script come from the manifest. Sequence and locktime come from the solution
 * the coordinator stored after CPU verification. Nothing is taken from the request.
 */
export function buildStoredSpendRecord(job: Job): StoredSpendRecord {
  const parsed = withdrawalSchema.safeParse(job.manifest);
  if (!parsed.success) mismatch();
  const manifest = parsed.data;
  const solution = job.solution;
  if (
    !solution ||
    !Number.isSafeInteger(solution.sequence) ||
    solution.sequence < MIN_SEQUENCE ||
    solution.sequence > 0xffffffff ||
    !Number.isSafeInteger(solution.locktime) ||
    solution.locktime < MIN_LOCKTIME ||
    solution.locktime > MAX_LOCKTIME ||
    !verifiedIndices(solution.round1) ||
    !verifiedIndices(solution.round2)
  )
    mismatch();
  let destinationScript: string;
  try {
    destinationScript = hex
      .encode(outputScript(manifest.destination))
      .toLowerCase();
  } catch {
    mismatch();
  }
  const outputScriptHex = manifest.outputScript.toLowerCase();
  if (destinationScript !== outputScriptHex) mismatch();
  const helperValue = BigInt(manifest.helper.value);
  const fundingValue = BigInt(manifest.funding.value);
  const outputValue = BigInt(manifest.outputValue);
  const fee = BigInt(manifest.fee);
  if (
    helperValue <= 0n ||
    fundingValue <= 0n ||
    outputValue <= 0n ||
    fee <= 0n ||
    helperValue + fundingValue !== outputValue + fee
  )
    mismatch();
  if (
    manifest.helper.txid.toLowerCase() ===
      manifest.funding.txid.toLowerCase() &&
    manifest.helper.vout === manifest.funding.vout
  )
    mismatch();
  return {
    helper: {
      txid: manifest.helper.txid.toLowerCase(),
      vout: manifest.helper.vout,
      valueSats: manifest.helper.value,
    },
    funding: {
      txid: manifest.funding.txid.toLowerCase(),
      vout: manifest.funding.vout,
      valueSats: manifest.funding.value,
    },
    outputScript: outputScriptHex,
    outputValue: manifest.outputValue,
    fee: manifest.fee,
    sequence: solution.sequence,
    locktime: solution.locktime,
  };
}

/** The check issue #20's submit path calls. It does not broadcast or grant a permit. */
export function assertStoredJobSpend(job: Job, rawTxHex: string): void {
  buildStoredSpendRecord(job);
  assertWithdrawalSpendAgainstJob(job, rawTxHex);
}
