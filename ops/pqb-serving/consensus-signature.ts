/** Mutate only PQB's final co-signature, even when earlier stack items are DER signatures. */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { equal, hash160 } from "../../src/pqb-core/primitives";
import { COSIG_HASHTYPE, cosigHashInScript } from "../../src/pqb-core/spend";
import { parseScript } from "../../src/pqb-core/tx";

export function mutateCoSignature(scriptSig: Uint8Array, vaultScript: Uint8Array): Uint8Array {
  const pushes = parseScript(scriptSig), signature = pushes.at(-2), key = pushes.at(-1)?.[2];
  const data = signature?.[2];
  if (!signature || !data || !key || key.length !== 33 || ![2, 3].includes(key[0])
    || !equal(hash160(key), cosigHashInScript(vaultScript)) || data.length < 9 || data.length > 73
    || data.at(-1) !== COSIG_HASHTYPE) throw Error("Invalid final PQB co-signature/key layout");
  secp256k1.Signature.fromBytes(data.subarray(0, -1), "der");
  const result = scriptSig.slice();
  // The final S byte precedes SIGHASH_ALL. Preserve the push, DER lengths and public key.
  result[signature[0] + signature[3] - 2] ^= 1;
  return result;
}
