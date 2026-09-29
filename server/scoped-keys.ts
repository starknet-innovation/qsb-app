import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { matchedRoutes } from "hono/route";
import { z } from "zod";
import { NETWORK_ID } from "../src/lib/network";
import { Conflict, type Row, type Store } from "./store";
import { apiError } from "./api-errors";

// API keys are minted with a BIP-322 wallet session and act for that owner.
// Only the key's SHA-256 is stored, like sessions.
export const apiKeyScopes = [
  "read",
  "vaults",
  "withdrawals",
  "submit",
] as const;
export type ApiKeyScope = (typeof apiKeyScopes)[number];
export const maxActiveApiKeys = 10;
export const defaultApiKeyDays = 30;
export const apiKeyRequest = z
  .object({
    name: z.string().trim().min(1).max(64),
    scopes: z.array(z.enum(apiKeyScopes)).min(1).max(apiKeyScopes.length),
    expiresInDays: z.number().int().min(1).max(90).optional(),
  })
  .strict();
/** The body is optional; a missing or unparsable body counts as `{}`. */
export const apiKeyRevokeRequest = z.object({}).strict();
export const apiKeyIdParam = z.string().uuid();

/**
 * The scope an API key needs on each authenticated route, by method and route
 * pattern. `null` routes take a wallet session only. API keys are refused on
 * any route missing here.
 */
export const routeScopes: Readonly<Record<string, ApiKeyScope | null>> = {
  "GET /api/vaults": "read",
  "GET /api/vaults/:id/funding": "read",
  "GET /api/vaults/:id/fund/signed": "read",
  "GET /api/transactions/:id/status": "read",
  "GET /api/jobs": "read",
  "GET /api/jobs/:id/status": "read",
  "GET /api/jobs/:id/solved-result": "read",
  // Chain lookups for the owner's payment address and helper input; no record is written.
  "GET /api/payment-utxos": "read",
  "POST /api/payment-input": "read",
  "POST /api/vaults": "vaults",
  "POST /api/vaults/:id/fund": "vaults",
  "POST /api/vaults/:id/fund/submit": "vaults",
  "POST /api/vaults/:id/fund/resubmit": "vaults",
  "POST /api/jobs": "withdrawals",
  "POST /api/jobs/:id/pause": "withdrawals",
  "POST /api/jobs/:id/resume": "withdrawals",
  "POST /api/jobs/:id/submit": "submit",
  // The owner's event log and webhooks. A webhook's registration returns its signing secret
  // and decides where the owner's notifications go, so it and deletion need a wallet session.
  "GET /api/events": "read",
  "GET /api/webhooks": "read",
  "POST /api/webhooks": null,
  "POST /api/webhooks/:id/delete": null,
  "GET /api/api-keys": null,
  "POST /api/api-keys": null,
  "POST /api/api-keys/:id/revoke": null,
};

const bearerKey = /^Bearer (qsb_(mainnet|testnet4)_[A-Za-z0-9_-]{43})$/;
// SHA-256, not a password KDF: a key is 32 random bytes, not a user-chosen
// password, and its hash is the deterministic lookup key, as for SESSION# tokens.
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type OwnerEnv = { Variables: { owner: string } };
const disabled = (c: Context) =>
  apiError(
    c,
    503,
    "api_keys_disabled",
    "API keys are switched off for this deployment.",
  );

/** Deploy-time switch, off by default. Turning it on needs the maintainer's explicit approval. */
export function apiKeysEnabled() {
  return process.env.QSB_API_KEYS_ENABLED === "true";
}

/** The API key in an Authorization header, or undefined for any other bearer. */
export function bearerApiKey(header: string) {
  return bearerKey.exec(header)?.[1];
}

/**
 * Resolves the key's owner and checks the scope of every route the request
 * matches. Returns the refusal, if any.
 */
export async function authorizeApiKey(
  c: Context<OwnerEnv>,
  store: Store,
  key: string,
  enabled: boolean,
): Promise<Response | undefined> {
  if (!enabled) return disabled(c);
  const wrongNetwork = () =>
    apiError(
      c,
      401,
      "network_mismatch",
      "API key belongs to a different Bitcoin network.",
    );
  if (!key.startsWith(`qsb_${NETWORK_ID}_`)) return wrongNetwork();
  const row = await store.get(`APIKEY#${hash(key)}`, "AUTH");
  if (!row)
    return apiError(
      c,
      401,
      "api_key_invalid",
      "API key is not valid or has expired.",
    );
  if (row.network !== NETWORK_ID) return wrongNetwork();
  if (row.revoked === true)
    return apiError(c, 401, "api_key_revoked", "API key was revoked.");
  // Every matched method route counts, not only the one that answers: a
  // pass-through route registered earlier cannot lower the scope needed.
  const scopes = matchedRoutes(c)
    .filter((r) => r.method !== "ALL")
    .map((r) => `${r.method} ${r.path}`)
    .map((p) => (Object.hasOwn(routeScopes, p) ? routeScopes[p] : null));
  if (!scopes.length || scopes.some((s) => !s))
    return apiError(
      c,
      403,
      "api_key_not_allowed",
      "API keys cannot call this route. Use a wallet session.",
    );
  const missing = scopes.find((s) => !(row.scopes as string[]).includes(s!));
  if (missing)
    return apiError(
      c,
      403,
      "api_key_scope_denied",
      `API key lacks the ${missing} scope.`,
    );
  c.set("owner", row.owner as string);
}

