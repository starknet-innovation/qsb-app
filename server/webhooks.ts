import { createHmac, randomBytes } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { ApiErrorCode } from "./api-errors";
import type { EventType } from "./api-schemas";
import type { OwnerEvent } from "./owner-events";
import { Conflict, type Row, type Store } from "./store";

export class Timeout extends Error {}
/** Settle with `work`, or reject with Timeout after `ms`. The work itself isn't cancelled. */
export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout()), Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
}

export const WEBHOOK_LIMIT = 5;
/** Queued deliveries per owner; the oldest are dropped first. The pull endpoint still has them. */
const PENDING_LIMIT = 100;
/** Attempts per event, and consecutive failed rounds before a webhook is marked failing. */
export const MAX_ATTEMPTS = 8;
export const FAILING_AFTER = 8;
/** Wait before a webhook's next round after 1, 2, ... consecutive failed rounds. */
export const RETRY_DELAYS_MS = [30e3, 120e3, 600e3, 1800e3, 3600e3, 7200e3, 14400e3];
export const REQUEST_TIMEOUT_MS = 3000;
/** Deliveries a round claims, so two flushes don't send the same ones. Longer than any flush. */
export const LEASE_MS = 30_000;
export const ROUND_LIMIT = 10;

/**
 * An owner's webhooks live in their own partition, WEBHOOK#<owner> / WEBHOOKS, apart from the
 * owner's OWNER# rows (jobs, vaults, intents, events), so a role can be granted webhook rows and
 * nothing else by partition key. Nothing was deployed under the old OWNER#<owner> / WEBHOOKS key.
 */
export const WEBHOOK_PARTITION = "WEBHOOK#";
/**
 * The due-delivery index: a sparse, keys-only global secondary index of the WEBHOOKS rows
 * (terraform/data.tf). A row is in it, under WEBHOOK_DUE_QUEUE and sorted by webhookDueAt,
 * exactly while it holds a delivery an active webhook can send. update() sets both attributes
 * from the row's own queue on every write, so the index can't disagree with the row it was
 * written with, and keeping it adds no request.
 */
export const WEBHOOK_DUE_INDEX = "webhook-due";
export const WEBHOOK_DUE_QUEUE = "due";

export type WebhookRequest = {
  url: string;
  hostname: string;
  /** The checked address to connect to. The transport must not resolve the name again. */
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};
export type WebhookTransport = (request: WebhookRequest) => Promise<{ status: number }>;
/** Every A and AAAA answer for `hostname`, given up after `timeoutMs`. */
export type Resolver = (
  hostname: string,
  timeoutMs: number,
) => Promise<{ address: string; family: number }[]>;
export type Delivery = { transport: WebhookTransport; resolve: Resolver };

type Hook = {
  id: string;
  url: string;
  events?: EventType[];
  /** Kept to sign deliveries. Returned once, at registration; never logged or listed. */
  secret: string;
  createdAt: string;
  status: "active" | "failing";
  failures: number;
  retryAt?: number;
  lastDeliveryAt?: string;
  lastFailureAt?: string;
  lastError?: string;
};
type Pending = {
  hook: string;
  event: OwnerEvent;
  attempts: number;
  nextAt: number;
  /** The round that holds this delivery until nextAt. */
  claim?: string;
};
type WebhookRow = Row & {
  hooks: Hook[];
  pending: Pending[];
  /** The due-delivery index keys; both present or both absent. */
  webhookQueue?: typeof WEBHOOK_DUE_QUEUE;
  webhookDueAt?: number;
  /** Set by deferDue: the index lists the row no earlier than this, while it has anything queued. */
  webhookDeferredUntil?: number;
};

export type WebhookUrlCode = Extract<
  ApiErrorCode,
  "webhook_url_invalid" | "webhook_url_forbidden" | "webhook_url_unresolvable"
>;
export class WebhookUrlError extends Error {
  constructor(
    readonly code: WebhookUrlCode,
    message: string,
  ) {
    super(message);
  }
}
export class WebhookLimitError extends Error {}

