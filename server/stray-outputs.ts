import {
  STRAY_OUTPUTS_LISTED,
  strayPaymentsSchema,
  type PublicVault,
  type StrayPayments,
} from "../src/lib/model";
import type { Esplora } from "./chain";
import type { OwnerEventStore } from "./owner-events";
import type { Row } from "./store";

/** The stray payments recorded on a vault row, or null. */
export function strayPaymentsOf(row: Row): StrayPayments | null {
  const parsed = strayPaymentsSchema.safeParse(row.strayPayments);
  return parsed.success ? parsed.data : null;
}

function logStrayError(stage: string, error: unknown) {
  // Error class only: never URLs, owners or payloads.
  console.error(JSON.stringify({ strayPayments: stage, error: (error as Error)?.name ?? "Error" }));
}

/**
 * Look up the confirmed outputs at a funded vault's script and count those that aren't its
 * `funding`. When there are more than the vault row records, record the new count, total and
 * listed outputs, with a `deposit.stray_payment` owner event and a `strayPayment` log line for
 * the operator's alarm. Returns the row's stray payments.
 *
 * Anyone can pay the script, so the record stays a fixed size however many outputs arrive: it
 * never grows the vault row towards the store's item limit, which would block the row's later
 * writes. The outputs are never spent, so their count only grows (a reorg aside).
 *
 * Detection only: nothing here decides what a withdrawal spends. Job creation accepts only
 * `vault.funding` and exact submission binds the transaction to it, so a stray output is never
 * spent. A failed lookup or write therefore leaves the row as it was and doesn't fail the caller.
 */
export async function flagStrayPayments(
  store: OwnerEventStore,
  ledger: Pick<Esplora, "scriptOutputs">,
  row: Row,
  now = new Date(),
): Promise<StrayPayments | null> {
  const known = strayPaymentsOf(row);
  const vault = row.vault as PublicVault;
  if (!vault.funding) return known;
  let outputs: Awaited<ReturnType<Esplora["scriptOutputs"]>>;
  try {
    outputs = await ledger.scriptOutputs(vault.scriptHash);
  } catch (error) {
    logStrayError("lookup_failed", error);
    return known;
  }
  const point = (o: { txid: string; vout: number }) => `${o.txid.toLowerCase()}:${o.vout}`;
  const funding = point(vault.funding);
  const stray = outputs.filter((o) => o.confirmed && point(o) !== funding);
  if (stray.length <= (known?.count ?? 0)) return known;
  const listed = new Set((known?.outputs ?? []).map(point));
  const firstSeenAt = now.toISOString();
  const added = stray
    .filter((o) => !listed.has(point(o)))
    .slice(0, STRAY_OUTPUTS_LISTED - listed.size)
    .map((o) => ({ txid: o.txid, vout: o.vout, value: o.value, firstSeenAt }));
  const record: StrayPayments = {
    vaultId: vault.id,
    count: stray.length,
    sats: stray.reduce((sum, o) => sum + BigInt(o.value), 0n).toString(),
    outputs: [...(known?.outputs ?? []), ...added],
  };
  try {
    await store.put({ ...row, strayPayments: record, version: row.version + 1 }, row.version);
  } catch (error) {
    // Another write won, or the store failed: the next check counts these outputs again.
    logStrayError("record_failed", error);
    return known;
  }
  store.recordStrayPayment(row.pk.slice("OWNER#".length), vault.id);
  console.warn(
    JSON.stringify({
      strayPayment: {
        vaultId: vault.id,
        count: record.count,
        newCount: record.count - (known?.count ?? 0),
        sats: record.sats,
        outputs: added.map(point),
      },
    }),
  );
  return record;
}
