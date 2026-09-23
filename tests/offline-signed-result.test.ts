import { expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { walletCheckFixture } from "../src/lib/wallet-check";
import { finalizeVerifiedOfflineHelper } from "../src/lib/offline-signed-result";
const key = new Uint8Array(32).fill(19),
  pub = secp256k1.getPublicKey(key);
const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };
function fixture(nested = false) {
  const wallet = {
    address: (nested ? btc.p2sh(btc.p2wpkh(pub)) : btc.p2wpkh(pub)).address!,
    publicKey: hex.encode(pub),
    type: nested ? "p2sh" : "p2wpkh",
  };
  const expected = walletCheckFixture(
    wallet,
    "51".repeat(9923),
    "full-stack",
  ).transaction;
  const returned = btc.Transaction.fromPSBT(expected.toPSBT(), opts);
  returned.signIdx(key, 0);
  return { wallet, expected, returned };
}
for (const nested of [false, true]) {
  for (const finalized of [false, true]) {
    it(`exports a verified ${nested ? "nested" : "native"} helper from ${finalized ? "final" : "partial"} PSBT without refinalizing QSB`, () => {
      const { wallet, expected, returned } = fixture(nested);
      if (finalized) returned.finalizeIdx(0);
      const result = finalizeVerifiedOfflineHelper(
        expected,
        returned.toPSBT(),
        wallet,
      );
      const raw = btc.Transaction.fromRaw(hex.decode(result.rawTxHex), opts);
      expect(raw.id).toBe(result.txid);
      expect(raw.getInput(0).finalScriptWitness).toHaveLength(2);
      expect(hex.encode(raw.getInput(1).finalScriptSig!)).toBe(
        hex.encode(expected.getInput(1).finalScriptSig!),
      );
    });
  }
}
it("rejects a valid partial signature accompanied by an invalid final witness", () => {
  const { wallet, expected, returned } = fixture();
  const signature = returned.getInput(0).partialSig![0][1].slice();
  signature[signature.length - 2] ^= 1;
  returned.updateInput(0, { finalScriptWitness: [signature, pub] }, true);
  expect(() =>
    finalizeVerifiedOfflineHelper(expected, returned.toPSBT(), wallet),
  ).toThrow("signature failed");
});
it("rejects an unrelated partial signature before the valid matching signature", () => {
  const { wallet, expected, returned } = fixture();
  const partial = returned.getInput(0).partialSig![0];
  const unrelated = secp256k1.getPublicKey(new Uint8Array(32).fill(20));
  returned.updateInput(
    0,
    { partialSig: [[unrelated, partial[1]], partial] },
    true,
  );
  expect(() =>
    finalizeVerifiedOfflineHelper(expected, returned.toPSBT(), wallet),
  ).toThrow("exactly one");
});
it("rejects a stray native helper scriptSig even with a valid final signature", () => {
  const { wallet, expected, returned } = fixture();
  returned.finalizeIdx(0);
  returned.updateInput(0, { finalScriptSig: Uint8Array.of(0) }, true);
  expect(() =>
    finalizeVerifiedOfflineHelper(expected, returned.toPSBT(), wallet),
  ).toThrow("scriptSig");
});
it("rejects a wallet-added witness on the legacy QSB input", () => {
  const { wallet, expected, returned } = fixture();
  returned.updateInput(1, { finalScriptWitness: [Uint8Array.of(1)] }, true);
  expect(() =>
    finalizeVerifiedOfflineHelper(expected, returned.toPSBT(), wallet),
  ).toThrow("QSB input witness");
});
