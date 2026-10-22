import { createHash } from "node:crypto";
import type { PublicVault } from "../src/lib/model";
import { Conflict, scriptReservation, type Row, type Store } from "./store";

/** What a backfill found, and wrote with `apply`. Vault ids only: never an owner address. */
export type ScriptBackfill = {
  applied: boolean;
  vaults: number;
  /** Reservations written, or that `apply` would write. */
  reserved: number;
  /** Vaults that already hold their script's reservation. */
  alreadyReserved: number;
  /**
   * Vaults whose script another vault holds, or another vault row shares, each with the vault that
   * holds it or that this run reserves it for, or would without `apply` (`heldBy`). Left as they are.
   */
  duplicates: { vault: string; heldBy: string }[];
  /** Vault rows whose script hash isn't the SHA-256 of their script. Left as they are. */
  unreadable: string[];
  /**
   * Vaults whose write met another write to the reservation that hadn't settled, or that share a
   * script with such a vault, so this run didn't write for them. Run again.
   */
  unsettled: string[];
};

/**
 * Reserve the script of each vault row that has no reservation, the row POST /api/vaults writes
 * with a new vault: `SCRIPT#<scriptHash>`, with attribute_not_exists. Without `apply` it only
 * reports. A script another vault holds is reported and never reassigned. Of two rows sharing a
 * script, the one whose deposit got furthest keeps it (confirmed or spent, then submitted, then
 * none), then the one whose `createdAt` names the earlier time. The deposit routes refuse the
 * other, so a submitted deposit that may still need resending loses to a confirmed one, and an
 * unfunded row to either. `createdAt` is set by the client, so it only breaks ties; the other row
 * is reported either way. Run again, it changes nothing.
 */
export async function backfillScriptReservations(
  store: Pick<Store, "get" | "put">,
  vaultRows: Row[],
  apply: boolean,
): Promise<ScriptBackfill> {
  const result: ScriptBackfill = {
    applied: apply,
    vaults: vaultRows.length,
    reserved: 0,
    alreadyReserved: 0,
    duplicates: [],
    unreadable: [],
    unsettled: [],
  };
  const vaultOf = (row: Row) => row.vault as Partial<PublicVault> | undefined;
  // How far the row's deposit got: the vault that keeps the script is the one the refusal can't help.
  const stage = (row: Row) => {
    const { status, funding } = vaultOf(row) ?? {};
    return status === "confirmed" || status === "spent" ? 0 : funding ? 1 : 2;
  };
  // A time, not text: `createdAt` may carry milliseconds or not. One that doesn't parse goes last.
  const createdAt = (row: Row) => Date.parse(String(vaultOf(row)?.createdAt)) || Number.POSITIVE_INFINITY;
  const rows = [...vaultRows].sort(
    (a, b) => stage(a) - stage(b) || createdAt(a) - createdAt(b) || a.sk.localeCompare(b.sk),
  );
  // Scripts this run reserved, or would, by vault: a dry run sees no reservation it would have
  // written. Null for a write that didn't settle: a later row on that script is unsettled too.
  const claimed = new Map<string, string | null>();
  for (const row of rows) {
    const vault = vaultOf(row);
    const vaultId = typeof vault?.id === "string" ? vault.id : row.sk.slice("VAULT#".length);
    const { scriptHex, scriptHash } = vault ?? {};
    if (
      typeof scriptHex !== "string" ||
      typeof scriptHash !== "string" ||
      createHash("sha256").update(Buffer.from(scriptHex, "hex")).digest("hex") !== scriptHash
    ) {
      result.unreadable.push(vaultId);
      continue;
    }
    const owner = row.pk.slice("OWNER#".length);
    const reservation = scriptReservation(owner, { id: vaultId, scriptHash });
    const mine = (held: Row | undefined) => held?.owner === owner && held.vaultId === vaultId;
    const settle = (held: Row | undefined) => {
      if (held && mine(held)) result.alreadyReserved++;
      else if (held) result.duplicates.push({ vault: vaultId, heldBy: String(held.vaultId) });
      return held !== undefined;
    };
    const earlier = claimed.get(scriptHash);
    if (settle(await store.get(reservation.pk, reservation.sk))) continue;
    if (earlier === null) {
      result.unsettled.push(vaultId);
      continue;
    }
    if (earlier) {
      result.duplicates.push({ vault: vaultId, heldBy: earlier });
      continue;
    }
    claimed.set(scriptHash, vaultId);
    if (apply)
      try {
        await store.put(reservation);
      } catch (error) {
        // Another write to this reservation between the read and the write: a registration of
        // the same script, or another run. A plain PutItem meets a transaction still in flight
        // as TransactionConflictException, which the store doesn't turn into a Conflict.
        if (!(error instanceof Conflict) && (error as Error).name !== "TransactionConflictException") throw error;
        if (!settle(await store.get(reservation.pk, reservation.sk))) {
          result.unsettled.push(vaultId);
          claimed.set(scriptHash, null);
        }
        continue;
      }
    result.reserved++;
  }
  return result;
}
