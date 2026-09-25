import { createHash } from "node:crypto";
import { type Job, type PublicVault } from "../src/lib/model";
import { Conflict, type Row, type Store } from "./store";
import { type Esplora, ChainError } from "./chain";
import {
  assertStoredJobSpend,
  buildStoredSpendRecord,
} from "./job-spend-record";
import { checkWithdrawal } from "./transaction-checks";
import { transactionId } from "./runtime/miner-inclusion";
import {
  exactSubmitEnabled,
  issueExactSubmitPermit,
  type ExactSubmitPermit,
} from "./exact-submit-permit";

export type SubmitDependencies = {
  store: Store;
  chain: Esplora;
  consensus: { verify(raw: string, chain: Esplora): Promise<void> };
  miner: { submit(raw: string, permit: ExactSubmitPermit): Promise<unknown> };
  /** Trusted server/test configuration; never a request field. */
  enabled?: boolean;
};
export class SubmitDisabled extends Error {}
function summary(row: Row) {
  return { txid: row.txid as string, status: row.status as string };
}

/** Exactly one POST attempt. An uncertain outcome retains both intent and reservations. */
export async function submitExact(
  owner: string,
  jobId: string,
  raw: string,
  deps: SubmitDependencies,
) {
  if (!(deps.enabled ?? exactSubmitEnabled()))
    throw new SubmitDisabled("Exact submission is disabled.");
  const { store, chain, consensus, miner } = deps;
  const pk = "OWNER#" + owner;
  const row = await store.get(pk, "JOB#" + jobId);
  if (!row) throw new ChainError("Job not found.");
  const job = row.job as Job;
  if (
    job.owner !== owner ||
    job.id !== jobId ||
    (job as Job & { execution?: { kind?: string } }).execution?.kind ===
      "qsb-supervised-service-v1"
  )
    throw new ChainError("Job is not a coordinator withdrawal.");
  assertStoredJobSpend(job, raw);
  const txid = transactionId(raw);
  const rawHash = createHash("sha256").update(raw.toLowerCase()).digest("hex");
  const existing = await store.get(pk, "TX#" + txid);
  if (existing) {
    if (
      existing.kind !== "exact-withdrawal" ||
      existing.jobId !== jobId ||
      existing.rawHash !== rawHash
    )
      throw new ChainError(
        "Transaction intent differs. Reconcile the existing submission.",
      );
    return summary(existing);
  }
  if (job.txid)
    throw new ChainError("A withdrawal intent already exists. Reconcile it.");
  const vaultRow = await store.get(pk, "VAULT#" + job.vaultId);
  const vault = vaultRow?.vault as PublicVault | undefined;
  if (!vault || vault.network !== "mainnet" || vault.id !== job.vaultId)
    throw new ChainError("Mainnet vault not found.");
  await checkWithdrawal(raw, vault, job, chain);
  // Every input is checked against real chain outputs by Core, before TX# exists.
  await consensus.verify(raw, chain);
  const now = new Date().toISOString();
  const intent: Row = {
    pk,
    sk: "TX#" + txid,
    version: 0,
    kind: "exact-withdrawal",
    jobId,
    txid,
    rawHash,
    rawTxHex: raw.toLowerCase(),
    manifest: job.manifest,
    spend: buildStoredSpendRecord(job),
    status: "uncertain",
    createdAt: now,
  };
  try {
    await store.atomicPut([
      { row: intent },
      {
        row: {
          ...row,
          version: row.version + 1,
          job: { ...job, txid, status: "submitted", updatedAt: now },
        },
        expected: row.version,
      },
      { row: vaultRow!, expected: vaultRow!.version, conditionOnly: true },
    ]);
  } catch (error) {
    if (!(error instanceof Conflict)) throw error;
    const winner = await store.get(pk, intent.sk);
    if (
      winner?.kind === "exact-withdrawal" &&
      winner.jobId === jobId &&
      winner.rawHash === rawHash
    )
      return summary(winner);
    throw error;
  }
  let status = "uncertain";
  try {
    await miner.submit(raw, issueExactSubmitPermit(raw));
    status = "submitted";
  } catch {
    // HTTP errors, rejection, timeout or malformed response are never automatic retry authority.
  }
  try {
    await store.put(
      { ...intent, version: 1, status, attemptedAt: new Date().toISOString() },
      0,
    );
  } catch (error) {
    if (!(error instanceof Conflict)) throw error;
    // Status reconciliation may have advanced the row during the POST; never overwrite it.
    return summary((await store.get(pk, intent.sk))!);
  }
  return { txid, status };
}
