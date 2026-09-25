import {
  consumeExactSubmitPermit,
  isExactSubmitPermit,
  exactSubmitEnabled,
} from "./exact-submit-permit";
import { z } from "zod";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { minerBase } from "./network";
import {
  transactionId,
  assertBroadcastPermit,
  assertMainnetTransportClosed,
  assertPermitMinerEndpoint,
  MinerInclusionError,
} from "./runtime/miner-inclusion";

const minerSecrets = new SecretsManagerClient({
  region: process.env.AWS_REGION,
});
// The service resolves this at request time. Credentials never leave the HTTP
// transport boundary, appear in responses, or enter application logs.
async function minerAuthorization(): Promise<string | undefined> {
  const arn = process.env.SLIPSTREAM_SECRET_ARN;
  if (!arn) return undefined;
  try {
    const secret = await minerSecrets.send(
      new GetSecretValueCommand({ SecretId: arn }),
    );
    const parsed = z
      .object({
        authorization: z
          .string()
          .min(1)
          .max(8192)
          .regex(/^[\x20-\x7e]+$/),
      })
      .strict()
      .safeParse(JSON.parse(secret.SecretString || "{}"));
    if (!parsed.success) throw new Error("InvalidConfiguration");
    return parsed.data.authorization;
  } catch {
    throw new MinerAuthenticationError(
      "Miner API credential is unavailable. Contact the service operator.",
    );
  }
}
async function json(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Provider request failed (${r.status})`);
  return r.json();
}
const minerTxid = z.string().regex(/^[a-f0-9]{64}$/i);
export const slipstreamStatusSchema = z.object({
  transaction: z.object({
    txid: minerTxid,
    status: z.object({ confirmed: z.boolean() }),
  }),
});
const feeRate = z.number().finite().nonnegative();
export const slipstreamRatesSchema = z.object({
  market_rate: feeRate,
  multiplier: feeRate,
  multiplier_discount_percent: feeRate,
  discounted_multiplier: feeRate,
  submit_fee_rate: feeRate,
  slipstream_rate: feeRate,
  effective_rate: feeRate,
});
export class MinerAuthenticationError extends Error {}
export class Slipstream {
  constructor(
    private base = minerBase,
    private authorization: () => Promise<
      string | undefined
    > = minerAuthorization,
  ) {}
  private async request(path: string, init?: RequestInit) {
    // Teststream is intentionally credential-free. Never resolve or forward the
    // production miner credential to a rehearsal or custom destination.
    const authorization =
      this.base === "https://teststream.mara.com"
        ? undefined
        : await this.authorization();
    if (authorization && this.base !== "https://slipstream.mara.com")
      throw new MinerAuthenticationError(
        "Miner credential destination is invalid.",
      );
    const headers = new Headers(init?.headers);
    if (authorization) headers.set("Authorization", authorization);
    const response = await fetch(`${this.base}${path}`, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401 || response.status === 403)
      throw new MinerAuthenticationError(
        "Miner API authorization is unavailable. Contact the service operator before signing or submitting.",
      );
    if (!response.ok)
      throw new Error(`Miner request failed (${response.status})`);
    return response.json();
  }
  async rates() {
    return slipstreamRatesSchema.parse(await this.request("/api/rates"));
  }
  async status(id: string) {
    minerTxid.parse(id);
    const result = slipstreamStatusSchema.parse(
      await this.request(`/api/transactions/status?tx_id=${id}`),
    );
    if (result.transaction.txid.toLowerCase() !== id.toLowerCase())
      throw new Error("Miner transaction hash mismatch");
    return result;
  }
  private async assertNetwork() {
    if (this.base !== "https://teststream.mara.com") return;
    const system = z
      .object({ chain: z.string() })
      .parse(await this.request("/api/system"));
    if (system.chain !== "testnet4")
      throw new Error(
        "Miner is not serving Bitcoin testnet4. Submission is blocked.",
      );
  }
  async test(hex: string) {
    await this.assertNetwork();
    return this.request("/api/mempool/tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_hexes: [hex] }),
    });
  }
  async submit(hex: string, permit: unknown) {
    if (isExactSubmitPermit(permit)) {
      consumeExactSubmitPermit(permit, hex);
      if (!exactSubmitEnabled()) throw new Error("ExactSubmitDisabled");
      if (this.base !== "https://slipstream.mara.com")
        throw new Error("ExactSubmitMinerMismatch");
      const result = z
        .object({ status: z.literal("success"), message: minerTxid })
        .parse(
          await this.request("/api/transactions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tx_hex: hex }),
          }),
        );
      if (result.message.toLowerCase() !== transactionId(hex))
        throw new Error("Miner transaction hash mismatch");
      return result;
    }

    // Exact spend authorization is required before any miner HTTP, including
    // the chain probe. A missing permit must not reach the network. The
    // instance base must be the miner origin bound into the permit. A mainnet
    // permit or the mainnet miner host stays refused in this checkout.
    const granted = assertBroadcastPermit(permit, hex);
    assertPermitMinerEndpoint(granted, this.base);
    assertMainnetTransportClosed(granted, this.base);
    // A permit whose origin matches this base is still not a live submit.
    // This checkout does not probe or POST to the miner.
    throw new MinerInclusionError("LiveMinerTransportRefused");
  }
}
export const slipstream = new Slipstream();
