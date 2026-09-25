import type * as btc from "@scure/btc-signer";
import { finalizeVerifiedOfflineHelper } from "../lib/offline-signed-result";
import {
  helperPsbt,
  verifyWithdrawalCommitment,
  type FundingInput,
} from "../lib/transactions";
import type { Job, Withdrawal } from "../lib/model";
import type { Wallet } from "../lib/wallet";
import {
  coordinatorSignedResultSchema,
  coordinatorSolvedResultSchema,
  type CoordinatorSignedResult,
  type CoordinatorSolvedResult,
} from "./coordinatorResult";

type Assemble = (
  state: string,
  manifest: unknown,
  solution: unknown,
) => Promise<string>;

function samePoint(
  left: Withdrawal["funding"],
  right: Withdrawal["funding"],
): boolean {
  return (
    left.txid.toLowerCase() === right.txid.toLowerCase() &&
    left.vout === right.vout &&
    left.value === right.value
  );
}

function sameManifest(left: Withdrawal, right: Withdrawal): boolean {
  return (
    left.vaultId === right.vaultId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.destination === right.destination &&
    left.outputScript.toLowerCase() === right.outputScript.toLowerCase() &&
    left.outputValue === right.outputValue &&
    left.fee === right.fee &&
    left.costAccepted === true &&
    right.costAccepted === true &&
    samePoint(left.funding, right.funding) &&
    samePoint(left.helper, right.helper)
  );
}

function sameSolution(
  left: CoordinatorSolvedResult["solution"],
  right: NonNullable<Job["solution"]>,
): boolean {
  return (
    left.sequence === right.sequence &&
    left.locktime === right.locktime &&
    left.round1.join(",") === right.round1.join(",") &&
    left.round2.join(",") === right.round2.join(",")
  );
}

/**
 * Rebuild the withdrawal from browser-only recovery state and check it
 * against the coordinator's public solved result before any wallet call.
 * `stateJson` is passed only to the local assembler.
 */
export async function rebuildWithdrawalFromSolvedResult(input: {
  solved: unknown;
  job: Job;
  stateJson: string;
  helper: FundingInput;
  fundingPreviousTxHex: string;
  assemble: Assemble;
}): Promise<{
  solved: CoordinatorSolvedResult;
  raw: string;
  transaction: btc.Transaction;
}> {
  if (!input.job.solution)
    throw new Error("Solved result does not match this withdrawal.");
  const solved = coordinatorSolvedResultSchema.parse(input.solved);
  if (
    solved.jobId !== input.job.id ||
    solved.vaultId !== input.job.vaultId ||
    solved.manifestHash !== input.job.manifestHash ||
    !sameManifest(solved.manifest, input.job.manifest) ||
    !sameSolution(solved.solution, input.job.solution)
  )
    throw new Error("Solved result does not match this withdrawal.");
  const raw = await input.assemble(
    input.stateJson,
    solved.manifest,
    solved.solution,
  );
  verifyWithdrawalCommitment(raw, solved.manifest, solved.solution);
  const transaction = helperPsbt(raw, input.helper, input.fundingPreviousTxHex);
  if (transaction.getInput(0).sighashType !== 1)
    throw new Error("Helper input was not requested with SIGHASH_ALL.");
  return { solved, raw, transaction };
}

/** Public signed file. Call only after the helper signature checks pass. */
export function signedCoordinatorResult(
  solved: CoordinatorSolvedResult,
  expected: btc.Transaction,
  returned: Uint8Array,
  wallet: Wallet,
): CoordinatorSignedResult {
  const verified = finalizeVerifiedOfflineHelper(expected, returned, wallet);
  return coordinatorSignedResultSchema.parse({
    format: "qsb-coordinator-public-signed-result-v1",
    network: "mainnet",
    jobId: solved.jobId,
    vaultId: solved.vaultId,
    manifestHash: solved.manifestHash,
    rawTxHex: verified.rawTxHex,
    txid: verified.txid,
    helperSighash: "SIGHASH_ALL",
    helperSignatureVerified: true,
  });
}
