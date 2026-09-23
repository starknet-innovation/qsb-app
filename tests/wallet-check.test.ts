import { expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { walletCheckFixture, verifyWalletCheck, disposableAuthorizationStack } from "../src/lib/wallet-check";
const key = new Uint8Array(32).fill(17),
  pub = secp256k1.getPublicKey(key);
for (const nested of [false, true])
  for (const kind of ["funding", "helper", "full-stack"] as const) {
    it(`checks ${nested ? "nested" : "native"} ${kind} signatures using an unmineable parent`, () => {
      const wallet = {
        address: (nested ? btc.p2sh(btc.p2wpkh(pub)) : btc.p2wpkh(pub))
          .address!,
        publicKey: hex.encode(pub),
        type: "payment",
      };
      const fixture = walletCheckFixture(wallet, "51".repeat(9923), kind);
      const previous = btc.Transaction.fromRaw(fixture.parentRaw, {
        allowUnknownOutputs: true,
        allowUnknownInputs: true,
      });
      expect(hex.encode(previous.getInput(0).txid!)).toBe("00".repeat(32));
      expect(previous.getInput(0).index).toBe(0xffffffff);
      expect(previous.getInput(0).finalScriptSig!.length).toBe(1);
      expect(() =>
        verifyWalletCheck(fixture, fixture.transaction.toPSBT(), wallet),
      ).toThrow("signature");
      const signed = btc.Transaction.fromPSBT(fixture.transaction.toPSBT(), {
        allowUnknownOutputs: true,
        allowUnknownInputs: true,
      });
      signed.signIdx(key, 0);
      expect(verifyWalletCheck(fixture, signed.toPSBT(), wallet)).toMatchObject(
        { signatureVerified: true, broadcast: false },
      );
      signed.finalizeIdx(0);
      expect(
        verifyWalletCheck(fixture, signed.toPSBT(), wallet).signatureVerified,
      ).toBe(true);
    });
  }
it("encodes every Config A stack item without using recovery material", () => {
  const stack = disposableAuthorizationStack();
  const items = btc.Script.decode(stack);
  expect(items).toHaveLength(57);
  expect(items.filter(v => v instanceof Uint8Array && v.length === 33)).toHaveLength(24);
  expect(items.filter(v => v instanceof Uint8Array && v.length === 20)).toHaveLength(15);
  expect(items.filter(v => v instanceof Uint8Array && v.length === 2)).toHaveLength(18);
  expect(stack.length).toBe(1185);
});
it("rejects a wallet that signs the helper but truncates the complete stack", () => {
  const wallet = { address: btc.p2wpkh(pub).address!, publicKey: hex.encode(pub), type: "payment" };
  const fixture = walletCheckFixture(wallet, "51".repeat(9923), "full-stack");
  const signed = btc.Transaction.fromPSBT(fixture.transaction.toPSBT(), { allowUnknownOutputs: true, allowUnknownInputs: true });
  signed.signIdx(key, 0);
  signed.updateInput(1, { finalScriptSig: Uint8Array.of(0) }, true);
  expect(() => verifyWalletCheck(fixture, signed.toPSBT(), wallet)).toThrow("QSB authorization");
});
it("rejects fabricated signature bytes even when transaction metadata is unchanged", () => {
  const wallet = {
    address: btc.p2wpkh(pub).address!,
    publicKey: hex.encode(pub),
    type: "payment",
  };
  const fixture = walletCheckFixture(wallet, "51".repeat(9923), "funding");
  const signed = btc.Transaction.fromPSBT(fixture.transaction.toPSBT(), {
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
  });
  signed.updateInput(0, { partialSig: [[pub, Uint8Array.of(0x30, 1, 1)]] });
  expect(() => verifyWalletCheck(fixture, signed.toPSBT(), wallet)).toThrow();
});
