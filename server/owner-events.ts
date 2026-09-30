import { createHash } from "node:crypto";
import type { Job, PublicVault } from "../src/lib/model";
import { EVENT_TYPES, eventsCursorParam, eventsLimitParam, type EventType } from "./api-schemas";
import { Conflict, type AtomicWrite, type Row, type Store } from "./store";
import { deliverDue, enqueueDeliveries, within, type Delivery } from "./webhooks";

/** What the pull endpoint lists and a webhook carries: identifiers and statuses, nothing secret. */
export type OwnerEvent = {
  id: string;
  type: EventType;
  subjectId: string;
  status: string;
  stage?: string;
  at: string;
};

export const EVENT_RETENTION_SECONDS = 30 * 86400;
/**
 * Listed only once this old. Event writes are cancelled within RECORD_ALLOWANCE_MS of being
 * stamped, so in normal operation none lands behind a cursor.
 */
export const EVENT_SETTLE_MS = 10_000;
/** One attempt at an event row outside a transaction; cancelled when it runs out. */
export const EVENT_WRITE_TIMEOUT_MS = 1000;
/** All attempts at a unit's event rows, one retry included. */
const RECORD_ALLOWANCE_MS = 2000;
/** Queuing one owner's webhook deliveries. */
const QUEUE_TIMEOUT_MS = 1000;
/** Bound on everything settle() does at the end of a request or tick. */
export const SETTLE_CAP_MS = 4000;
const SEEN_LIMIT = 2000;

export function logEventError(stage: string, error: unknown) {
  // Error class only: never URLs, secrets, owners or payloads.
  console.error(
    JSON.stringify({ ownerEvents: stage, error: (error as Error)?.name ?? "Error" }),
  );
}

type Candidate = { owner: string; event: OwnerEvent };
const key = (pk: string, sk: string, version: number) => `${pk}|${sk}|${version}`;

function subjectStatus(row: Row): string | undefined {
  if (!row.pk.startsWith("OWNER#")) return;
  if (row.sk.startsWith("JOB#")) {
    const status = (row.job as Job | undefined)?.status;
    return typeof status === "string" ? status : undefined;
  }
  if (row.sk.startsWith("VAULT#")) {
    const status = (row.vault as PublicVault | undefined)?.status;
    return typeof status === "string" ? status : undefined;
  }
}

/**
 * The event for writing `row` over a predecessor whose status was `previous`: null for a new
 * row, undefined when unknown (then recorded, at least once). The id is derived from the
 * subject and the row version it was written at, so a retried write of it is the same event.
 */
function derive(row: Row, previous: string | null | undefined, at: string): Candidate | undefined {
  const status = subjectStatus(row);
  if (status === undefined || status === previous) return;
  const owner = row.pk.slice("OWNER#".length);
  const id = `evt_${createHash("sha256").update(`${row.pk}\n${row.sk}\n${row.version}`).digest("hex").slice(0, 32)}`;
  if (row.sk.startsWith("JOB#")) {
    const job = row.job as Job;
    const type = `withdrawal.${status}` as EventType;
    if (!EVENT_TYPES.includes(type)) return;
    return {
      owner,
      event: { id, type, subjectId: row.sk.slice(4), status, stage: job.stage, at },
    };
  }
  if (status === "unfunded") {
    // Only a cleared deposit intent returns a vault to unfunded.
    const rejected = row.lastFundingRejection as { txid?: unknown } | undefined;
    if (previous === null || typeof rejected?.txid !== "string") return;
    return {
      owner,
      event: { id, type: "deposit.dropped", subjectId: row.sk.slice(6), status: "dropped", at },
    };
  }
  const type = `deposit.${status}` as EventType;
  if (!EVENT_TYPES.includes(type)) return;
  return { owner, event: { id, type, subjectId: row.sk.slice(6), status, at } };
}

let lastStamp = 0;
/** Increasing within this process, so events written in the same millisecond keep their order. */
function stamp() {
  const now = Date.now();
  // Follow the clock if it steps back by more than a second, rather than run ahead of it.
  lastStamp = now > lastStamp || lastStamp - now > 1000 ? now : lastStamp + 1;
  return new Date(lastStamp).toISOString();
}
function eventRow({ owner, event }: Candidate): Row {
  return {
    pk: `OWNER#${owner}`,
    sk: `EVENT#${stamp()}#${event.id}`,
    version: 0,
    event,
    expiresAt: Math.floor(Date.now() / 1000) + EVENT_RETENTION_SECONDS,
  };
}