/**
 * The owner a live API key acts for, or undefined. For a public route that
 * reports the caller's standing; it checks no scope and authorizes nothing.
 */
export async function apiKeyOwner(
  store: Store,
  key: string,
  enabled: boolean,
): Promise<string | undefined> {
  if (!enabled || !key.startsWith(`qsb_${NETWORK_ID}_`)) return;
  const row = await store.get(`APIKEY#${hash(key)}`, "AUTH");
  if (row?.network === NETWORK_ID && row.revoked !== true)
    return row.owner as string;
}

export type ApiKeyMetadata = ReturnType<typeof metadata>;
function metadata(row: Row, now: number) {
  const status: "active" | "expired" | "revoked" =
    row.revoked === true
      ? "revoked"
      : (row.expiresAt as number) <= now
        ? "expired"
        : "active";
  return {
    id: row.id as string,
    name: row.name as string,
    scopes: row.scopes as ApiKeyScope[],
    network: row.network as string,
    createdAt: row.createdAt as string,
    expiresAt: new Date((row.expiresAt as number) * 1000).toISOString(),
    ...(typeof row.revokedAt === "string" ? { revokedAt: row.revokedAt } : {}),
    status,
  };
}

/**
 * Key management. The auth middleware admits wallet sessions only here (see
 * routeScopes). Listing and revocation stay available while keys are off.
 */
export function installApiKeyRoutes(
  app: Hono<OwnerEnv>,
  store: Store,
  enabled: boolean,
) {
  app.post("/api/api-keys", async (c) => {
    if (!enabled) return disabled(c);
    const body = apiKeyRequest.parse(await c.req.json());
    const owner = c.get("owner"),
      pk = `OWNER#${owner}`,
      now = Math.floor(Date.now() / 1000);
    // Every issuance bumps this row, so concurrent issuances conflict and the cap holds.
    const fence = await store.get(pk, "APIKEYS");
    const active = (await store.list(pk, "APIKEY#")).filter(
      (r) => r.revoked !== true && (r.expiresAt as number) > now,
    );
    if (active.length >= maxActiveApiKeys)
      return apiError(
        c,
        409,
        "api_key_limit_reached",
        `This owner already has ${maxActiveApiKeys} active API keys. Revoke one first.`,
      );
    const key = `qsb_${NETWORK_ID}_${randomBytes(32).toString("base64url")}`,
      keyHash = hash(key);
    const fields = {
      id: randomUUID(),
      scopes: apiKeyScopes.filter((s) => body.scopes.includes(s)),
      network: NETWORK_ID,
      createdAt: new Date(now * 1000).toISOString(),
      expiresAt: now + (body.expiresInDays ?? defaultApiKeyDays) * 86400,
      revoked: false,
    };
    const listing: Row = {
      pk,
      sk: `APIKEY#${fields.id}`,
      version: 0,
      ...fields,
      name: body.name,
      keyHash,
    };
    await store.atomicPut([
      {
        row: {
          pk: `APIKEY#${keyHash}`,
          sk: "AUTH",
          version: 0,
          ...fields,
          owner,
        },
      },
      { row: listing },
      fence
        ? {
            row: { ...fence, version: fence.version + 1 },
            expected: fence.version,
          }
        : { row: { pk, sk: "APIKEYS", version: 0 } },
    ]);
    c.header("Cache-Control", "no-store");
    return c.json({ key, apiKey: metadata(listing, now) }, 201);
  });
  app.get("/api/api-keys", async (c) => {
    const now = Math.floor(Date.now() / 1000);
    const keys = (await store.list(`OWNER#${c.get("owner")}`, "APIKEY#"))
      .map((r) => metadata(r, now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return c.json({ apiKeys: keys });
  });
  app.post("/api/api-keys/:id/revoke", async (c) => {
    const id = apiKeyIdParam.parse(c.req.param("id"));
    apiKeyRevokeRequest.parse(await c.req.json().catch(() => ({})));
    const now = Math.floor(Date.now() / 1000);
    const pk = `OWNER#${c.get("owner")}`,
      sk = `APIKEY#${id}`;
    const listing = await store.get(pk, sk);
    const lookup =
      listing &&
      (await store.get(`APIKEY#${listing.keyHash as string}`, "AUTH"));
    if (!listing || !lookup)
      return apiError(
        c,
        404,
        "api_key_not_found",
        "API key not found or already expired.",
      );
    if (listing.revoked === true)
      return c.json({ apiKey: metadata(listing, now) });
    const revoked = {
      revoked: true,
      revokedAt: new Date(now * 1000).toISOString(),
    };
    const next = { ...listing, ...revoked, version: listing.version + 1 };
    try {
      await store.atomicPut([
        {
          row: { ...lookup, ...revoked, version: lookup.version + 1 },
          expected: lookup.version,
        },
        { row: next, expected: listing.version },
      ]);
    } catch (e) {
      // A concurrent revocation won: return its result, so retries stay idempotent.
      const current = e instanceof Conflict && (await store.get(pk, sk));
      if (current && current.revoked === true)
        return c.json({ apiKey: metadata(current, now) });
      throw e;
    }
    return c.json({ apiKey: metadata(next, now) });
  });
}
