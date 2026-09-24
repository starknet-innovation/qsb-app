import { z } from "zod";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { minerBase } from "./network";
import {
  assertBroadcastPermit,
  assertMainnetTransportClosed,
  assertPermitMinerEndpoint,
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
    // Exact spend authorization is required before any miner HTTP, including
    // the chain probe. A missing permit must not reach the network. The
    // instance base must be the miner origin bound into the permit. A mainnet
    // permit or the mainnet miner host stays refused in this checkout.
    const granted = assertBroadcastPermit(permit, hex);
    assertPermitMinerEndpoint(granted, this.base);
    assertMainnetTransportClosed(granted, this.base);
    await this.assertNetwork();
    return this.request("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_hex: hex }),
    });
  }
}
export const runpodStatusSchema = z.object({
  id: z.string(),
  status: z.enum([
    "IN_QUEUE",
    "IN_PROGRESS",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "TIMED_OUT",
  ]),
  executionTime: z.number().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});
export class Runpod {
  constructor(
    private endpoint: string,
    private key: string,
  ) {
    if (!/^[a-zA-Z0-9_-]+$/.test(endpoint)) throw new Error("Invalid endpoint");
  }
  private request(path: string, body?: unknown) {
    return json(`https://api.runpod.ai/v2/${this.endpoint}/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async health() {
    const count = z.number().int().nonnegative();
    return z
      .object({
        jobs: z.object({
          completed: count,
          failed: count,
          inProgress: count,
          inQueue: count,
          retried: count,
        }),
        workers: z.object({
          idle: count,
          initializing: count,
          ready: count,
          running: count,
          throttled: count,
          unhealthy: count,
        }),
      })
      .parse(await this.request("health"));
  }
  async run(input: unknown) {
    return z.object({ id: z.string() }).parse(
      await this.request("run", {
        input,
        policy: { executionTimeout: 900000, ttl: 86400000 },
      }),
    );
  }
  async status(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid job id");
    // Retry only this read. Paid run/cancel calls and deterministic worker
    // failures never enter this loop. All attempts share one 20-second budget.
    const signal = AbortSignal.timeout(20000);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await fetch(
        `https://api.runpod.ai/v2/${this.endpoint}/status/${id}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${this.key}` },
          signal,
          redirect: "error",
        },
      );
      if (response.ok)
        return runpodStatusSchema.parse(await response.json());
      const retryable = [429, 500, 502, 503, 504].includes(response.status);
      if (!retryable || attempt >= 2)
        throw new Error(`Provider request failed (${response.status})`);
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 250 : 750));
    }
  }
  cancel(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid job id");
    return this.request(`cancel/${id}`, {});
  }
}
export const slipstream = new Slipstream();
