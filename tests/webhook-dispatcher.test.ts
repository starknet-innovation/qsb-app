import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
// deliverDue runs as written; a test can make one round claim nothing, as a path that can't sign would.
vi.mock("../server/webhooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/webhooks")>();
  return { ...actual, deliverDue: vi.fn(actual.deliverDue) };
});
import { build } from "esbuild";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { MemoryStore, type Row, type Store } from "../server/store";
import type { OwnerEvent } from "../server/owner-events";
import {
  LEASE_MS,
  RETRY_DELAYS_MS,
  ROUND_LIMIT,
  WEBHOOK_DUE_INDEX,
  WEBHOOK_DUE_QUEUE,
  WEBHOOK_PARTITION,
  FAILING_AFTER,
  deferDue,
  deleteWebhook,
  deliverDue,
  enqueueDeliveries,
  registerWebhook,
  type WebhookRequest,
} from "../server/webhooks";
import {
  DISPATCH_CONCURRENCY,
  DISPATCH_DEFER_MS,
  OWNER_ROUNDS,
  ROUND_MS,
  dispatchWebhooks,
  indexedDueOwners,
  type DueOwners,
} from "../server/webhook-dispatcher";

// Synthetic owners and hosts only; every test injects its transport and resolver, so no request leaves.
const PUBLIC = "93.184.215.14";
const START = Date.parse("2026-09-30T00:00:00.000Z");
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function receiver(status = 204) {
  const calls: WebhookRequest[] = [];
  const transport = vi.fn(async (request: WebhookRequest) => {
    calls.push(request);
    return { status };
  });
  const resolve = vi.fn(async (_host: string) => [{ address: PUBLIC, family: 4 }]);
  return { calls, transport, resolve };
}
const events = (count: number, from = 0): OwnerEvent[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `evt_${(from + i).toString(16).padStart(32, "0")}`,
    type: "withdrawal.searching",
    subjectId: "job",
    status: "searching",
    at: new Date().toISOString(),
  }));
/** The index as DynamoDB serves it: rows carrying both keys, due by `now`, earliest first. */
const memoryDue =
  (store: MemoryStore): DueOwners =>
  async (now, limit) =>
    [...store.rows.values()]
      .filter((r) => r.webhookQueue === WEBHOOK_DUE_QUEUE && typeof r.webhookDueAt === "number" && r.webhookDueAt <= now)
      .sort((a, b) => (a.webhookDueAt as number) - (b.webhookDueAt as number))
      .slice(0, limit)
      .map((r) => r.pk.slice(WEBHOOK_PARTITION.length));
const row = async (store: Store, owner: string) => (await store.get(`WEBHOOK#${owner}`, "WEBHOOKS"))!;
const index = async (store: Store, owner: string) => {
  const r = await row(store, owner);
  return { webhookQueue: r.webhookQueue, webhookDueAt: r.webhookDueAt };
};
async function queued(owner: string, count = 1, receiverStatus = 204) {
  const store = new MemoryStore();
  const hooks = receiver(receiverStatus);
  await registerWebhook(store, owner, { url: "https://hooks.example.com/" }, hooks.resolve);
  await enqueueDeliveries(store, owner, events(count));
  return { store, hooks };
}