// Everything a webhook may not reach: private, loopback, link-local (and so the instance
// metadata service), CGNAT, documentation, benchmarking, multicast and reserved ranges.
const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(network, prefix, "ipv4");
// IPv6: global unicast only. That leaves out loopback, IPv4-mapped, NAT64, ULA (and the
// IPv6 metadata address), link-local and multicast; then the special blocks inside 2000::/3.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const)
  blockedV6.addSubnet(network, prefix, "ipv6");

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, "ipv4");
  if (family === 6)
    return globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");
  return false;
}

/** Syntax only: https on port 443, no credentials, not a local or internal name or address. */
export function parseWebhookUrl(input: string): URL {
  let url: URL;
  try {
    if (input.length > 2048) throw Error();
    url = new URL(input);
  } catch {
    throw new WebhookUrlError("webhook_url_invalid", "Webhook URL is not a valid URL.");
  }
  if (url.protocol !== "https:")
    throw new WebhookUrlError("webhook_url_invalid", "Webhook URL must use https.");
  if (url.username || url.password)
    throw new WebhookUrlError("webhook_url_invalid", "Webhook URL must not contain credentials.");
  // The URL parser drops the default port, so any port left is not 443.
  if (url.port)
    throw new WebhookUrlError("webhook_url_invalid", "Webhook URL must use port 443.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) {
    if (!publicAddress(host))
      throw new WebhookUrlError("webhook_url_forbidden", "Webhook URL points to a private or reserved address.");
  } else if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost"))
    throw new WebhookUrlError("webhook_url_forbidden", "Webhook URL must use a public host name.");
  return url;
}

/**
 * The address to connect to: every address the name resolves to must be public. IPv4 is
 * preferred, since a Lambda outside a VPC may have no IPv6 route.
 */
async function pinAddress(url: URL, resolve: Resolver, timeoutMs: number) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(host);
  if (literal) return { hostname: host, address: host, family: literal as 4 | 6 };
  let addresses: { address: string; family: number }[];
  try {
    addresses = await within(resolve(host, timeoutMs), timeoutMs);
  } catch {
    throw new WebhookUrlError("webhook_url_unresolvable", "Webhook host name does not resolve.");
  }
  if (!addresses.length)
    throw new WebhookUrlError("webhook_url_unresolvable", "Webhook host name does not resolve.");
  if (addresses.some((a) => !publicAddress(a.address)))
    throw new WebhookUrlError("webhook_url_forbidden", "Webhook host name resolves to a private or reserved address.");
  const pinned = addresses.find((a) => isIP(a.address) === 4) ?? addresses[0];
  return { hostname: host, address: pinned.address, family: isIP(pinned.address) as 4 | 6 };
}

