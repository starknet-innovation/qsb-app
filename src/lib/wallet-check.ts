import { BITCOIN_NETWORK } from "./network";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  fundingPsbt,
  helperPsbt,
  outputScript,
  verifySignedPsbt,
} from "./transactions";
import type { Wallet } from "./wallet";

export type WalletCheckKind = "funding" | "helper" | "full-stack";
const options = { allowUnknownInputs: true, allowUnknownOutputs: true };

/** Config A stack layout from qsb_pipeline.cmd_assemble: round 2, round 1,
 * then pin keys. All data is disposable; no HORS authorization is revealed.
 * This is a FORMAT probe, not a solved QSB spend. */
export function disposableAuthorizationStack(): Uint8Array {
  const pub = secp256k1.getPublicKey(new Uint8Array(32).fill(23));
  const items: (Uint8Array | number)[] = [];
  for (const secrets of [7, 8]) {
    items.push(pub, pub);
    for (let i = 0; i < 9; i++) items.push(pub);
    for (let i = 0; i < secrets; i++) items.push(new Uint8Array(20).fill(i + 1));
    // Disposable high Script numbers exercise multi-byte encoding. Real
    // Config A authorization uses model-derived witness depths here.
    for (let i = 149; i >= 141; i--) items.push(i);
  }
  items.push(pub, pub);
  return btc.Script.encode(items);
}

/** The one-byte coinbase scriptSig violates Bitcoin consensus (minimum 2).
 * Its outputs can never be confirmed. Never substitute real UTXOs here. */
export function walletCheckFixture(
  wallet: Wallet,
  scriptHex: string,
  kind: WalletCheckKind,
) {
  const parent = new btc.Transaction({ ...options, version: 2 });
  parent.addInput({
    txid: "00".repeat(32),
    index: 0xffffffff,
  });
  parent.addOutput({ amount: 1000000n, script: outputScript(wallet.address) });
  parent.addOutput({ amount: 100000n, script: hex.decode(scriptHex) });
  parent.updateInput(0, { finalScriptSig: Uint8Array.of(0) }, true);
  const parentRaw = parent.toBytes(true, true);
  const payment = {
    txid: parent.id,
    vout: 0,
    value: 1000000n,
    previousTxHex: hex.encode(parentRaw),
    publicKey: wallet.publicKey,
    address: wallet.address,
  };
  if (kind === "funding")
    return {
      parentRaw,
      payment,
      transaction: fundingPsbt(
        [payment],
        scriptHex,
        100000n,
        10000n,
        wallet.address,
      ),
    };
  const withdrawal = new btc.Transaction({
    ...options,
    version: 1,
    lockTime: 500000000,
  });
  withdrawal.addInput({ txid: parent.id, index: 0, sequence: 0xfffffffe });
  // Deliberately invalid placeholder, never a real HORS authorization.
  withdrawal.addInput({
    txid: parent.id,
    index: 1,
    sequence: 0x80000000,
  });
  withdrawal.addOutputAddress(wallet.address, 1090000n, BITCOIN_NETWORK);
  withdrawal.updateInput(1, {
    finalScriptSig: kind === "full-stack" ? disposableAuthorizationStack() : Uint8Array.of(0),
  }, true);
  return {
    parentRaw,
    payment,
    transaction: helperPsbt(
      hex.encode(withdrawal.toBytes(true, true)),
      payment,
      hex.encode(parentRaw),
    ),
  };
}

/** Verify an actual signature, not just the wallet's success response. */
export function verifyWalletCheck(
  fixture: ReturnType<typeof walletCheckFixture>,
  returned: Uint8Array,
  wallet: Wallet,
) {
  const actual = verifySignedPsbt(fixture.transaction, returned);
  const input = actual.getInput(0),
    pub = hex.decode(wallet.publicKey);
  const partial = input.partialSig?.find(
    ([key]) => hex.encode(key) === wallet.publicKey.toLowerCase(),
  );
  const witness = input.finalScriptWitness;
  const signature =
    partial?.[1] ||
    (witness?.length === 2 && hex.encode(witness[1]) === hex.encode(pub)
      ? witness[0]
      : undefined);
  if (!signature || signature[signature.length - 1] !== 1)
    throw Error("Wallet did not return a SIGHASH_ALL payment signature.");
  const digest = fixture.transaction.preimageWitnessV0(
    0,
    btc.p2pkh(pub).script,
    1,
    fixture.payment.value,
  );
  if (
    !secp256k1.verify(signature.slice(0, -1), digest, pub, {
      prehash: false,
      format: "der",
    })
  )
    throw Error("Wallet signature verification failed.");
  return {
    signatureVerified: true,
    transactionUnchanged: true,
    synthetic: true,
    broadcast: false,
  } as const;
}