describe("due-delivery index", () => {
  it("lists a row exactly while it holds a delivery an active webhook can send", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const store = new MemoryStore();
    const hooks = receiver(500);
    await registerWebhook(store, "owner-a", { url: "https://hooks.example.com/" }, hooks.resolve);
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: undefined, webhookDueAt: undefined });
    await enqueueDeliveries(store, "owner-a", events(1));
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: WEBHOOK_DUE_QUEUE, webhookDueAt: 0 });
    // A failed round backs the webhook off: due again when its retry is.
    await deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 });
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: WEBHOOK_DUE_QUEUE, webhookDueAt: START + RETRY_DELAYS_MS[0] });
    vi.setSystemTime(START + RETRY_DELAYS_MS[0]);
    hooks.transport.mockResolvedValue({ status: 200 });
    await deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 });
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: undefined, webhookDueAt: undefined });
    expect((await row(store, "owner-a")).pending).toEqual([]);
  });

  it("holds a claimed delivery until its lease ends, so a lost round is picked up again", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const { store, hooks } = await queued("owner-a");
    let answer!: (status: number) => void;
    hooks.transport.mockImplementation(() => new Promise((resolve) => (answer = (status) => resolve({ status }))));
    const round = deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 });
    await vi.waitFor(() => expect(hooks.transport).toHaveBeenCalledOnce());
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: WEBHOOK_DUE_QUEUE, webhookDueAt: START + LEASE_MS });
    answer(204);
    await round;
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: undefined, webhookDueAt: undefined });
  });

  it("takes the earliest of several webhooks, and drops a failing one's deliveries", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const store = new MemoryStore();
    const hooks = receiver(500);
    await registerWebhook(store, "owner-a", { url: "https://one.example.com/" }, hooks.resolve);
    await enqueueDeliveries(store, "owner-a", events(1));
    for (let round = 0; round < FAILING_AFTER; round++) {
      await deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 });
      vi.setSystemTime(Date.now() + RETRY_DELAYS_MS.at(-1)!);
    }
    expect((await row(store, "owner-a")).hooks).toMatchObject([{ status: "failing" }]);
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: undefined, webhookDueAt: undefined });
    await registerWebhook(store, "owner-a", { url: "https://two.example.com/" }, hooks.resolve);
    await enqueueDeliveries(store, "owner-a", events(1, 1));
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: WEBHOOK_DUE_QUEUE, webhookDueAt: 0 });
    const [, second] = (await row(store, "owner-a")).hooks as { id: string }[];
    expect(await deleteWebhook(store, "owner-a", second.id)).toBe(true);
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: undefined, webhookDueAt: undefined });
  });

  it("heals a row written before the index on the owner's next round", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const { store, hooks } = await queued("owner-a", 1, 500);
    await deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 });
    // As older code left it: a queued retry, but no index keys.
    const { webhookQueue: _q, webhookDueAt: _at, ...old } = await row(store, "owner-a");
    store.rows.set("WEBHOOK#owner-a|WEBHOOKS", { ...old, version: old.version + 1 });
    expect(await memoryDue(store)(Infinity, 10)).toEqual([]);
    // Still backing off, so nothing is claimed; the round writes the index keys alone.
    expect(await deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 })).toBe(0);
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: WEBHOOK_DUE_QUEUE, webhookDueAt: START + RETRY_DELAYS_MS[0] });
    // A current row isn't rewritten.
    const version = (await row(store, "owner-a")).version;
    await deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 });
    expect((await row(store, "owner-a")).version).toBe(version);
  });

  it("keeping the index adds no store request", async () => {
    const store = new MemoryStore();
    const hooks = receiver();
    await registerWebhook(store, "owner-a", { url: "https://hooks.example.com/" }, hooks.resolve);
    const gets = vi.spyOn(store, "get"),
      puts = vi.spyOn(store, "put");
    await enqueueDeliveries(store, "owner-a", events(1));
    expect([gets.mock.calls.length, puts.mock.calls.length]).toEqual([1, 1]);
    await deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 });
    // One claim and one write-back, as before the index.
    expect([gets.mock.calls.length, puts.mock.calls.length]).toEqual([3, 3]);
  });

  it("keeps the webhook row in its own partition, with the index key types", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const store = new MemoryStore();
    const written: Row[] = [];
    const put = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementation(async (r, expected, options) => {
      written.push(structuredClone(r));
      return put(r, expected, options);
    });
    const hooks = receiver(500);
    await registerWebhook(store, "owner-a", { url: "https://hooks.example.com/", events: ["withdrawal.searching"] }, hooks.resolve);
    await enqueueDeliveries(store, "owner-a", events(3));
    await deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 });
    vi.setSystemTime(Date.now() + RETRY_DELAYS_MS[0]);
    hooks.transport.mockResolvedValue({ status: 200 });
    await deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 });
    expect(written.length).toBeGreaterThanOrEqual(4);
    // Nothing of the owner's OWNER# partition (jobs, vaults, intents, events) is read or written.
    expect(new Set(written.map((r) => `${r.pk}|${r.sk}`))).toEqual(new Set(["WEBHOOK#owner-a|WEBHOOKS"]));
    expect([...store.rows.keys()].filter((key) => key.startsWith("OWNER#"))).toEqual([]);
    for (const r of written) {
      // Both index keys or neither; a wrong type would make DynamoDB refuse the write.
      expect("webhookQueue" in r).toBe("webhookDueAt" in r);
      if ("webhookQueue" in r) {
        expect(r.webhookQueue).toBe(WEBHOOK_DUE_QUEUE);
        expect(Number.isSafeInteger(r.webhookDueAt)).toBe(true);
      }
    }
  });

  it("defers a row in the index, not its deliveries, and only while it's still due", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const { store, hooks } = await queued("owner-a", 2);
    const until = START + DISPATCH_DEFER_MS;
    expect(await deferDue(store, "owner-a", START, until)).toBe(true);
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: WEBHOOK_DUE_QUEUE, webhookDueAt: until });
    expect(await memoryDue(store)(START + 60_000, 10)).toEqual([]);
    // New events keep the row deferred; the API and coordinator still send its deliveries meanwhile.
    await enqueueDeliveries(store, "owner-a", events(1, 2));
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: WEBHOOK_DUE_QUEUE, webhookDueAt: until });
    expect(await deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 })).toBe(3);
    // Nothing left: the row leaves the index, deferral and all.
    expect(await row(store, "owner-a")).not.toHaveProperty("webhookDeferredUntil");
    expect(await index(store, "owner-a")).toEqual({ webhookQueue: undefined, webhookDueAt: undefined });
    // A row that isn't due by now is left alone: nothing queued, or backing off after a failed round.
    const unchanged = async (defer: () => Promise<boolean>) => {
      const version = (await row(store, "owner-a")).version;
      expect(await defer()).toBe(false);
      expect((await row(store, "owner-a")).version).toBe(version);
    };
    await unchanged(() => deferDue(store, "owner-a", START, until));
    await enqueueDeliveries(store, "owner-a", events(1, 3));
    hooks.transport.mockResolvedValue({ status: 500 });
    await deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 });
    await unchanged(() => deferDue(store, "owner-a", Date.now(), until));
    // Once a deferral has passed, the row is due again.
    vi.setSystemTime(START + RETRY_DELAYS_MS[0]);
    expect(await deferDue(store, "owner-a", Date.now(), Date.now() + 1000)).toBe(true);
    expect(await memoryDue(store)(Date.now(), 10)).toEqual([]);
    vi.setSystemTime(Date.now() + 1000);
    expect(await memoryDue(store)(Date.now(), 10)).toEqual(["owner-a"]);
  });

  it("matches the index Terraform creates", () => {
    const data = readFileSync("terraform/data.tf", "utf8");
    const webhooks = readFileSync("terraform/webhooks.tf", "utf8");
    expect(webhooks).toContain(`webhook_due_index    = "${WEBHOOK_DUE_INDEX}"`);
    expect(data).toMatch(/name = "webhookQueue"\s+type = "S"/);
    expect(data).toMatch(/name = "webhookDueAt"\s+type = "N"/);
    expect(data).toMatch(/attribute_name = "webhookQueue"\s+key_type\s+= "HASH"/);
    expect(data).toMatch(/attribute_name = "webhookDueAt"\s+key_type\s+= "RANGE"/);
    expect(data).toContain('projection_type = "KEYS_ONLY"');
  });
});

