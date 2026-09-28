import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { type PublicVault } from "../src/lib/model";
import { assertVaultConfiguration } from "../src/lib/provenance";
import { Conflict, type Row, type Store } from "./store";
import { ChainError } from "./chain";
import { matchVaultFunding } from "./transaction-checks";
import { transactionId } from "./runtime/miner-inclusion";
import {
  exactSubmitEnabled,
  issueExactSubmitPermit,
  type ExactSubmitPermit,
} from "./exact-submit-permit";
import { MinerRejection } from "./providers";
import { SubmitDisabled } from "./submit-exact";

export type FundingSubmission = "submitted" | "uncertain" | "rejected";
export type FundingDependencies = {
  store: Store;
  miner: {
    submitFunding(raw: string, permit: ExactSubmitPermit): Promise<unknown>;
    seen(txid: string): Promise<boolean>;
  };
  /** Trusted server/test configuration; never a request field. */
  enabled?: boolean;
};
const opts = { allowUnknownOutputs: true, allowUnknownInputs: true };

/** Fence an in-flight rejection before exposing bytes that can be submitted manually.
 * If cleanup wins the version race, return no bytes; the caller must refresh.
 * Same-byte retries never clear an intent, so this fence also protects later retries.
 */
export async function exportFunding(store: Store, owner: string, vaultId: string, expectedRaw?: string): Promise<Row | undefined> {
  let boundRaw = expectedRaw;
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await store.get(`OWNER#${owner}`, `VAULT#${vaultId}`);
    const vault = row?.vault as PublicVault | undefined;
    if (!row || !vault?.funding || typeof row.fundingRawTxHex !== "string" || !row.fundingRawTxHex)
      return undefined;
    if (boundRaw !== undefined && row.fundingRawTxHex !== boundRaw)
      throw new ChainError("Funding intent changed during export. Refresh the vault.");
    boundRaw = row.fundingRawTxHex;
    const next = { ...row, version: row.version + 1, fundingExportedAt: new Date().toISOString() };
    try {
      await store.put(next, row.version);
      return next;
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
    }
  }
  throw new Conflict();
}

/**
 * Record a signed deposit as the vault's funding intent, then submit exactly those bytes to
 * MARA Slipstream. Public relay refuses the bare QSB output, so Slipstream is the only route.
 *
 * - The intent (txid, raw bytes, amount) is stored before the POST, so an unknown outcome is
 *   never lost and a second, different deposit is refused.
 * - Re-submitting the same bytes is safe: they can only confirm once. A retry first asks the
 *   miner whether it already has the transaction.
 * - A definite refusal of a fresh intent (HTTP 400, status "error") clears the intent only if
 *   MARA then says it doesn't have the transaction: a concurrent retry may have been accepted
 *   first, and the refusal may just be for the duplicate. A refusal on a retry keeps the intent.
 * - A retry bumps the row's version before its POST, so a racing first request can't clear an
 *   intent that the retry may have just submitted.
 */
