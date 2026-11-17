import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base64 } from "@scure/base";
import { SPKI_PREFIX } from "../src/lib/service-fee";

/** A stand-in for the KMS fee key: a fixed test private key and its DER public key, as KMS returns it. */
export const SERVICE_FEE_PRIVATE_KEY = new Uint8Array(32).fill(7);
const point = secp256k1.getPublicKey(SERVICE_FEE_PRIVATE_KEY, false);
export const SERVICE_FEE_SPKI = new Uint8Array([
  ...SPKI_PREFIX,
  ...point,
]);
export const SERVICE_FEE_KEY = base64.encode(SERVICE_FEE_SPKI);
