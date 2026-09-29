import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { Conflict, type Row, type Store } from "./store";

/**
 * POSTs that accept an optional Idempotency-Key header, under /api and /v1. POST /jobs keeps the
 * manifest's idempotencyKey; /auth/* runs before there is an owner. See docs/API.md.
 */
export const idempotentPosts = [
  "/vaults",
  "/vaults/:id/fund",
  "/vaults/:id/fund/submit",
  "/vaults/:id/fund/resubmit",
  "/jobs/:id/submit",
  "/jobs/:id/pause",
  "/jobs/:id/resume",
];
const keyPattern = /^[A-Za-z0-9_-]{8,128}$/;
const retentionSeconds = 24 * 3600;
/** Longer than the API Lambda's timeout (terraform/compute.tf), so a live request is never taken over. */
export const leaseSeconds = 150;
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const seconds = () => Math.floor(Date.now() / 1000);

/** Only a 2xx that settles the outcome is replayed. Errors and "uncertain" outcomes reach the handler again. */
function settled(status: number, body: string) {
  if (status < 200 || status > 299) return false;
  try {
    const value = JSON.parse(body) as { submission?: unknown; status?: unknown };
    return value.submission !== "uncertain" && value.status !== "uncertain";
  } catch {
    return false;
  }
}

/** store.get hides a row past expiresAt until DynamoDB's TTL deletes it; list returns it, so it can be replaced. */
async function stored(store: Store, pk: string, sk: string) {
  return (await store.list(pk, sk)).find((row) => row.sk === sk);
}

/**
 * The key is bound to (owner, route, key) and the request's path and body for 24 hours. This layer only
 * ever skips the handler: it replays a settled response, or refuses. When no settled response is
 * stored, a retry runs the handler exactly as a request without the header would, so the handler's own
 * intent rules decide whether anything is sent to the miner.
 */
export function idempotency(
  store: Store,
  route: string,
): MiddlewareHandler<{ Variables: { owner: string } }> {
  return async (c, next) => {
    const key = c.req.header("Idempotency-Key");
    if (key === undefined) return next();
    if (!keyPattern.test(key))
      return c.json(
        {
          error: "Idempotency-Key must be 8 to 128 letters, digits, '-' or '_'.",
          code: "idempotency_key_invalid",
        },
        400,
      );
    const pk = `OWNER#${c.get("owner")}`,
      sk = `IDEMPOTENCY#${route}#${key}`;
    // c.req.path is the /api form of a /v1 request, so both prefixes share a key.
    const fingerprint = sha256(JSON.stringify([c.req.path, await c.req.text()]));
    const inProgress = (retryAfter: number) => {
      c.header("Retry-After", String(Math.max(1, retryAfter)));
      return c.json(
        {
          error: "A request with this Idempotency-Key is still in progress.",
          code: "idempotency_in_progress",
        },
        409,
      );
    };
    let lease: Row | undefined;
    for (let attempt = 0; attempt < 2 && !lease; attempt++) {
      const now = seconds(),
        row = await stored(store, pk, sk);
      const live = row && typeof row.expiresAt === "number" && row.expiresAt > now;
      if (live) {
        if (row.fingerprint !== fingerprint)
          return c.json(
            {
              error: "This Idempotency-Key was already used for a different request.",
              code: "idempotency_conflict",
            },
            409,
          );
        const response = row.response as { status: number; body: string } | undefined;
        if (response)
          return c.body(response.body, response.status as ContentfulStatusCode, {
            "Content-Type": "application/json",
            "Idempotency-Replayed": "true",
          });
        const leaseUntil = Number(row.leaseUntil) || 0;
        if (leaseUntil > now) return inProgress(leaseUntil - now);
      }
      // A new key, or a lease that ended without a settled response (an error, an uncertain outcome,
      // or a request that never finished).
      const claim: Row = live
        ? { ...row, version: row.version + 1, leaseUntil: now + leaseSeconds }
        : {
            pk,
            sk,
            version: row ? row.version + 1 : 0,
            route,
            fingerprint,
            leaseUntil: now + leaseSeconds,
            expiresAt: now + retentionSeconds,
          };
      try {
        await store.put(claim, row?.version);
        lease = claim;
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
    if (!lease) return inProgress(leaseSeconds);
    await next();
    const status = c.res.status,
      body = await c.res.clone().text();
    try {
      await store.put(
        {
          ...lease,
          version: lease.version + 1,
          ...(settled(status, body) ? { response: { status, body } } : { leaseUntil: 0 }),
        },
        lease.version,
      );
    } catch (error) {
      // Keep the handler's response. An unrecorded lease lapses after leaseSeconds.
      console.error(
        JSON.stringify({ error: (error as Error).name, route, idempotency: "unrecorded" }),
      );
    }
  };
}
