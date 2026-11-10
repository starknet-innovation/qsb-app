import { z } from "zod";
import {
  SERVICE_FEE_PRICE_SOURCE,
  SERVICE_FEE_USD,
  serviceFeeAddress,
  serviceFeeSats,
  type ServiceFeeQuote,
} from "../src/lib/service-fee";

const COINBASE_SPOT = "https://api.coinbase.com/v2/prices/BTC-USD/spot";
const spotSchema = z.object({
  data: z.object({ amount: z.string(), base: z.literal("BTC"), currency: z.literal("USD") }),
});

/** The BTC/USD spot price from Coinbase, as its decimal string. */
export async function coinbaseSpot(request: typeof fetch = fetch): Promise<string> {
  const response = await request(COINBASE_SPOT, {
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`BTC/USD price lookup failed (${response.status}).`);
  return spotSchema.parse(await response.json()).data.amount;
}

export type ServiceFeeDependencies = {
  /** Base64 DER public key of the KMS fee key. The deployment reads QSB_SERVICE_FEE_PUBLIC_KEY. */
  publicKey?: string;
  /** Tests inject a price. */
  price?: () => Promise<string>;
};

/** How long one price read serves quotes, so the public route can't drive a lookup per request. */
export const PRICE_CACHE_MS = 60_000;

/**
 * The deployment's service fee, or undefined when it offers none. A configured key that isn't a
 * secp256k1 public key throws, so a misconfigured deployment fails loudly at start.
 */
export function serviceFee(dependencies: ServiceFeeDependencies = {}, now = () => Date.now()) {
  const publicKey = dependencies.publicKey ?? process.env.QSB_SERVICE_FEE_PUBLIC_KEY ?? "";
  if (!publicKey.trim()) return undefined;
  const address = serviceFeeAddress(publicKey);
  const price = dependencies.price ?? (() => coinbaseSpot());
  // The last price read; a failed read keeps nothing.
  let cached: { btcUsd: string; at: number } | undefined;
  return {
    address,
    async quote(): Promise<ServiceFeeQuote> {
      if (!cached || now() - cached.at >= PRICE_CACHE_MS) cached = { btcUsd: await price(), at: now() };
      const { btcUsd, at } = cached;
      return {
        usd: SERVICE_FEE_USD,
        btcUsd,
        source: SERVICE_FEE_PRICE_SOURCE,
        sats: serviceFeeSats(btcUsd).toString(),
        address,
        // When the price was read.
        quotedAt: new Date(at).toISOString(),
      };
    },
  };
}