describe("webhook dispatcher", () => {
  it("sends an idle owner's retry once it is due, with no request or tick", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    // The job's last tick sent the delivery and it failed; nothing else happens for this owner.
    const { store, hooks } = await queued("owner-a", 1, 500);
    await deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 });
    hooks.transport.mockResolvedValue({ status: 200 });
    // Not due yet: the run finds nobody and writes nothing.
    const version = (await row(store, "owner-a")).version;
    expect(await dispatchWebhooks(store, memoryDue(store), hooks)).toEqual({ owners: 0, served: 0, rounds: 0, deferred: 0, failed: 0 });
    expect((await row(store, "owner-a")).version).toBe(version);
    vi.setSystemTime(START + RETRY_DELAYS_MS[0]);
    expect(await dispatchWebhooks(store, memoryDue(store), hooks)).toEqual({ owners: 1, served: 1, rounds: 1, deferred: 0, failed: 0 });
    expect(hooks.transport).toHaveBeenCalledTimes(2);
    expect((await row(store, "owner-a")).pending).toEqual([]);
    expect(await memoryDue(store)(Infinity, 10)).toEqual([]);
  });

  it("gives an owner more rounds while each claims a full batch, up to its round limit", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const { store, hooks } = await queued("owner-a", 25);
    expect(await dispatchWebhooks(store, memoryDue(store), hooks)).toMatchObject({ served: 1, rounds: 3 });
    expect(hooks.transport).toHaveBeenCalledTimes(25);
    const many = await queued("owner-b", ROUND_LIMIT * OWNER_ROUNDS + 7);
    expect(await dispatchWebhooks(many.store, memoryDue(many.store), many.hooks)).toMatchObject({ rounds: OWNER_ROUNDS });
    expect(many.hooks.transport).toHaveBeenCalledTimes(ROUND_LIMIT * OWNER_ROUNDS);
    // The rest are still due for the next run.
    expect((await row(many.store, "owner-b")).pending).toHaveLength(7);
    expect(await memoryDue(many.store)(Date.now(), 10)).toEqual(["owner-b"]);
  });

  it("takes at most maxOwners, most overdue first", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const store = new MemoryStore();
    const hooks = receiver(500);
    for (const owner of ["owner-c", "owner-a", "owner-b"]) {
      await registerWebhook(store, owner, { url: `https://${owner}.example.com/` }, hooks.resolve);
      await enqueueDeliveries(store, owner, events(1));
      await deliverDue(store, owner, hooks, { deadline: Date.now() + 3000 });
      vi.setSystemTime(Date.now() + 1000);
    }
    vi.setSystemTime(START + RETRY_DELAYS_MS[0] + 10_000);
    hooks.transport.mockClear().mockResolvedValue({ status: 200 });
    expect(await dispatchWebhooks(store, memoryDue(store), hooks, { maxOwners: 2 })).toMatchObject({ owners: 2, served: 2 });
    expect(hooks.transport.mock.calls.map(([c]) => c.hostname).sort()).toEqual(["owner-a.example.com", "owner-c.example.com"]);
    expect(await memoryDue(store)(Date.now(), 10)).toEqual(["owner-b"]);
  });

  it(`serves at most ${DISPATCH_CONCURRENCY} owners at once`, async () => {
    const store = new MemoryStore();
    const hooks = receiver();
    const owners = Array.from({ length: DISPATCH_CONCURRENCY + 2 }, (_, i) => `owner-${i}`);
    for (const owner of owners) {
      await registerWebhook(store, owner, { url: "https://hooks.example.com/" }, hooks.resolve);
      await enqueueDeliveries(store, owner, events(1));
    }
    const release: (() => void)[] = [];
    hooks.transport.mockImplementation(() => new Promise((resolve) => release.push(() => resolve({ status: 204 }))));
    const run = dispatchWebhooks(store, memoryDue(store), hooks);
    await vi.waitFor(() => expect(release).toHaveLength(DISPATCH_CONCURRENCY));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(release).toHaveLength(DISPATCH_CONCURRENCY);
    release.splice(0).forEach((send) => send());
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release.splice(0).forEach((send) => send());
    expect(await run).toMatchObject({ owners: owners.length, served: owners.length, failed: 0 });
  });

  it("starts no round without the time for one, and each round ends inside its lease", async () => {
    expect(ROUND_MS).toBeLessThan(LEASE_MS);
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const store = new MemoryStore();
    const hooks = receiver();
    for (let i = 0; i < 8; i++) {
      await registerWebhook(store, `owner-${i}`, { url: "https://hooks.example.com/" }, hooks.resolve);
      await enqueueDeliveries(store, `owner-${i}`, events(1));
    }
    expect(await dispatchWebhooks(store, memoryDue(store), hooks, { budgetMs: 1000 })).toMatchObject({ owners: 8, served: 0 });
    expect(hooks.transport).not.toHaveBeenCalled();
    // Each send uses up the whole budget: no owner past the first wave is served.
    const deadlines: number[] = [];
    hooks.transport.mockImplementation(async (request) => {
      deadlines.push(Date.now() + request.timeoutMs);
      vi.setSystemTime(Date.now() + 5000);
      return { status: 204 };
    });
    const result = await dispatchWebhooks(store, memoryDue(store), hooks, { budgetMs: 5000 });
    expect(result.served).toBeLessThanOrEqual(DISPATCH_CONCURRENCY);
    expect(hooks.transport.mock.calls.length).toBeLessThanOrEqual(DISPATCH_CONCURRENCY);
    expect(await memoryDue(store)(Date.now(), 10)).toHaveLength(8 - hooks.transport.mock.calls.length);
    for (const at of deadlines) expect(at).toBeLessThanOrEqual(START + 5000);
  });

  it("skips an owner whose round fails, and logs no owner, host or secret", async () => {
    const { store, hooks } = await queued("owner-a");
    await registerWebhook(store, "owner-bad", { url: "https://bad.example.com/" }, hooks.resolve);
    await enqueueDeliveries(store, "owner-bad", events(1));
    const get = store.get.bind(store);
    vi.spyOn(store, "get").mockImplementation((pk, sk) =>
      pk === "WEBHOOK#owner-bad" ? Promise.reject(Object.assign(new Error("denied"), { name: "AccessDeniedException" })) : get(pk, sk),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dispatchWebhooks(store, memoryDue(store), hooks)).toMatchObject({ owners: 2, served: 2, failed: 1 });
    expect(hooks.calls.map((c) => c.hostname)).toEqual(["hooks.example.com"]);
    const lines = logged.mock.calls.map((args) => args.join(" "));
    expect(lines).toEqual([JSON.stringify({ webhookDispatch: "delivery_failed", error: "AccessDeniedException" })]);
    for (const line of lines) expect(line).not.toMatch(/owner-|example\.com|whsec_/);
  });

  it("makes only calls its role allows, and that role refuses every job, vault, intent, event and reservation row", async () => {
    type Statement = { Sid: string; Action: string[]; Condition?: Record<string, Record<string, string | string[]>> };
    const policy: Statement[] = JSON.parse(readFileSync("terraform/policies/webhook-dispatcher-records.json", "utf8"));
    const like = (value: string, pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`).test(value);
    // A local reading of that policy's item grant, not an IAM call. FindDueOwners is the index Query only.
    const allowed = (action: string, leadingKey: string) =>
      policy.some((s) => {
        if (s.Sid === "FindDueOwners" || !s.Action.includes(action)) return false;
        const keys = s.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"] as string[] | undefined;
        return Boolean(keys?.some((p) => like(leadingKey, p)));
      });
    const { store, hooks } = await queued("owner-a", 12, 500);
    const calls: { action: string; pk: string; sk: string }[] = [];
    const get = store.get.bind(store),
      put = store.put.bind(store);
    vi.spyOn(store, "get").mockImplementation(async (pk, sk) => (calls.push({ action: "dynamodb:GetItem", pk, sk }), get(pk, sk)));
    vi.spyOn(store, "put").mockImplementation(async (r, expected, options) => {
      calls.push({ action: "dynamodb:PutItem", pk: r.pk, sk: r.sk });
      return put(r, expected, options);
    });
    for (const spy of [vi.spyOn(store, "list"), vi.spyOn(store, "atomicPut"), vi.spyOn(store, "delete"), vi.spyOn(store, "reservationRows")])
      spy.mockRejectedValue(Error("the dispatcher has no grant for this"));
    await dispatchWebhooks(store, memoryDue(store), hooks);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect([call.pk, call.sk]).toEqual(["WEBHOOK#owner-a", "WEBHOOKS"]);
      expect(allowed(call.action, call.pk)).toBe(true);
    }
    // Whatever the item holds: PutItem replaces a whole row, so only the partition key can keep it off one.
    for (const pk of ["OWNER#owner-a", "OUTPOINT#x:0", "SYSTEM#RESERVATION_AUTHORITY", "SESSION#x", "APIKEY#x", "CHALLENGE#x"])
      for (const action of ["dynamodb:PutItem", "dynamodb:GetItem"]) expect(allowed(action, pk), `${action} ${pk}`).toBe(false);
    for (const action of ["dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:BatchWriteItem", "dynamodb:Scan", "dynamodb:ConditionCheckItem"])
      expect(allowed(action, "WEBHOOK#owner-a")).toBe(false);
  });

  it("defers an owner whose first round claims nothing while it's still due, so it can't hold the head of the query", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: START });
    const store = new MemoryStore();
    const hooks = receiver();
    for (const owner of ["owner-stuck", "owner-b"]) {
      await registerWebhook(store, owner, { url: "https://hooks.example.com/" }, hooks.resolve);
      await enqueueDeliveries(store, owner, events(1));
      vi.setSystemTime(Date.now() + 1000);
    }
    // As a round would that can't sign owner-stuck's webhook: it claims nothing and writes nothing.
    vi.mocked(deliverDue).mockImplementationOnce(async () => 0);
    expect(await dispatchWebhooks(store, memoryDue(store), hooks, { maxOwners: 1 })).toMatchObject({ served: 1, deferred: 1 });
    expect(hooks.transport).not.toHaveBeenCalled();
    expect((await index(store, "owner-stuck")).webhookDueAt).toBe(Date.now() + DISPATCH_DEFER_MS);
    // The next run reaches the owner behind it.
    expect(await memoryDue(store)(Date.now(), 1)).toEqual(["owner-b"]);
    expect(await dispatchWebhooks(store, memoryDue(store), hooks, { maxOwners: 1 })).toMatchObject({ served: 1, deferred: 0 });
    expect(hooks.transport.mock.calls.map(([c]) => JSON.parse(c.body).id)).toHaveLength(1);
    expect((await row(store, "owner-b")).pending).toEqual([]);
    expect((await row(store, "owner-stuck")).pending).toHaveLength(1);
    // An index entry that is only stale (the row has moved on) is not deferred.
    await registerWebhook(store, "owner-c", { url: "https://hooks.example.com/" }, hooks.resolve);
    await enqueueDeliveries(store, "owner-c", events(1, 9));
    await deliverDue(store, "owner-c", hooks, { deadline: Date.now() + 3000 });
    const stale: DueOwners = async () => ["owner-c"];
    expect(await dispatchWebhooks(store, stale, hooks)).toMatchObject({ served: 1, deferred: 0 });
  });

  it("queries the keys-only index for owners due by now, and reads only WEBHOOKS keys from it", async () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(async () => ({
      Items: [
        { pk: "WEBHOOK#owner-a", sk: "WEBHOOKS", webhookQueue: "due", webhookDueAt: 5 },
        { pk: "OWNER#owner-b", sk: "WEBHOOKS" },
        { pk: "WEBHOOK#owner-c", sk: "JOB#x" },
        { pk: "SYSTEM#x", sk: "WEBHOOKS" },
      ],
    }) as never);
    expect(await indexedDueOwners("qsb-test-records")(1234, 7)).toEqual(["owner-a"]);
    const [command] = send.mock.calls[0] as unknown as [QueryCommand];
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input).toEqual({
      TableName: "qsb-test-records",
      IndexName: WEBHOOK_DUE_INDEX,
      KeyConditionExpression: "#queue = :queue AND #at <= :now",
      ExpressionAttributeNames: { "#queue": "webhookQueue", "#at": "webhookDueAt" },
      ExpressionAttributeValues: { ":queue": WEBHOOK_DUE_QUEUE, ":now": 1234 },
      Limit: 7,
    });
  });

  it("is bundled without the coordinator, the API or any payment code", async () => {
    const result = await build({
      entryPoints: ["server/webhook-dispatcher.ts"],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      write: false,
      metafile: true,
      logLevel: "silent",
      define: { "import.meta.env": "undefined" },
    });
    const local = Object.keys(result.metafile.inputs).filter((input) => !input.includes("node_modules/")).sort();
    expect(local).toEqual([
      "server/runtime/reservation-guard.ts",
      "server/store.ts",
      "server/webhook-dispatcher.ts",
      "server/webhook-transport.ts",
      "server/webhooks.ts",
    ]);
  });
});
