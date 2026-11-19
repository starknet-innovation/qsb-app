import { expect, it } from "vitest";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { verifyPqbWitness } from "../sdk/verify-pqb-witness";
import { publicRuntime } from "../sdk/public-runtime";
import { concat, hash160 } from "../src/pqb-core/primitives";
import { pushData } from "../src/pqb-core/l1gen";
import { legacySighashAll, serializeTx, type Tx } from "../src/pqb-core/tx";
import { buildLock } from "../src/pqb-core/lock";
import { assemble, pinFields } from "../src/pqb-core/spend";
import reference from "./fixtures/pqb-reference.json";
import { pqbTransaction } from "../src/lib/pqb";
import { withdrawalSchema } from "../src/lib/model";

function signedFixture(multisig = false) {
  // Synthetic signature/stack component fixture, not a real PQB hash-puzzle solution.
  const key = new Uint8Array(32).fill(7), pk = secp256k1.getPublicKey(key, true);
  const script = multisig ? concat([0x51], pushData(pk), [0x51, 0xaf, 0x51])
    : concat([0x76, 0xa9], pushData(hash160(pk)), [0x88, 0xad, 0x51]);
  const tx: Tx = { version: 1, locktime: 500000000, vin: [
    { txid: "11".repeat(32), vout: 0, sequence: 0xfffffffe, scriptSig: new Uint8Array() },
    { txid: "22".repeat(32), vout: 0, sequence: 0x80000000, scriptSig: new Uint8Array() },
  ], vout: [{ value: 10000n, script: Uint8Array.from([0x51]) }] };
  const sig = concat(secp256k1.sign(legacySighashAll(tx, 1, script), key, { prehash: false, format: "der" }), [1]);
  tx.vin[1].scriptSig = multisig ? concat([0], pushData(sig)) : concat(pushData(sig), pushData(pk));
  return { tx, script, sig, pk, raw: () => hex.encode(serializeTx(tx)) };
}
it("cryptographically verifies SIGHASH_ALL co-signatures and rejects transaction/signature edits", () => {
  const f = signedFixture();
  expect(() => verifyPqbWitness(f.raw(), hex.encode(f.script), 1)).not.toThrow();
  f.tx.vout[0].value++;
  expect(() => verifyPqbWitness(f.raw(), hex.encode(f.script), 1)).toThrow("Invalid PQB signature");
  f.tx.vout[0].value--;
  f.sig[f.sig.length - 1] = 3;
  f.tx.vin[1].scriptSig = concat(pushData(f.sig), pushData(f.pk));
  expect(() => verifyPqbWitness(f.raw(), hex.encode(f.script), 1)).toThrow("SIGHASH_ALL");
});
it("checks multisignatures, null dummy and push-only authorization", () => {
  const f = signedFixture(true);
  expect(() => verifyPqbWitness(f.raw(), hex.encode(f.script), 1)).not.toThrow();
  f.tx.vin[1].scriptSig = concat([0x51], pushData(f.sig));
  expect(() => verifyPqbWitness(f.raw(), hex.encode(f.script), 1)).toThrow("dummy");
  f.tx.vin[1].scriptSig = Uint8Array.of(0x76);
  expect(() => verifyPqbWitness(f.raw(), hex.encode(f.script), 1)).toThrow("push-only");
});
it("rejects a real PQB-layout witness with a valid co-signature but unsolved puzzle signatures", () => {
  const lock = buildLock("PQB", Uint8Array.from(reference.seed.match(/../g)!, s => parseInt(s, 16)), { version: "v0" });
  const [lt, seq] = pinFields(BigInt(reference.pinNonce));
  const manifest = withdrawalSchema.parse(reference.manifest);
  const out = assemble(lock, { txid: manifest.funding.txid, vout: 0, amount: 100000 }, [], {
    transaction: pqbTransaction(manifest, seq, lt), inputIndex: 1,
    selection: [reference.priorSelection, [0,1,2,4,5,6,7,8,10]],
  });
  // The upstream simulator permits signature opcodes. The SDK verifier must not.
  expect(out.simError).toBeNull();
  expect(() => verifyPqbWitness(out.hex, reference.scriptHex, 1)).toThrow(/signature|SIGHASH_ALL/);
});
it("does not expose secret-handling public runtime operations", () => {
  expect(Object.keys(publicRuntime()).sort()).toEqual(["prepare", "validate", "verify"]);
});

it("replays the archived public synthetic PQB solution and verifies its full returned witness without a seed", async () => {
  const { readFileSync } = await import("node:fs");
  const fixture = JSON.parse(readFileSync(new URL("../docs/pqb-deployed-validation/public-fixture.json", import.meta.url), "utf8"));
  const solved = JSON.parse(readFileSync(new URL("../docs/pqb-deployed-validation/solved-public.json", import.meta.url), "utf8"));
  const vault = fixture.rows.find((row: { vault?: unknown }) => row.vault)?.vault;
  const raw = readFileSync(new URL("../docs/pqb-deployed-validation/solved-synthetic-transaction.hex", import.meta.url), "utf8").trim();
  const runtime = publicRuntime();
  await runtime.validate(vault);
  const prepared = await runtime.prepare(vault, solved.manifest, solved.solution);
  expect(prepared.selection).toEqual([solved.solution.round1, solved.solution.round2]);
  await expect(runtime.verify(vault, solved.manifest, solved.solution, raw)).resolves.toBeUndefined();
  const changed = raw.slice(0, -10) + (raw.slice(-10, -8) === "00" ? "01" : "00") + raw.slice(-8);
  await expect(runtime.verify(vault, solved.manifest, solved.solution, changed)).rejects.toThrow();
});
