import { strayOutputSchema, type PublicVault, type StrayOutput } from "../src/lib/model";
import type { Esplora } from "./chain";
import type { OwnerEventStore } from "./owner-events";
import type { Row } from "./store";

/** The stray outputs recorded on a vault row. */
export function strayOutputsOf(row: Row): StrayOutput[] {
  if (!Array.isArray(row.strayOutputs)) return [];
  return row.strayOutputs.flatMap((item) => {
    const parsed = strayOutputSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function logStrayError(stage: string, error: unknown) {
  // Error class only: never URLs, owners or payloads.
  console.error(JSON.stringify({ strayOutputs: stage, error: (error as Error)?.name ?? "Error" }));
}

/**
 * Look up the confirmed outputs at a funded vault's script and record any that aren't its
 * `funding` on the vault row, with a `deposit.stray_payment` owner event and a `strayPayment`
 * log line for the operator's alarm. Returns the row's stray outputs.
 *
 * Detection only: nothing here decides what a withdrawal spends. Job creation accepts only
 * `vault.funding` and exact submission binds the transaction to it, so a stray output is never
 * spent. A failed lookup or write therefore leaves the row as it was and doesn't fail the caller.
 */
export async function flagStrayOutputs(
  store: OwnerEventStore,
  ledger: Pick<Esplora, "scriptOutputs">,
  row: Row,
  now = new Date(),
): Promise<StrayOutput[]> {
  const known = strayOutputsOf(row);
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
  const skip = new Set([point(vault.funding), ...known.map(point)]);
  const firstSeenAt = now.toISOString();
  const fresh = outputs
    .filter((o) => o.confirmed && !skip.has(point(o)))
    .map((o) => ({ vaultId: vault.id, txid: o.txid, vout: o.vout, value: o.value, firstSeenAt }));
  if (!fresh.length) return known;
  const flagged = [...known, ...fresh];
  try {
    await store.put({ ...row, strayOutputs: flagged, version: row.version + 1 }, row.version);
  } catch (error) {
    // Another write won, or the store failed: the next check finds these outputs again.
    logStrayError("record_failed", error);
    return known;
  }
  store.recordStrayPayment(row.pk.slice("OWNER#".length), vault.id);
  console.warn(
    JSON.stringify({
      strayPayment: {
        vaultId: vault.id,
        outputs: fresh.map(point),
        sats: fresh.reduce((sum, o) => sum + BigInt(o.value), 0n).toString(),
      },
    }),
  );
  return flagged;
}