export async function submitFunding(
  owner: string,
  vaultId: string,
  rawTxHex: string,
  amount: bigint,
  deps: FundingDependencies,
): Promise<{ vault: PublicVault; submission: FundingSubmission; reason?: string }> {
  if (!(deps.enabled ?? exactSubmitEnabled()))
    throw new SubmitDisabled("Deposit submission to the miner is disabled.");
  const { store, miner } = deps;
  const raw = rawTxHex.toLowerCase();
  let tx: btc.Transaction;
  try {
    tx = btc.Transaction.fromRaw(hex.decode(raw), opts);
  } catch {
    throw new ChainError("Invalid funding transaction.");
  }
  const txid = transactionId(raw);
  const pk = `OWNER#${owner}`,
    sk = `VAULT#${vaultId}`;
  const row = await store.get(pk, sk);
  if (!row) throw new ChainError("Vault not found.");
  const vault = row.vault as PublicVault;
  if (vault.network !== "mainnet" || vault.id !== vaultId)
    throw new ChainError("Mainnet vault not found.");
  assertVaultConfiguration(vault);
  const payment = matchVaultFunding(tx, vault.scriptHex, amount);

  let current: Row;
  let fresh: boolean;
  if (vault.funding) {
    if (vault.funding.txid !== txid || row.fundingRawTxHex !== raw)
      throw new ChainError(
        "Vault already has a different funding intent. Reconcile it before depositing again.",
      );
    if (vault.status !== "submitted") return { vault, submission: "submitted" };
    fresh = false;
    if (await miner.seen(txid)) return record(store, row, "submitted");
    current = await touch(store, row);
  } else {
    if (vault.status !== "unfunded")
      throw new ChainError("Vault already has a funding intent. Reconcile that transaction first.");
    const next: Row = {
      ...row,
      version: row.version + 1,
      vault: {
        ...vault,
        funding: { txid, vout: payment.vout, value: payment.value },
        status: "submitted",
      },
      fundingRawTxHex: raw,
      fundingSubmission: "uncertain",
      fundingSubmittedAt: new Date().toISOString(),
    };
    try {
      await store.put(next, row.version);
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
      const winner = await store.get(pk, sk);
      const won = winner?.vault as PublicVault | undefined;
      if (won?.funding?.txid === txid && winner?.fundingRawTxHex === raw)
        return { vault: won, submission: (winner.fundingSubmission as FundingSubmission) ?? "uncertain" };
      throw error;
    }
    current = next;
    fresh = true;
  }

  try {
    await miner.submitFunding(raw, issueExactSubmitPermit(raw));
  } catch (error) {
    if (error instanceof MinerRejection && fresh) {
      // The refusal may be for a duplicate of a concurrent retry that MARA accepted.
      let known: boolean;
      try {
        known = await miner.seen(txid);
      } catch {
        return record(store, current, "uncertain");
      }
      if (known) return record(store, current, "submitted");
      return clear(store, current, error.message);
    }
    // Timeouts, 5xx, malformed responses, or a refusal of a retry: the outcome stays unknown.
    return record(store, current, "uncertain");
  }
  return record(store, current, "submitted");
}

/** Bump the row's version before a retry POST, so an older request's clear() can't win. */
async function touch(store: Store, row: Row): Promise<Row> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const latest = (await store.get(row.pk, row.sk)) ?? row;
    if ((latest.vault as PublicVault).funding?.txid !== (row.vault as PublicVault).funding?.txid)
      throw new ChainError("Funding intent changed during submission. Refresh the vault.");
    const next = { ...latest, version: latest.version + 1, fundingResubmittedAt: new Date().toISOString() };
    try {
      await store.put(next, latest.version);
      return next;
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
    }
  }
  throw new ChainError("The vault kept changing during a resubmission. Try again.");
}

async function record(store: Store, row: Row, outcome: "submitted" | "uncertain") {
  for (let attempt = 0; attempt < 5; attempt++) {
    const latest = (await store.get(row.pk, row.sk)) ?? row;
    const vault = latest.vault as PublicVault;
    if (vault.funding?.txid !== (row.vault as PublicVault).funding?.txid)
      throw new ChainError("Funding intent changed during submission. Refresh the vault.");
    const submission =
      latest.fundingSubmission === "submitted" || outcome === "submitted" ? "submitted" : "uncertain";
    try {
      await store.put({ ...latest, version: latest.version + 1, fundingSubmission: submission }, latest.version);
      return { vault, submission: submission as FundingSubmission };
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
    }
  }
  const final = (await store.get(row.pk, row.sk))!;
  return { vault: final.vault as PublicVault, submission: (final.fundingSubmission as FundingSubmission) ?? "uncertain" };
}

async function clear(store: Store, row: Row, reason: string) {
  const vault = row.vault as PublicVault;
  const { funding: _removed, ...rest } = vault;
  const { fundingRawTxHex: _raw, fundingSubmission: _state, fundingSubmittedAt: _at, ...other } = row;
  const next: Row = {
    ...other,
    version: row.version + 1,
    vault: { ...rest, status: "unfunded" },
    lastFundingRejection: { txid: vault.funding?.txid, reason, at: new Date().toISOString() },
  };
  try {
    await store.put(next, row.version);
  } catch (error) {
    // Something else touched the vault; keep the intent rather than guess.
    if (!(error instanceof Conflict)) throw error;
    return record(store, row, "uncertain");
  }
  return { vault: next.vault as PublicVault, submission: "rejected" as const, reason };
}