export function webhookSignature(secret: string, timestamp: number, body: string) {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

const rowKey = (owner: string) => ({ pk: `${WEBHOOK_PARTITION}${owner}`, sk: "WEBHOOKS" });

/**
 * When deliverDue could next claim one of the row's deliveries: the earliest queued delivery
 * of an active webhook, once its webhook's backoff has passed. Undefined when there's none.
 */
function nextDueAt(row: { hooks: Hook[]; pending: Pending[] }): number | undefined {
  const retryAt = new Map(row.hooks.filter((h) => h.status === "active").map((h) => [h.id, h.retryAt ?? 0]));
  let due: number | undefined;
  for (const p of row.pending) {
    const backoff = retryAt.get(p.hook);
    if (backoff === undefined) continue;
    const at = Math.max(p.nextAt, backoff);
    if (due === undefined || at < due) due = at;
  }
  return due;
}

/** The row with its index attributes set from its own queue, no earlier than a deferral still ahead. */
function indexed(row: WebhookRow): WebhookRow {
  const { webhookQueue: _queue, webhookDueAt: _at, webhookDeferredUntil: deferred, ...rest } = row;
  const dueAt = nextDueAt(rest);
  if (dueAt === undefined) return rest;
  return deferred !== undefined && deferred > dueAt
    ? { ...rest, webhookQueue: WEBHOOK_DUE_QUEUE, webhookDueAt: deferred, webhookDeferredUntil: deferred }
    : { ...rest, webhookQueue: WEBHOOK_DUE_QUEUE, webhookDueAt: dueAt };
}
const staleIndex = (row: WebhookRow) => {
  const want = indexed(row);
  return (
    want.webhookQueue !== row.webhookQueue ||
    want.webhookDueAt !== row.webhookDueAt ||
    want.webhookDeferredUntil !== row.webhookDeferredUntil
  );
};

/**
 * Read-modify-write of the owner's one webhook row. `change` returns false to write nothing;
 * a row whose index attributes are stale (written by code from before the index) is then
 * rewritten with them corrected, so the index heals on the owner's next round.
 */
async function update(
  store: Pick<Store, "get" | "put">,
  owner: string,
  change: (row: WebhookRow | undefined) => WebhookRow | false,
): Promise<WebhookRow | undefined> {
  const { pk, sk } = rowKey(owner);
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = (await store.get(pk, sk)) as WebhookRow | undefined;
    let next = change(current ? structuredClone(current) : undefined);
    if (next === false) {
      if (!current || !staleIndex(current)) return current;
      next = structuredClone(current);
    }
    const row = indexed({ ...next, pk, sk, version: current ? current.version + 1 : 0 });
    try {
      await store.put(row, current?.version);
      return row;
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
    }
  }
  throw new Conflict("Webhook settings kept changing");
}

function publicHook(hook: Hook, pending: Pending[]) {
  return {
    id: hook.id,
    url: hook.url,
    events: hook.events ?? null,
    status: hook.status,
    createdAt: hook.createdAt,
    failures: hook.failures,
    pending: pending.filter((p) => p.hook === hook.id).length,
    ...(hook.lastDeliveryAt ? { lastDeliveryAt: hook.lastDeliveryAt } : {}),
    ...(hook.lastFailureAt ? { lastFailureAt: hook.lastFailureAt, lastError: hook.lastError } : {}),
  };
}

export async function registerWebhook(
  store: Pick<Store, "get" | "put">,
  owner: string,
  input: { url: string; events?: EventType[] },
  resolve: Resolver,
) {
  const url = parseWebhookUrl(input.url);
  await pinAddress(url, resolve, REQUEST_TIMEOUT_MS);
  const hook: Hook = {
    id: `wh_${randomBytes(12).toString("hex")}`,
    url: url.href,
    ...(input.events ? { events: [...new Set(input.events)] } : {}),
    secret: `whsec_${randomBytes(32).toString("base64url")}`,
    createdAt: new Date().toISOString(),
    status: "active",
    failures: 0,
  };
  const row = await update(store, owner, (row) => {
    const next = row ?? ({ ...rowKey(owner), version: 0, hooks: [], pending: [] } as WebhookRow);
    if (next.hooks.length >= WEBHOOK_LIMIT)
      throw new WebhookLimitError(`An account can register at most ${WEBHOOK_LIMIT} webhooks.`);
    next.hooks.push(hook);
    return next;
  });
  return { webhook: publicHook(hook, row!.pending), secret: hook.secret };
}

export async function listWebhooks(store: Pick<Store, "get">, owner: string) {
  const { pk, sk } = rowKey(owner);
  const row = (await store.get(pk, sk)) as WebhookRow | undefined;
  return (row?.hooks ?? []).map((hook) => publicHook(hook, row!.pending));
}

export async function deleteWebhook(store: Pick<Store, "get" | "put">, owner: string, id: string) {
  let found = false;
  await update(store, owner, (row) => {
    found = Boolean(row?.hooks.some((hook) => hook.id === id));
    if (!row || !found) return false;
    row.hooks = row.hooks.filter((hook) => hook.id !== id);
    row.pending = row.pending.filter((p) => p.hook !== id);
    return row;
  });
  return found;
}

