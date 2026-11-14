import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { base64, hex } from "@scure/base";
import { z } from "zod";
import { BITCOIN_NETWORK } from "./network";
import { sats } from "./model";

/**
 * The optional service fee: a fixed USD amount, paid in BTC as a second output of the vault's
 * deposit when the user opts in. The service doesn't require it. It's paid to a P2WPKH address
 * whose key is an AWS KMS secp256k1 key (docs/KEY-CUSTODY.md).
 */
export const SERVICE_FEE_USD = 200;
/** Where the server reads the BTC/USD spot price. */
export const SERVICE_FEE_PRICE_SOURCE = "coinbase";

// DER SubjectPublicKeyInfo for an uncompressed secp256k1 point, as KMS GetPublicKey returns it:
// SEQUENCE { SEQUENCE { id-ecPublicKey, secp256k1 }, BIT STRING (65-byte point) }.
export const SPKI_PREFIX = hex.decode("3056301006072a8648ce3d020106052b8104000a034200");

/** The compressed public key in a KMS ECC_SECG_P256K1 key's DER SubjectPublicKeyInfo. */
export function kmsPublicKey(spki: Uint8Array): Uint8Array {
  if (
    spki.length !== SPKI_PREFIX.length + 65 ||
    hex.encode(spki.subarray(0, SPKI_PREFIX.length)) !== hex.encode(SPKI_PREFIX)
  )
    throw new Error("The service fee key isn't a secp256k1 public key.");
  return secp256k1.Point.fromBytes(spki.subarray(SPKI_PREFIX.length)).toBytes(true);
}

/** The P2WPKH address of a KMS secp256k1 key, from its base64 DER public key. */
export function serviceFeeAddress(spkiBase64: string): string {
  const address = btc.p2wpkh(kmsPublicKey(base64.decode(spkiBase64.trim())), BITCOIN_NETWORK).address;
  if (!address) throw new Error("The service fee key has no address.");
  return address;
}

/** A BTC/USD price as a decimal string. */
export const btcUsdPrice = z
  .string()
  .regex(/^\d{1,9}(\.\d{1,8})?$/, "Invalid BTC/USD price.");

/** SERVICE_FEE_USD in sats at a BTC/USD price, rounded up. */
export function serviceFeeSats(btcUsd: string): bigint {
  const [whole, fraction = ""] = btcUsdPrice.parse(btcUsd).split(".");
  // The price in units of 1e-8 USD, so the division is exact integer arithmetic.
  const scaled = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
  // A floor well under any recent price: a quote below it would charge many times the USD amount.
  if (scaled < 10_000n * 100_000_000n || scaled > 100_000_000n * 100_000_000n)
    throw new Error("The BTC/USD price is outside a plausible range.");
  const numerator = BigInt(SERVICE_FEE_USD) * 100_000_000n * 100_000_000n;
  return (numerator + scaled - 1n) / scaled;
}

/** GET /api/service-fee: what the fee costs now, and where it's paid. */
export const serviceFeeQuoteSchema = z
  .object({
    usd: z.literal(SERVICE_FEE_USD),
    btcUsd: btcUsdPrice,
    source: z.literal(SERVICE_FEE_PRICE_SOURCE),
    sats,
    address: z.string().min(14).max(100),
    quotedAt: z.string().datetime(),
  })
  .strict();
export type ServiceFeeQuote = z.infer<typeof serviceFeeQuoteSchema>;

/** The fee output a deposit adds. */
export type ServiceFeeOutput = { address: string; amount: bigint };

/**
 * Check a quote before it goes into a deposit: its amount is the fixed USD fee at its own
 * price, and it pays a mainnet P2WPKH address. The server picks the price; this only stops a
 * quote that contradicts itself.
 */
export function checkServiceFeeQuote(value: unknown): ServiceFeeQuote & { output: ServiceFeeOutput } {
  const quote = serviceFeeQuoteSchema.parse(value);
  if (BigInt(quote.sats) !== serviceFeeSats(quote.btcUsd))
    throw new Error("The service fee quote's amount doesn't match its price.");
  if (btc.Address(BITCOIN_NETWORK).decode(quote.address).type !== "wpkh")
    throw new Error("The service fee address isn't a mainnet P2WPKH address.");
  return { ...quote, output: { address: quote.address, amount: BigInt(quote.sats) } };
}
