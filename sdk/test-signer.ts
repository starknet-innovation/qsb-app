import * as btc from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Signer as Bip322 } from "bip322-js";
import { BITCOIN_NETWORK } from "../src/lib/network";
import { apiBase, isLoopback, type Signer } from "./signer";

/**
 * A P2WPKH signer holding a raw private key, for tests and local development
 * only. It refuses unless `apiUrl` is loopback (127.0.0.1, localhost or
 * [::1]), and QsbClient refuses to pair it with any other API URL. Use a
 * wallet or an external signer for anything else.
 */
export function loopbackTestSigner(key: Uint8Array | string, apiUrl: string): Signer {
  if (!isLoopback(apiBase(apiUrl)))
    throw new Error("The local test signer only works with a loopback API URL.");
  const privateKey =
    typeof key === "string" ? btc.WIF(BITCOIN_NETWORK).decode(key) : Uint8Array.from(key);
  const publicKey = secp256k1.getPublicKey(privateKey, true);
  const address = btc.p2wpkh(publicKey, BITCOIN_NETWORK).address!;
  const wif = btc.WIF(BITCOIN_NETWORK).encode(privateKey);
  const own = (requested: string) => {
    if (requested !== address) throw new Error("The test signer holds a different address.");
  };
  return {
    address,
    publicKey: hex.encode(publicKey),
    loopbackOnly: true,
    async signMessage(requested, message) {
      own(requested);
      return Bip322.sign(wif, address, message);
    },
    async signPsbt(requested, psbt, inputs) {
      own(requested);
      const tx = btc.Transaction.fromPSBT(base64.decode(psbt), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      });
      for (const index of inputs)
        if (!tx.signIdx(privateKey, index))
          throw new Error(`The test signer cannot sign input ${index}.`);
      return base64.encode(tx.toPSBT());
    },
  };
}