/** Queue `events` for each active webhook of the owner that subscribes to them. */
export async function enqueueDeliveries(
  store: Pick<Store, "get" | "put">,
  owner: string,
  events: OwnerEvent[],
) {
  await update(store, owner, (row) => {
    if (!row?.hooks.length) return false;
    let added = false;
    for (const event of events)
      for (const hook of row.hooks) {
        if (hook.status !== "active" || (hook.events && !hook.events.includes(event.type))) continue;
        if (row.pending.some((p) => p.hook === hook.id && p.event.id === event.id)) continue;
        row.pending.push({ hook: hook.id, event, attempts: 0, nextAt: 0 });
        added = true;
      }
    if (!added) return false;
    row.pending.splice(0, Math.max(0, row.pending.length - PENDING_LIMIT));
    return row;
  });
}

type Outcome = { hook: string; eventId: string; result: "ok" | "failed" | "skipped"; reason?: string };

/** One round for one webhook: resolve and check the host once, then send in parallel. */
async function round(
  hook: Hook,
  due: Pending[],
  delivery: Delivery,
  deadline: number,
  requestTimeoutMs: number,
): Promise<Outcome[]> {
  const skipped = (reason?: string) =>
    due.map((p) => ({ hook: hook.id, eventId: p.event.id, result: "skipped" as const, reason }));
  if (deadline - Date.now() <= 0) return skipped();
  let target: Awaited<ReturnType<typeof pinAddress>>;
  try {
    target = await pinAddress(parseWebhookUrl(hook.url), delivery.resolve, Math.min(requestTimeoutMs, deadline - Date.now()));
  } catch (error) {
    const reason = error instanceof WebhookUrlError ? error.code.replace("webhook_url_", "url_") : "url_invalid";
    return due.map((p) => ({ hook: hook.id, eventId: p.event.id, result: "failed" as const, reason }));
  }
  return Promise.all(
    due.map(async (p): Promise<Outcome> => {
      const timeoutMs = Math.min(requestTimeoutMs, deadline - Date.now());
      if (timeoutMs <= 0) return { hook: hook.id, eventId: p.event.id, result: "skipped" };
      const body = JSON.stringify(p.event);
      const timestamp = Math.floor(Date.now() / 1000);
      try {
        const response = await within(
          delivery.transport({
            url: hook.url,
            ...target,
            headers: {
              "content-type": "application/json",
              "user-agent": "qsb-webhooks/1",
              "qsb-event-id": p.event.id,
              "qsb-signature": webhookSignature(hook.secret, timestamp, body),
            },
            body,
            timeoutMs,
          }),
          timeoutMs,
        );
        const ok = response.status >= 200 && response.status < 300;
        return { hook: hook.id, eventId: p.event.id, result: ok ? "ok" : "failed", reason: ok ? undefined : `http_${response.status}` };
      } catch (error) {
        return { hook: hook.id, eventId: p.event.id, result: "failed", reason: error instanceof Timeout ? "timeout" : "network" };
      }
    }),
  );
}

/**
 * Send the owner's due deliveries before `deadline`. At least once and best-effort; the pull
 * endpoint is the record.
 * - A round claims its deliveries with a token until the lease ends, so a concurrent round
 *   skips them. Results are written back only to deliveries this round still holds; one that
 *   another round has since claimed is left alone. A round that outlived its lease (for
 *   example frozen with its Lambda) counts no failures, only successes.
 * - A webhook's failed round backs it off; after FAILING_AFTER in a row it is marked failing
 *   and gets no more deliveries.
 * Returns how many deliveries the round claimed: fewer than ROUND_LIMIT means it claimed all
 * that were due.
 */
