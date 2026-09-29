import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { BITCOIN_NETWORK } from "../src/lib/network";
import { outputScript } from "../src/lib/transactions";
import type { Wallet } from "../src/lib/wallet";

/**
 * The caller's Bitcoin wallet: any BIP-322 message signer and PSBT signer
 * (hardware wallet, HWI, Sparrow, an HSM). The SDK never sees its keys.
 * `address` is the payment address: P2WPKH, or P2SH-P2WPKH (nested SegWit),
 * derived from the compressed `publicKey`. The same address signs in, funds
 * deposits and provides the withdrawal helper input.
 */
export interface Signer {
  readonly address: string;
  readonly publicKey: string;
  /** A BIP-322 signature (base64) of `message` by `address`. */
  signMessage(address: string, message: string): Promise<string>;
  /** Sign `inputs` of a base64 PSBT with `address`'s key and return the PSBT (base64). Never broadcast. */
  signPsbt(address: string, psbt: string, inputs: number[]): Promise<string>;
  /** Set by signers that hold a raw key and may only talk to a local API. */
  readonly loopbackOnly?: true;
}

/** The wallet fields the transaction checks use, after checking the address belongs to the key. */
export function signerWallet(signer: Signer): Wallet {
  outputScript(signer.address); // Checksum and network.
  const native = btc.p2wpkh(hex.decode(signer.publicKey), BITCOIN_NETWORK);
  const nested = btc.p2sh(native, BITCOIN_NETWORK);
  if (signer.address !== native.address && signer.address !== nested.address)
    throw new Error(
      "The signer's address must be the P2WPKH or nested SegWit address of its public key.",
    );
  return {
    address: signer.address,
    publicKey: signer.publicKey,
    type: signer.address === native.address ? "p2wpkh" : "p2sh",
  };
}

/** http(s) origin (optionally with a path) with no credentials, query or fragment. */
export function apiBase(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Use an http(s) API URL without credentials, query or fragment.");
  if (url.protocol === "http:" && !isLoopback(url))
    throw new Error("Use https for a non-local API URL.");
  return url;
}

export function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}
