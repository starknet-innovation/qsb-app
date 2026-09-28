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
// The service resolves this at request time. The value never leaves this module: callers
// only hold an opaque MinerCredential, and it never appears in responses or logs.
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
// MARA answers a transaction it holds but hasn't mined yet (e.g. a Slipstream submission) with
// only this acknowledgement, no transaction details. Observed live on 2026-09-27; any other
// acknowledgement fails closed.
export const slipstreamPendingSchema = z.object({
  is_success: z.literal(true),
  submission_type: z.literal("tx_submission"),
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
const issuing = Symbol("MinerCredential");
const credentialValues = new WeakMap<MinerCredential, { origin: string; authorization: string | undefined }>();
/**
 * A miner credential resolved once for one submission, issued only by Slipstream.credential().
 * It is opaque: the value lives in this module, so callers can't read, spread, log or serialize
 * it, and only a request to the origin it was issued for can use it.
 */
export class MinerCredential {
  constructor(key: typeof issuing, origin: string, authorization: string | undefined) {
    if (key !== issuing) throw new TypeError("A MinerCredential is issued only by Slipstream.credential().");
    credentialValues.set(this, { origin, authorization });
  }
  toJSON() {
    return "[MinerCredential]";
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "MinerCredential [redacted]";
  }
}
/** The Authorization header value for a request to `origin`, if the credential carries one. */
function authorizationFor(credential: MinerCredential, origin: string) {
  const value = credentialValues.get(credential);
  if (!value || value.origin !== origin)
    throw new MinerAuthenticationError("Miner credential destination is invalid.");
  return value.authorization;
}
/** A non-2xx miner response. `detail` is the miner's own message, when it sent one. */
export class MinerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail?: string,
    /** The body's own `status` field, e.g. "error" on a Slipstream refusal. */
    readonly minerStatus?: string,
  ) {
    super(`Miner request failed (${status})`);
  }
}
/** The miner definitively refused a submission (HTTP 400, status "error"); nothing was accepted. */
export class MinerRejection extends Error {}
export class Slipstream {
  constructor(
    private base = minerBase,
    private authorization: () => Promise<
      string | undefined
    > = minerAuthorization,
  ) {}
  /**
   * Resolve the miner credential ahead of a submission. Callers read it before recording any
   * intent, so a failure here has sent nothing, and pass it to the POST so it can't fail later.
   */
  async credential(): Promise<MinerCredential> {
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
    return new MinerCredential(issuing, this.base, authorization);
  }
  private async request(path: string, init?: RequestInit, credential?: MinerCredential) {
    const authorization = authorizationFor(credential ?? (await this.credential()), this.base);
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
    if (!response.ok) {
      let detail: string | undefined, minerStatus: string | undefined;
      try {
        const body = (await response.json()) as { message?: unknown; status?: unknown };
        if (typeof body.message === "string") detail = body.message.slice(0, 300);
        if (typeof body.status === "string") minerStatus = body.status;
      } catch { /* A body that isn't JSON carries no detail. */ }
      throw new MinerHttpError(response.status, detail, minerStatus);
    }
    return response.json();
  }
  async rates() {
    return slipstreamRatesSchema.parse(await this.request("/api/rates"));
  }
  async status(id: string, credential?: MinerCredential) {
    minerTxid.parse(id);
    const body = await this.request(`/api/transactions/status?tx_id=${id}`, undefined, credential);
    // Held but not mined: MARA knows it, so report it seen and unconfirmed.
    if (slipstreamPendingSchema.safeParse(body).success && !("transaction" in body))
      return { transaction: { txid: id.toLowerCase(), status: { confirmed: false } }, pending: true as const };
    const result = slipstreamStatusSchema.parse(body);
    if (result.transaction.txid.toLowerCase() !== id.toLowerCase())
      throw new Error("Miner transaction hash mismatch");
    return result;
  }
  /** Whether the miner knows this transaction. It answers 400 "Transaction not found" for unknown ones. */
  async seen(id: string, credential?: MinerCredential): Promise<boolean> {
    try {
      await this.status(id, credential);
      return true;
    } catch (error) {
      if (error instanceof MinerHttpError && error.status === 400 && /not found/i.test(error.detail ?? ""))
        return false;
      throw error;
    }
  }
  /** POST exact bytes under a live permit, only to mainnet Slipstream with both switches on. */
  private async postExact(hex: string, permit: unknown, credential?: MinerCredential) {
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
        }, credential),
      );
    if (result.message.toLowerCase() !== transactionId(hex))
      throw new Error("Miner transaction hash mismatch");
    return result;
  }
  /**
   * Submit a signed deposit. Its bare QSB output is non-standard, so public relay refuses it.
   * Only a 400 whose body says status "error" is a refusal (MinerRejection). Any other
   * failure leaves the outcome unknown.
   */
  async submitFunding(hex: string, permit: unknown, credential?: MinerCredential) {
    if (!isExactSubmitPermit(permit)) throw new Error("ExactSubmitPermitRequired");
    try {
      return await this.postExact(hex, permit, credential);
    } catch (error) {
      if (error instanceof MinerHttpError && error.status === 400 && error.minerStatus === "error")
        throw new MinerRejection(error.detail ?? "The miner refused the transaction.");
      throw error;
    }
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
  async submit(hex: string, permit: unknown, credential?: MinerCredential) {
    if (isExactSubmitPermit(permit)) return this.postExact(hex, permit, credential);

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