export async function deliverDue(
  store: Pick<Store, "get" | "put">,
  owner: string,
  delivery: Delivery,
  { deadline, requestTimeoutMs = REQUEST_TIMEOUT_MS }: { deadline: number; requestTimeoutMs?: number },
) {
  const now = Date.now();
  const claim = randomBytes(8).toString("hex");
  let claimed: Pending[] = [];
  const row = await update(store, owner, (row) => {
    claimed = [];
    if (!row?.pending.length) return false;
    const ready = new Set(
      row.hooks.filter((h) => h.status === "active" && (h.retryAt ?? 0) <= now).map((h) => h.id),
    );
    claimed = row.pending.filter((p) => ready.has(p.hook) && p.nextAt <= now).slice(0, ROUND_LIMIT);
    if (!claimed.length) return false;
    for (const p of claimed) Object.assign(p, { nextAt: now + LEASE_MS, claim });
    return row;
  });
  if (!row || !claimed.length) return 0;
  const outcomes = (
    await Promise.all(
      row.hooks.map((hook) => {
        const due = claimed.filter((p) => p.hook === hook.id);
        return due.length ? round(hook, due, delivery, deadline, requestTimeoutMs) : [];
      }),
    )
  ).flat();
  const at = new Date().toISOString();
  const expired = Date.now() > now + LEASE_MS;
  await update(store, owner, (row) => {
    if (!row) return false;
    const held = (o: Outcome) =>
      row.pending.some((p) => p.hook === o.hook && p.event.id === o.eventId && p.claim === claim);
    const applied = outcomes.filter(held);
    if (!applied.length) return false;
    for (const hook of row.hooks) {
      const mine = applied.filter((o) => o.hook === hook.id);
      if (mine.some((o) => o.result === "ok")) {
        hook.failures = 0;
        delete hook.retryAt;
        hook.lastDeliveryAt = at;
      } else if (!expired && mine.some((o) => o.result === "failed")) {
        hook.failures += 1;
        hook.retryAt = Date.now() + RETRY_DELAYS_MS[Math.min(hook.failures, RETRY_DELAYS_MS.length) - 1];
        hook.lastFailureAt = at;
        hook.lastError = mine.find((o) => o.result === "failed")!.reason;
        if (hook.failures >= FAILING_AFTER) hook.status = "failing";
      }
    }
    const failing = new Set(row.hooks.filter((h) => h.status !== "active").map((h) => h.id));
    row.pending = row.pending.flatMap((p) => {
      if (failing.has(p.hook)) return [];
      // At most one entry per (hook, event), so an applied outcome is for this round's claim.
      const outcome = applied.find((o) => o.hook === p.hook && o.eventId === p.event.id);
      if (!outcome) return [p];
      const { claim: _released, ...rest } = p;
      if (outcome.result === "ok") return [];
      const attempts = rest.attempts + (outcome.result === "failed" && !expired ? 1 : 0);
      return attempts >= MAX_ATTEMPTS ? [] : [{ ...rest, attempts, nextAt: 0 }];
    });
    return row;
  });
  return claimed.length;
}

/**
 * For the dispatcher: a round it ran for an owner the index listed as due claimed nothing, although
 * the row, read consistently, is still due by `now`. That happens when the dispatcher can't send
 * what's queued (for example a webhook it can't sign), so push the row's place in the index back to
 * `until` instead of letting it hold the head of every run. Other paths still send the row's
 * deliveries meanwhile; the deferral only moves the index. Returns whether it wrote.
 */
export async function deferDue(store: Pick<Store, "get" | "put">, owner: string, now: number, until: number) {
  let deferred = false;
  await update(store, owner, (row) => {
    deferred = false;
    if (row?.webhookDueAt === undefined || row.webhookDueAt > now) return false;
    row.webhookDeferredUntil = until;
    deferred = true;
    return row;
  });
  return deferred;
}

/**
 * Rows with webhook signing secrets removed, for a storage inventory or export. Everything
 * else is left as it is, so the usual credential check still applies to it.
 */
export function withoutWebhookSecrets<T>(rows: T): T {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    const r = row as Partial<WebhookRow> | null;
    if (!r || r.sk !== "WEBHOOKS" || !r.pk?.startsWith(WEBHOOK_PARTITION) || !Array.isArray(r.hooks))
      return row;
    return { ...r, hooks: r.hooks.map(({ secret: _secret, ...hook }) => hook) };
  }) as T;
}