export type SettleOptions = {
  /** Deliver due webhooks of `owners` only. Omit to only record and queue. */
  delivery?: Delivery;
  owners?: string[];
  /** Everything settle() does. Recording and queuing run even with no time to deliver. */
  limitMs?: number;
  /** Time for delivery, within limitMs. 0 queues deliveries for a later round to send. */
  deliveryMs?: number;
  requestTimeoutMs?: number;
};
export type OwnerEventStore = Store & {
  /** A deposit the miner no longer has, found by the resend logic: not a status change. */
  recordDropped(owner: string, vaultId: string): void;
  /** New stray outputs recorded on the vault row (server/stray-outputs.ts): not a status change. */
  recordStrayPayment(owner: string, vaultId: string): void;
  settle(options?: SettleOptions): Promise<void>;
};
/** What a row's status was at each version. Facts, so it can be shared across requests. */
export type StatusMemory = Map<string, string>;

/**
 * A Store that records an owner event for each withdrawal (JOB#) or deposit (VAULT#) status
 * change written through it. Make one per request or tick, and settle() it at the end. It
 * never changes what the caller's writes do:
 * - atomicPut adds the event rows to the caller's transaction. Their keys are new (a fresh
 *   timestamp and the subject's new version), so they can't be why a transaction is refused.
 * - put returns when the caller's write returns and only notes the event: no event I/O sits
 *   between a paid intent and its POST.
 * - settle(), after the unit's work, writes the noted event rows (cancelled when they run out
 *   of time, retried once), queues webhooks for all the unit's events even when there's no
 *   time to send them, then delivers the given owners' due ones within the delivery budget.
 * Errors from recording or delivery are logged and swallowed.
 */
export function recordOwnerEvents(inner: Store, seen: StatusMemory = new Map()): OwnerEventStore {
  /** Events to write at settle(). */
  const noted: Candidate[] = [];
  /** Events written, whose webhooks settle() queues. */
  const recorded: Candidate[] = [];
  /** The last version of each subject row this unit read or wrote. */
  const versions = new Map<string, number>();
  const remember = (row: Row) => {
    try {
      const status = subjectStatus(row);
      if (status === undefined) return;
      seen.set(key(row.pk, row.sk, row.version), status);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value!);
      versions.set(`${row.pk}|${row.sk}`, row.version);
    } catch {}
  };
  const previous = (row: Row, expected: number | undefined) =>
    expected === undefined ? null : seen.get(key(row.pk, row.sk, expected));
  const candidate = (row: Row, expected: number | undefined, at: string) => {
    try {
      return derive(row, previous(row, expected), at);
    } catch (error) {
      logEventError("derive_failed", error);
    }
  };
  async function writeRow(row: Row, timeoutMs: number) {
    const cancel = new AbortController();
    try {
      await within(
        inner.put(row, undefined, { signal: cancel.signal }).catch((error) => {
          // A retry finding the same row: the cancelled attempt was applied.
          if (!(error instanceof Conflict)) throw error;
        }),
        timeoutMs,
      );
      return true;
    } catch (error) {
      logEventError("record_failed", error);
      return false;
    } finally {
      cancel.abort();
    }
  }
  /** Write the noted rows, stamped now in order, within `allowanceMs`: one retry if time allows. */
  async function writeNoted(items: Candidate[], allowanceMs: number) {
    const end = Date.now() + allowanceMs;
    let left = items.map((item) => ({ item, row: eventRow(item) }));
    for (let attempt = 0; attempt < 2 && left.length; attempt++) {
      const timeoutMs = Math.min(EVENT_WRITE_TIMEOUT_MS, end - Date.now());
      if (timeoutMs <= 0) break;
      const written = await Promise.all(left.map(({ row }) => writeRow(row, timeoutMs)));
      left.forEach(({ item }, i) => written[i] && recorded.push(item));
      left = left.filter((_, i) => !written[i]);
    }
    if (left.length) logEventError("record_dropped", new Error("EventNotRecorded"));
  }
  /**
   * A vault event that isn't a status change, for the vault row version this unit last wrote.
   * The caller wrote the vault through this store; without that there's no decision.
   */
  function noteVaultEvent(owner: string, vaultId: string, status: "dropped" | "stray_payment") {
    const pk = `OWNER#${owner}`,
      sk = `VAULT#${vaultId}`;
    const version = versions.get(`${pk}|${sk}`);
    if (version === undefined) return;
    const id = `evt_${createHash("sha256").update(`${pk}\n${sk}\n${version}\n${status}`).digest("hex").slice(0, 32)}`;
    noted.push({
      owner,
      event: { id, type: `deposit.${status}`, subjectId: vaultId, status, at: new Date().toISOString() },
    });
  }
  return {
    async get(pk, sk) {
      const row = await inner.get(pk, sk);
      if (row) remember(row);
      return row;
    },
    async list(pk, prefix) {
      const rows = await inner.list(pk, prefix);
      rows.forEach(remember);
      return rows;
    },
    reservationRows: () => inner.reservationRows(),
    delete: (pk, sk, expected) => inner.delete(pk, sk, expected),
    async put(row, expected, options) {
      const item = candidate(row, expected, new Date().toISOString());
      await inner.put(row, expected, options);
      remember(row);
      if (item) noted.push(item);
    },
    async atomicPut(writes: AtomicWrite[]) {
      const at = new Date().toISOString();
      const items: Candidate[] = [];
      for (const w of writes)
        if (!w.conditionOnly && !w.remove) {
          const item = candidate(w.row, w.expected, at);
          if (item) items.push(item);
        }
      const events = items.map((item) => ({ row: eventRow(item) }));
      await inner.atomicPut(events.length ? [...writes, ...events] : writes);
      for (const w of writes) if (!w.remove) remember(w.row);
      recorded.push(...items);
    },
    recordDropped(owner, vaultId) {
      noteVaultEvent(owner, vaultId, "dropped");
    },
    recordStrayPayment(owner, vaultId) {
      noteVaultEvent(owner, vaultId, "stray_payment");
    },
    async settle(options: SettleOptions = {}) {
      const writes = noted.splice(0);
      const owners = options.delivery ? [...new Set(options.owners ?? [])] : [];
      if (!writes.length && !recorded.length && !owners.length) return;
      const started = Date.now();
      const until = started + Math.min(options.limitMs ?? SETTLE_CAP_MS, SETTLE_CAP_MS);
      const left = () => until - Date.now();
      if (left() <= 0) {
        if (writes.length) logEventError("record_dropped", new Error("NoTimeLeft"));
        recorded.splice(0);
        return;
      }
      const work = (async () => {
        await writeNoted(writes, Math.min(RECORD_ALLOWANCE_MS, left()));
        // Queue even when there's no time to send: the owner's next round sends them.
        const byOwner = new Map<string, OwnerEvent[]>();
        for (const { owner, event } of recorded.splice(0))
          byOwner.set(owner, [...(byOwner.get(owner) ?? []), event]);
        for (const [owner, events] of byOwner)
          try {
            await within(enqueueDeliveries(inner, owner, events), Math.min(QUEUE_TIMEOUT_MS, left()));
          } catch (error) {
            logEventError("enqueue_failed", error);
          }
        const window = Math.min(options.deliveryMs ?? left(), left());
        if (!options.delivery || window <= 0) return;
        // Leave room for the delivery results to be written back.
        const deadline = Date.now() + window - Math.min(1000, window / 2);
        for (const owner of owners) {
          if (Date.now() >= deadline) break;
          try {
            await deliverDue(inner, owner, options.delivery, {
              deadline,
              requestTimeoutMs: options.requestTimeoutMs,
            });
          } catch (error) {
            logEventError("delivery_failed", error);
          }
        }
      })();
      try {
        await within(work, left());
      } catch (error) {
        logEventError("settle_incomplete", error);
      }
    },
  };
}

const CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#evt_[a-f0-9]{32}$/;
export function eventQuery(
  after: string | undefined,
  limit: string | undefined,
): { after?: string; limit: number } | undefined {
  let position: string | undefined;
  if (after !== undefined) {
    if (!eventsCursorParam.safeParse(after).success) return;
    position = Buffer.from(after, "base64url").toString("utf8");
    if (!CURSOR.test(position)) return;
  }
  if (limit !== undefined && !eventsLimitParam.safeParse(limit).success) return;
  return { after: position, limit: limit === undefined ? 50 : Number(limit) };
}
const cursor = (sk: string) => Buffer.from(sk.slice("EVENT#".length)).toString("base64url");

/**
 * An owner's recorded events after a cursor, oldest first. Reads one day of the log per
 * query, so a caller that keeps its cursor reads only recent rows.
 */
export async function listOwnerEvents(
  store: Pick<Store, "list">,
  owner: string,
  query: { after?: string; limit: number },
  now = Date.now(),
) {
  const pk = `OWNER#${owner}`;
  const until = new Date(now - EVENT_SETTLE_MS).toISOString();
  const floor = new Date(now - EVENT_RETENTION_SECONDS * 1000).toISOString();
  const after = query.after ? `EVENT#${query.after}` : undefined;
  const found: Row[] = [];
  let day = new Date(`${(query.after && query.after > floor ? query.after : floor).slice(0, 10)}T00:00:00.000Z`);
  while (found.length <= query.limit && day.toISOString() <= until) {
    const rows = await store.list(pk, `EVENT#${day.toISOString().slice(0, 10)}`);
    found.push(
      ...rows
        .filter(
          (row) =>
            (!after || row.sk > after) &&
            row.sk.slice(6, 30) <= until &&
            row.sk.slice(6, 30) >= floor &&
            !(row.expiresAt && row.expiresAt < now / 1000),
        )
        .sort((a, b) => (a.sk < b.sk ? -1 : 1)),
    );
    day = new Date(day.getTime() + 86400_000);
  }
  const page = found.slice(0, query.limit);
  return {
    events: page.map((row) => row.event as OwnerEvent),
    next: page.length ? cursor(page.at(-1)!.sk) : query.after ? cursor(`EVENT#${query.after}`) : null,
    hasMore: found.length > query.limit,
  };
}
