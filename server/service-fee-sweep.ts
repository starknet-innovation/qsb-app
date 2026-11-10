import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import { BITCOIN_NETWORK } from "../src/lib/network";
import { kmsPublicKey } from "../src/lib/service-fee";
import { outputScript } from "../src/lib/transactions";

/** Bitcoin Core's dust limit for its largest standard output type (P2PKH), so any destination is standard. */
const DUST = 546n;
/** The administrator-created fee key (ops/service-fee-key; the same alias in render.py and compute.tf). */
export const SERVICE_FEE_KEY_ALIAS = "alias/qsb/service-fee";
const opts = { allowUnknownOutputs: true, allowUnknownInputs: true };

/** The fee key: its compressed public key, and an ECDSA signature (DER) over a 32-byte digest. */
export type FeeKeySigner = {
  publicKey(): Promise<Uint8Array>;
  sign(digest: Uint8Array): Promise<Uint8Array>;
};

/** The KMS fee key. Signing needs kms:Sign, which its key policy gives only the named signer roles (signed in through IAM Identity Center). */
export function kmsFeeKey(client = new KMSClient({}), keyId = SERVICE_FEE_KEY_ALIAS): FeeKeySigner {
  return {
    async publicKey() {
      const answer = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (answer.KeySpec !== "ECC_SECG_P256K1" || answer.KeyUsage !== "SIGN_VERIFY" || !answer.PublicKey)
        throw new Error(`${keyId} isn't an ECC_SECG_P256K1 signing key.`);
      return kmsPublicKey(answer.PublicKey);
    },
    async sign(digest) {
      const answer = await client.send(
        new SignCommand({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }),
      );
      if (!answer.Signature) throw new Error("KMS returned no signature.");
      return answer.Signature;
    },
  };
}

export type FeeUtxo = { txid: string; vout: number; value: bigint };

/** Signed vsize of a sweep: P2WPKH inputs (72-byte DER maximum) and one output. An upper bound. */
export function sweepVsize(inputCount: number, outputScriptLength: number): number {
  const varint = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);
  const base = 4 + varint(inputCount) + inputCount * 41 + 1 + 8 + varint(outputScriptLength) + outputScriptLength + 4;
  const witness = 2 + inputCount * (1 + 1 + 72 + 1 + 33);
  return Math.ceil((base * 4 + witness) / 4);
}

/**
 * An unsigned transaction moving every given fee-address output to `destination`, less the miner fee
 * at `milliSatPerVb`. One output, no change.
 */
export function buildSweep(utxos: FeeUtxo[], publicKey: Uint8Array, destination: string, milliSatPerVb: bigint) {
  if (!utxos.length) throw new Error("The fee address has no confirmed outputs to move.");
  if (milliSatPerVb <= 0n) throw new Error("The fee rate must be positive.");
  const script = btc.p2wpkh(publicKey, BITCOIN_NETWORK).script;
  const to = outputScript(destination);
  const tx = new btc.Transaction({ ...opts, version: 2 });
  const seen = new Set<string>();
  let total = 0n;
  for (const utxo of utxos) {
    const key = `${utxo.txid}:${utxo.vout}`;
    if (seen.has(key)) throw new Error("Duplicate input.");
    seen.add(key);
    tx.addInput({ txid: utxo.txid, index: utxo.vout, sequence: 0xfffffffd, witnessUtxo: { script, amount: utxo.value } });
    total += utxo.value;
  }
  const vsize = sweepVsize(utxos.length, to.length);
  const fee = (BigInt(vsize) * milliSatPerVb + 999n) / 1000n;
  const amount = total - fee;
  if (amount < DUST) throw new Error("After the miner fee, the amount would be below the dust limit.");
  // A guard against a mistyped rate: the miner fee may take at most a tenth of what's moved.
  if (fee * 10n > total) throw new Error(`The miner fee, ${fee} sats, would be over 10% of the ${total} sats moved. Check the fee rate.`);
  tx.addOutput({ script: to, amount });
  return { tx, total, fee, amount, vsize };
}

/** A DER signature from KMS as Bitcoin needs it: low-S, checked against the key and digest. */
function bitcoinSignature(der: Uint8Array, digest: Uint8Array, publicKey: Uint8Array): Uint8Array {
  let signature = secp256k1.Signature.fromBytes(der, "der");
  if (signature.hasHighS()) signature = new secp256k1.Signature(signature.r, secp256k1.Point.Fn.ORDER - signature.s);
  if (!secp256k1.verify(signature.toBytes("compact"), digest, publicKey, { prehash: false, lowS: true }))
    throw new Error("The key's signature doesn't verify against the fee address's public key.");
  return signature.toBytes("der");
}

/** Sign every input with SIGHASH_ALL through `signer`, verify each signature, and finalize. */
export async function signSweep(tx: btc.Transaction, publicKey: Uint8Array, signer: FeeKeySigner): Promise<btc.Transaction> {
  const scriptCode = btc.OutScript.encode({ type: "pkh", hash: btc.p2wpkh(publicKey).hash });
  for (let i = 0; i < tx.inputsLength; i++) {
    const amount = tx.getInput(i).witnessUtxo?.amount;
    if (amount === undefined) throw new Error("A sweep input has no amount.");
    const digest = tx.preimageWitnessV0(i, scriptCode, btc.SigHash.ALL, amount);
    const signature = bitcoinSignature(await signer.sign(digest), digest, publicKey);
    tx.updateInput(i, { partialSig: [[publicKey, new Uint8Array([...signature, btc.SigHash.ALL])]] });
  }
  tx.finalize();
  return tx;
}

/** The finished sweep, for the operator to review and broadcast themselves. */
export function sweepReport(tx: btc.Transaction, details: { total: bigint; fee: bigint; amount: bigint }, destination: string) {
  return {
    txid: tx.id,
    destination,
    inputs: tx.inputsLength,
    total: details.total.toString(),
    fee: details.fee.toString(),
    amount: details.amount.toString(),
    vsize: tx.vsize,
    rawTxHex: hex.encode(tx.extract()),
  };
}
