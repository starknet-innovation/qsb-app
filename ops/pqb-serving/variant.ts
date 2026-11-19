/** The public synthetic intents a campaign can search. The seed is committed public test data. */
import fixture from "../../tests/fixtures/pqb-reference.json" with { type: "json" };

export const VARIANTS = ["two-input-v0", "one-input-v1"] as const;
export type Variant = (typeof VARIANTS)[number];

/**
 * `two-input-v0`: the committed reference intent, a public OP_TRUE helper then a construction-v0
 * vault. `one-input-v1`: the same vault output and payee with no helper, under construction v1
 * (the PQB Ledger app's); the vault pays the same fee. A fixture without `variant` is two-input-v0.
 */
export function fixtureVariant(variant: Variant = "two-input-v0") {
  if (fixture.manifest.funding.txid !== "11".repeat(32) || fixture.manifest.helper.txid !== "22".repeat(32))
    throw Error("Fixture must be the committed unfunded synthetic intent");
  if (variant === "two-input-v0")
    return { state: JSON.stringify({ config: "PQB", seed: fixture.seed }), manifest: fixture.manifest };
  if (variant !== "one-input-v1") throw Error("Unknown public fixture variant");
  const { helper: _helper, ...manifest } = fixture.manifest;
  return {
    state: JSON.stringify({ config: "PQB", seed: fixture.seed, version: "v1" }),
    manifest: { ...manifest,
      outputValue: (BigInt(manifest.funding.value) - BigInt(manifest.fee)).toString() },
  };
}

/** The variant a prepared fixture records; absent means the original two-input-v0 intent. */
export function preparedVariant(prepared: { variant?: unknown }): Variant {
  const variant = prepared.variant ?? "two-input-v0";
  if (!VARIANTS.includes(variant as Variant) || prepared.variant === "two-input-v0")
    throw Error("Unknown public fixture variant");
  return variant as Variant;
}
