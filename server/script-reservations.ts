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
  /** Vaults whose script another vault holds, or an older vault row shares. Left as they are. */
  duplicates: string[];
  /** Vault rows whose script hash isn't the SHA-256 of their script. Left as they are. */
  unreadable: string[];
};

/**
 * Reserve the script of each vault row that has no reservation, the row POST /api/vaults writes
 * with a new vault: `SCRIPT#<scriptHash>`, with attribute_not_exists. Without `apply` it only
 * reports. A script another vault holds is reported and never reassigned. Rows go oldest first,
 * so of two rows sharing a script the older one is reserved. Run again, it changes nothing.
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
  };
  const createdAt = (row: Row) => String((row.vault as Partial<PublicVault> | undefined)?.createdAt ?? "");
  const rows = [...vaultRows].sort((a, b) => createdAt(a).localeCompare(createdAt(b)) || a.sk.localeCompare(b.sk));
  // Scripts this run reserved, or would: a dry run sees no reservation it would have written.
  const claimed = new Set<string>();
  for (const row of rows) {
    const vault = row.vault as Partial<PublicVault> | undefined;
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
    const held = await store.get(reservation.pk, reservation.sk);
    if (held && mine(held)) result.alreadyReserved++;
    else if (held || claimed.has(scriptHash)) result.duplicates.push(vaultId);
    else {
      claimed.add(scriptHash);
      if (apply)
        try {
          await store.put(reservation);
        } catch (error) {
          // A registration of the same script, between the read and the write.
          if (!(error instanceof Conflict)) throw error;
          result.duplicates.push(vaultId);
          continue;
        }
      result.reserved++;
    }
  }
  return result;
}
