import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { BITCOIN_NETWORK } from "./network";
import { verifySignedPsbt } from "./transactions";
import type { Wallet } from "./wallet";

/** Verify the signature in the transaction we actually export, including when
 * a wallet returns finalized inputs alongside partial signatures. */
export function finalizeVerifiedOfflineHelper(
  expected: btc.Transaction,
  returned: Uint8Array,
  wallet: Wallet,
) {
  const actual = verifySignedPsbt(expected, returned);
  if (
    actual.inputsLength !== 2 ||
    actual.getInput(1).finalScriptWitness?.length
  )
    throw Error("Unexpected QSB input witness.");
  const pub = hex.decode(wallet.publicKey);
  const native = btc.p2wpkh(pub, BITCOIN_NETWORK);
  const nested = btc.p2sh(native, BITCOIN_NETWORK);
  if (wallet.address !== native.address && wallet.address !== nested.address)
    throw Error("Unsupported helper payment address.");
  const expectedScript =
    wallet.address === native.address
      ? new Uint8Array()
      : btc.Script.encode([native.script]);
  const before = actual.getInput(0);
  if (!before.finalScriptWitness?.length) {
    // btc-signer's WPKH finalizer selects partialSig[0]. Never let an unrelated
    // first entry override the matching signature that a verifier selected.
    if (
      before.partialSig?.length !== 1 ||
      hex.encode(before.partialSig[0][0]) !== hex.encode(pub)
    )
      throw Error("Expected exactly one helper partial signature.");
    actual.finalizeIdx(0);
  }
  // Do not finalize index 1: its complete QSB authorization is already final.
  const final = actual.getInput(0),
    witness = final.finalScriptWitness;
  if (
    hex.encode(final.finalScriptSig || new Uint8Array()) !==
    hex.encode(expectedScript)
  )
    throw Error(
      "Final helper scriptSig differs from the expected payment script.",
    );
  if (
    !witness ||
    witness.length !== 2 ||
    hex.encode(witness[1]) !== hex.encode(pub)
  )
    throw Error(
      "Final helper witness does not match the expected payment key.",
    );
  const signature = witness[0];
  const amount = expected.getInput(0).witnessUtxo?.amount;
  if (
    amount === undefined ||
    signature.at(-1) !== 1 ||
    !secp256k1.verify(
      signature.slice(0, -1),
      expected.preimageWitnessV0(0, btc.p2pkh(pub).script, 1, amount),
      pub,
      { prehash: false, format: "der" },
    )
  )
    throw Error("Final Xverse helper signature failed verification.");
  if (
    hex.encode(actual.getInput(1).finalScriptSig || new Uint8Array()) !==
    hex.encode(expected.getInput(1).finalScriptSig || new Uint8Array())
  )
    throw Error("Finalization changed the QSB authorization.");
  return { rawTxHex: hex.encode(actual.extract()), txid: actual.id };
}
