import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { SFNClient } from "@aws-sdk/client-sfn";
vi.mock("../src/lib/releases/registry.generated", async () => {
  const { servedFixture, otherFixture } = await import("./solver-fixture");
  return { default: [servedFixture, otherFixture] };
});
import { createApp } from "../server/app";
import { Conflict, MemoryStore } from "../server/store";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EVENT_SETTLE_MS,
  EVENT_WRITE_TIMEOUT_MS,
  listOwnerEvents,
  recordOwnerEvents,
  type OwnerEvent,
} from "../server/owner-events";
import { inventoryRows } from "../server/runtime/storage-authority";
import { withApiErrorCode } from "../server/api-errors";
import { inventorySnapshot } from "../scripts/storage-inventory";
import {
  FAILING_AFTER,
  LEASE_MS,
  RETRY_DELAYS_MS,
  deliverDue,
  enqueueDeliveries,
  publicAddress,
  registerWebhook,
  type WebhookRequest,
} from "../server/webhooks";
import { Slipstream, MinerRejection } from "../server/providers";
import { transactionId } from "../server/runtime/miner-inclusion";
import { BITCOIN_NETWORK } from "../src/lib/network";
import { fixtureVault, servedFixture } from "./solver-fixture";
import type { Job, PublicVault } from "../src/lib/model";

// Synthetic owners, hosts and documentation-free public addresses only; no request leaves
// the process: every test injects its transport and resolver.
const PUBLIC = "93.184.215.14";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenFor = (owner: string) => createHash("sha256").update(owner).digest("base64url");

function receiver(status = 204) {
  const calls: WebhookRequest[] = [];
  const transport = vi.fn(async (request: WebhookRequest) => {
    calls.push(request);
    return { status };
  });
  const resolve = vi.fn(async (_host: string) => [{ address: PUBLIC, family: 4 }]);
  return { calls, transport, resolve };
}
async function setup(options: Parameters<typeof createApp>[1] = {}) {
  const store = new MemoryStore();
  const hooks = receiver();
  const app = createApp(store, {
    enabled: true,
    webhooks: { transport: hooks.transport, resolve: hooks.resolve },
    ...options,
  });
  const as = async (owner: string) => {
    const token = tokenFor(owner);
    await store.put({ pk: `SESSION#${sha(token)}`, sk: "AUTH", version: 0, owner, network: "mainnet" });
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    return {
      get: (path: string) => app.request(path, { headers }),
      post: (path: string, body: unknown = {}) =>
        app.request(path, { method: "POST", headers, body: JSON.stringify(body) }),
    };
  };
  return { store, app, hooks, as };
}
async function seedJob(store: MemoryStore, owner: string, extra: Partial<Job> = {}) {
  const job = {
    id: crypto.randomUUID(),
    owner,
    vaultId: crypto.randomUUID(),
    status: "queued",
    stage: "pinning",
    revision: 0,
    attempt: 0,
    ...extra,
  } as Job;
  await store.put({ pk: `OWNER#${owner}`, sk: `JOB#${job.id}`, version: 0, job });
  return job;
}
/** Everything recorded, past the settle window. */
const recorded = async (store: MemoryStore, owner: string) =>
  (await listOwnerEvents(store, owner, { limit: 100 }, Date.now() + EVENT_SETTLE_MS + 1000)).events;
const eventRows = (store: MemoryStore) =>
  [...store.rows.values()].filter((row) => row.sk.startsWith("EVENT#"));

describe("owner event log", () => {
  it("records pause and resume once each, with a thin payload", async () => {
    const f = await setup();
    const a = await f.as("owner-a");
    const job = await seedJob(f.store, "owner-a");
    expect((await a.post(`/api/jobs/${job.id}/pause`)).status).toBe(200);
    // A refused retry changes nothing and records nothing.
    expect((await a.post(`/api/jobs/${job.id}/pause`)).status).toBe(409);
    expect((await a.post(`/api/jobs/${job.id}/resume`)).status).toBe(202);
    const events = await recorded(f.store, "owner-a");
    expect(events.map((e) => [e.type, e.subjectId, e.status, e.stage])).toEqual([
      ["withdrawal.paused", job.id, "paused", "pinning"],
      ["withdrawal.queued", job.id, "queued", "pinning"],
    ]);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(["at", "id", "stage", "status", "subjectId", "type"]);
      expect(event.id).toMatch(/^evt_[a-f0-9]{32}$/);
    }
  });

  it("writes a confirmed withdrawal and its spent deposit in the status transaction, once", async () => {
    const chain = { status: vi.fn(async () => ({ confirmed: true, confirmations: 3 })) };
    const f = await setup({ chain: chain as never });
    const a = await f.as("owner-a");
    const vault = { id: crypto.randomUUID(), network: "mainnet", status: "confirmed" } as PublicVault;
    const job = await seedJob(f.store, "owner-a", { status: "submitted", stage: "verification", vaultId: vault.id, txid: "ab".repeat(32) });
    await f.store.put({ pk: "OWNER#owner-a", sk: `VAULT#${vault.id}`, version: 0, vault });
    await f.store.put({ pk: "OWNER#owner-a", sk: `TX#${job.txid}`, version: 0, txid: job.txid, jobId: job.id });
    const transactions = vi.spyOn(f.store, "atomicPut");
    expect((await a.get(`/api/jobs/${job.id}/status`)).status).toBe(200);
    const [writes] = transactions.mock.calls[0];
    expect(writes.map((w) => w.row.sk.split("#")[0])).toEqual(["JOB", "VAULT", "EVENT", "EVENT"]);
    // Polling again rewrites the same statuses: no new events.
    expect((await a.get(`/api/jobs/${job.id}/status`)).status).toBe(200);
    expect((await recorded(f.store, "owner-a")).map((e) => [e.type, e.subjectId])).toEqual([
      ["withdrawal.confirmed", job.id],
      ["deposit.spent", vault.id],
    ]);
  });

  it("records a created withdrawal with its reservations, and nothing for a refused one", async () => {
    vi.stubEnv("SOLVER_RELEASE_ID", servedFixture.id);
    vi.stubEnv("WORKFLOW_ARN", "arn:aws:states:eu-west-1:123456789012:stateMachine:test");
    vi.spyOn(SFNClient.prototype, "send").mockResolvedValue({} as never);
    const payment = btc.p2wpkh(hex.decode("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"));
    const owner = payment.address!;
    const f = await setup({ chain: { unspent: vi.fn().mockResolvedValue({}) } as never });
    const a = await f.as(owner);
    const funding = { txid: "11".repeat(32), vout: 0, value: "1000" };
    const vault = { ...fixtureVault, id: crypto.randomUUID(), status: "confirmed", funding };
    await f.store.put({ pk: `OWNER#${owner}`, sk: `VAULT#${vault.id}`, version: 0, vault });
    const manifest = { vaultId: vault.id, funding, helper: { txid: "22".repeat(32), vout: 0, value: "500" }, destination: owner, outputScript: hex.encode(payment.script), outputValue: "1200", fee: "300", idempotencyKey: crypto.randomUUID(), costAccepted: true };
    expect((await a.post("/api/jobs", manifest)).status).toBe(201);
    // Same outpoints under another key: the reservation refuses it, so no job and no event.
    expect((await a.post("/api/jobs", { ...manifest, idempotencyKey: crypto.randomUUID() })).status).toBe(409);
    expect((await recorded(f.store, owner)).map((e) => [e.type, e.subjectId])).toEqual([
      ["withdrawal.queued", manifest.idempotencyKey],
    ]);
  });

  it("records a deposit sent to the miner, and a deposit the miner refused and doesn't know", async () => {
    const address = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
    const miner = new Slipstream("https://slipstream.test", async () => undefined);
    const f = await setup({ miner, exactSubmit: true });
    const a = await f.as(address);
    const scriptHex = "51".repeat(100);
    const deposit = (seed: number) => {
      const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, version: 2 });
      tx.addInput({ txid: new Uint8Array(32).fill(seed), index: 0, sequence: 0xfffffffe });
      tx.addOutput({ amount: 50_000n, script: hex.decode(scriptHex) });
      return hex.encode(tx.toBytes(true, false));
    };
    const vaults = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of vaults)
      await f.store.put({ pk: `OWNER#${address}`, sk: `VAULT#${id}`, version: 0, vault: {
        id, scriptHex, config: "A", publicStateJson: JSON.stringify({ config: "A", full_script_hex: scriptHex }),
        scriptHash: sha(Buffer.from(scriptHex, "hex").toString("latin1")), paymentAddress: address, network: "mainnet", status: "unfunded",
      } });
    vi.spyOn(miner, "credential").mockResolvedValue({} as never);
    vi.spyOn(miner, "seen").mockResolvedValue(false);
    const submit = vi.spyOn(miner, "submitFunding").mockImplementation(async (raw: string) => ({ status: "success" as const, message: transactionId(raw) }));
    expect((await a.post(`/api/vaults/${vaults[0]}/fund/submit`, { rawTxHex: deposit(1), amount: "50000", costAccepted: true })).status).toBe(201);
    submit.mockRejectedValueOnce(new MinerRejection("min relay fee not met"));
    expect(await (await a.post(`/api/vaults/${vaults[1]}/fund/submit`, { rawTxHex: deposit(2), amount: "50000", costAccepted: true })).json()).toMatchObject({ submission: "rejected" });
    expect((await recorded(f.store, address)).map((e) => [e.type, e.subjectId, e.status])).toEqual([
      ["deposit.submitted", vaults[0], "submitted"],
      ["deposit.submitted", vaults[1], "submitted"],
      ["deposit.dropped", vaults[1], "dropped"],
    ]);
  });

  it("writes no event row between a deposit intent and its miner POST", async () => {
    const address = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
    const miner = new Slipstream("https://slipstream.test", async () => undefined);
    const f = await setup({ miner, exactSubmit: true });
    const a = await f.as(address);
    const scriptHex = "51".repeat(100);
    const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, version: 2 });
    tx.addInput({ txid: new Uint8Array(32).fill(4), index: 0, sequence: 0xfffffffe });
    tx.addOutput({ amount: 50_000n, script: hex.decode(scriptHex) });
    const raw = hex.encode(tx.toBytes(true, false));
    const id = crypto.randomUUID();
    await f.store.put({ pk: `OWNER#${address}`, sk: `VAULT#${id}`, version: 0, vault: {
      id, scriptHex, config: "A", publicStateJson: JSON.stringify({ config: "A", full_script_hex: scriptHex }),
      scriptHash: createHash("sha256").update(Buffer.from(scriptHex, "hex")).digest("hex"), paymentAddress: address, network: "mainnet", status: "unfunded",
    } });
    const order: string[] = [];
    const put = MemoryStore.prototype.put.bind(f.store);
    vi.spyOn(f.store, "put").mockImplementation(async (row, expected, options) => {
      await put(row, expected, options);
      order.push(row.sk.split("#")[0]);
    });
    vi.spyOn(miner, "credential").mockResolvedValue({} as never);
    vi.spyOn(miner, "submitFunding").mockImplementation(async (rawTx: string) => {
      order.push("POST");
      return { status: "success" as const, message: transactionId(rawTx) };
    });
    expect((await a.post(`/api/vaults/${id}/fund/submit`, { rawTxHex: raw, amount: "50000", costAccepted: true })).status).toBe(201);
    expect(order).toEqual(["VAULT", "POST", "VAULT", "EVENT"]);
  });

  it("pages oldest first with a stable cursor, and lists only settled events", async () => {
    // Ten seconds before a midnight, so the pages span two days of the log.
    vi.useFakeTimers({ toFake: ["Date"], now: Math.ceil(Date.now() / 86400_000 + 1) * 86400_000 - 10_000 });
    const f = await setup();
    const a = await f.as("owner-a");
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      jobs.push(await seedJob(f.store, "owner-a"));
      expect((await a.post(`/api/jobs/${jobs[i].id}/pause`)).status).toBe(200);
      vi.setSystemTime(Date.now() + 5000); // crosses midnight
    }
    // Only events at least EVENT_SETTLE_MS old are listed: the last one (5s old) is not.
    expect((await (await a.get("/api/events")).json()).events).toHaveLength(4);
    vi.setSystemTime(Date.now() + EVENT_SETTLE_MS);
    const seen: OwnerEvent[] = [];
    let after: string | undefined;
    for (let page = 0; page < 3; page++) {
      const body = await (await a.get(`/api/events?limit=2${after ? `&after=${after}` : ""}`)).json();
      seen.push(...body.events);
      expect(body.hasMore).toBe(page < 2);
      after = body.next;
    }
    expect(seen.map((e) => e.subjectId)).toEqual(jobs.map((j) => j.id));
    // A caller that keeps its cursor sees only what comes next.
    const body = await (await a.get(`/api/events?after=${after}`)).json();
    expect(body).toEqual({ events: [], next: after, hasMore: false });
    for (const query of ["limit=0", "limit=101", "limit=x", "after=%21", `after=${Buffer.from("nope").toString("base64url")}`]) {
      const response = await a.get(`/api/events?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
  });

  it("keeps each owner's events and webhooks to that owner", async () => {
    const f = await setup();
    const a = await f.as("owner-a"),
      b = await f.as("owner-b");
    const job = await seedJob(f.store, "owner-a");
    expect((await b.post(`/api/jobs/${job.id}/pause`)).status).toBe(404);
    expect((await a.post(`/api/jobs/${job.id}/pause`)).status).toBe(200);
    const created = await (await a.post("/api/webhooks", { url: "https://hooks.example.com/qsb" })).json();
    expect(await recorded(f.store, "owner-b")).toEqual([]);
    expect(await (await b.get("/api/webhooks")).json()).toEqual({ webhooks: [] });
    expect((await b.post(`/api/webhooks/${created.webhook.id}/delete`)).status).toBe(404);
    expect((await (await a.get("/api/webhooks")).json()).webhooks).toHaveLength(1);
    expect((await f.app.request("/api/events")).status).toBe(401);
  });

  it("adds event rows to a transaction without changing whether it commits", async () => {
    const inner = new MemoryStore();
    const store = recordOwnerEvents(inner);
    const row = { pk: "OWNER#a", sk: "JOB#j", version: 0, job: { id: "j", status: "queued", stage: "pinning" } };
    const reservation = { pk: "OUTPOINT#" + "11".repeat(32) + ":0", sk: "RESERVATION", version: 0, owner: "a", jobId: "j" };
    await inner.put(reservation);
    await expect(store.atomicPut([{ row }, { row: reservation }])).rejects.toBeInstanceOf(Conflict);
    expect(eventRows(inner)).toHaveLength(0);
    await store.atomicPut([{ row }]);
    expect(eventRows(inner)).toHaveLength(1);
  });

  const job = { pk: "OWNER#a", sk: "JOB#j", version: 0, job: { id: "j", status: "queued", stage: "pinning" } };
  const eventPuts = (inner: MemoryStore, event: (options?: { signal?: AbortSignal }) => Promise<void>) => {
    const put = MemoryStore.prototype.put.bind(inner);
    return vi.spyOn(inner, "put").mockImplementation((row, expected, options) =>
      row.sk.startsWith("EVENT#") ? event(options) : put(row, expected),
    );
  };
  it("returns from put when the subject write returns, and writes the event row at settle", async () => {
    const inner = new MemoryStore();
    const store = recordOwnerEvents(inner);
    const puts = vi.spyOn(inner, "put");
    await store.put(job);
    expect(puts.mock.calls.map(([row]) => row.sk)).toEqual(["JOB#j"]);
    expect(eventRows(inner)).toHaveLength(0);
    await store.settle();
    expect(eventRows(inner)).toHaveLength(1);
  });

  it("retries a failed event write once at settle", async () => {
    const inner = new MemoryStore();
    const store = recordOwnerEvents(inner);
    const put = MemoryStore.prototype.put.bind(inner);
    let failures = 1;
    const puts = eventPuts(inner, async () => {
      if (failures-- > 0) throw new Error("ThrottlingException");
      return put(puts.mock.calls.at(-1)![0]);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await store.put(job);
    await store.settle();
    expect(eventRows(inner)).toHaveLength(1);
  });

  it("cancels event writes that run out of time at settle, and keeps the caller's write", async () => {
    const inner = new MemoryStore();
    const store = recordOwnerEvents(inner);
    const signals: AbortSignal[] = [];
    eventPuts(inner, (options) => {
      signals.push(options!.signal!);
      return new Promise((_, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("AbortError"))));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await store.put(job);
    const started = Date.now();
    await store.settle();
    // One attempt and one retry, each cancelled at its timeout.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2 * EVENT_WRITE_TIMEOUT_MS - 50);
    expect(Date.now() - started).toBeLessThan(2 * EVENT_WRITE_TIMEOUT_MS + 500);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    expect(eventRows(inner)).toHaveLength(0);
    expect((await inner.get("OWNER#a", "JOB#j"))?.job).toMatchObject({ status: "queued" });
  });

  it("drops a failed event write and keeps the caller's write", async () => {
    const inner = new MemoryStore();
    const store = recordOwnerEvents(inner);
    const put = inner.put.bind(inner);
    vi.spyOn(inner, "put").mockImplementation(async (row, expected) => {
      if (row.sk.startsWith("EVENT#")) throw new Error("throttled");
      return put(row, expected);
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await store.put(job);
    await store.settle();
    await store.settle();
    expect((await inner.get("OWNER#a", "JOB#j"))?.job).toMatchObject({ status: "queued" });
    expect(eventRows(inner)).toHaveLength(0);
    expect(logged.mock.calls.flat().join(" ")).not.toContain("throttled");
  });

  it("still queues and delivers for one owner when another owner's webhook row fails", async () => {
    const inner = new MemoryStore();
    const hooks = receiver();
    for (const owner of ["a", "b"]) await registerWebhook(inner, owner, { url: "https://hooks.example.com/" }, hooks.resolve);
    const get = MemoryStore.prototype.get.bind(inner);
    vi.spyOn(inner, "get").mockImplementation((pk, sk) =>
      pk === "OWNER#a" && sk === "WEBHOOKS" ? Promise.reject(Error("ThrottlingException")) : get(pk, sk),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = recordOwnerEvents(inner);
    for (const owner of ["a", "b"])
      await store.put({ pk: `OWNER#${owner}`, sk: "JOB#j", version: 0, job: { id: "j", status: "queued", stage: "pinning" } });
    await store.settle({ delivery: hooks, owners: ["a", "b"] });
    expect(hooks.transport).toHaveBeenCalledOnce();
    expect(JSON.parse(hooks.calls[0].body)).toMatchObject({ type: "withdrawal.queued" });
  });

  it("finishes a slow request's event work by the 28 s mark, even with a hanging table", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    const address = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
    const scriptHex = "51".repeat(100);
    const deposit = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, version: 2 });
    deposit.addInput({ txid: new Uint8Array(32).fill(5), index: 0, sequence: 0xfffffffe });
    deposit.addOutput({ amount: 50_000n, script: hex.decode(scriptHex) });
    // The route takes 27 s, then its vault write becomes an event whose row write hangs.
    const chain = {
      raw: vi.fn(async () => ({ tx: deposit, raw: hex.encode(deposit.toBytes(true, false)) })),
      status: vi.fn(async () => {
        vi.setSystemTime(Date.now() + 27_000);
        return { confirmed: true, confirmations: 1 };
      }),
    };
    const f = await setup({ chain: chain as never });
    const a = await f.as(address);
    const id = crypto.randomUUID();
    await f.store.put({ pk: `OWNER#${address}`, sk: `VAULT#${id}`, version: 0, vault: {
      id, scriptHex, config: "A", publicStateJson: JSON.stringify({ config: "A", full_script_hex: scriptHex }),
      scriptHash: createHash("sha256").update(Buffer.from(scriptHex, "hex")).digest("hex"), paymentAddress: address, network: "mainnet", status: "unfunded",
    } });
    const put = MemoryStore.prototype.put.bind(f.store);
    vi.spyOn(f.store, "put").mockImplementation((row, expected, options) =>
      row.sk.startsWith("EVENT#") ? new Promise(() => {}) : put(row, expected, options),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const started = Date.now();
    const response = await a.post(`/api/vaults/${id}/fund`, { txid: deposit.id, amount: "50000", costAccepted: true });
    expect(response.status).toBe(201);
    expect(Date.now() - started).toBeGreaterThanOrEqual(27_000);
    expect(Date.now() - started).toBeLessThan(28_250);
    expect((await response.json()).vault.status).toBe("confirmed");
  });

  it("queues webhooks for events past the delivery budget, and a later request delivers them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const chain = {
      status: vi.fn(async () => {
        // Past the 25 s delivery budget, inside the 28 s limit for event work.
        vi.setSystemTime(Date.now() + 26_000);
        return { confirmed: true, confirmations: 3 };
      }),
    };
    const f = await setup({ chain: chain as never });
    const a = await f.as("owner-a"),
      b = await f.as("owner-b");
    await a.post("/api/webhooks", { url: "https://hooks.example.com/a" });
    const vault = { id: crypto.randomUUID(), network: "mainnet", status: "confirmed" } as PublicVault;
    const job = await seedJob(f.store, "owner-a", { status: "submitted", stage: "verification", vaultId: vault.id, txid: "ab".repeat(32) });
    await f.store.put({ pk: "OWNER#owner-a", sk: `VAULT#${vault.id}`, version: 0, vault });
    await f.store.put({ pk: "OWNER#owner-a", sk: `TX#${job.txid}`, version: 0, txid: job.txid, jobId: job.id });
    expect((await a.get(`/api/jobs/${job.id}/status`)).status).toBe(200);
    expect(f.hooks.transport).not.toHaveBeenCalled();
    const row = await f.store.get("OWNER#owner-a", "WEBHOOKS");
    expect((row!.pending as { event: OwnerEvent }[]).map((p) => p.event.type)).toEqual(["withdrawal.confirmed", "deposit.spent"]);
    // Another owner's request doesn't send them; this owner's next one does.
    await b.get("/api/webhooks");
    expect(f.hooks.transport).not.toHaveBeenCalled();
    await a.get("/api/webhooks");
    expect(f.hooks.transport).toHaveBeenCalledTimes(2);
  });

  it("returns the same result as an app that records nothing when a job-creation race is refused", async () => {
    vi.stubEnv("SOLVER_RELEASE_ID", servedFixture.id);
    vi.stubEnv("WORKFLOW_ARN", "arn:aws:states:eu-west-1:123456789012:stateMachine:test");
    const payment = btc.p2wpkh(hex.decode("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"));
    const owner = payment.address!;
    const funding = { txid: "11".repeat(32), vout: 0, value: "1000" };
    const run = async (recordEvents: boolean) => {
      vi.restoreAllMocks();
      const started = vi.spyOn(SFNClient.prototype, "send").mockResolvedValue({} as never);
      // Both requests pass their chain checks before either writes, so they race to commit.
      let arrived = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => (release = resolve));
      const unspent = vi.fn(async () => {
        if (++arrived === 2) release();
        await barrier;
        return {};
      });
      const f = await setup({ chain: { unspent } as never, ...(recordEvents ? {} : { recordEvents: false as const }) });
      await f.as(owner);
      const vault = { ...fixtureVault, id: "00000000-0000-4000-8000-00000000000a", status: "confirmed", funding };
      await f.store.put({ pk: `OWNER#${owner}`, sk: `VAULT#${vault.id}`, version: 0, vault });
      const manifest = { vaultId: vault.id, funding, helper: { txid: "22".repeat(32), vout: 0, value: "500" }, destination: owner, outputScript: hex.encode(payment.script), outputValue: "1200", fee: "300", idempotencyKey: "00000000-0000-4000-8000-00000000000b", costAccepted: true };
      const post = () =>
        f.app.request("/api/jobs", { method: "POST", headers: { Authorization: `Bearer ${tokenFor(owner)}`, "Content-Type": "application/json" }, body: JSON.stringify(manifest) });
      const responses = await Promise.all([post(), post()]);
      const bodies = await Promise.all(responses.map((r) => r.json()));
      const retry = await post();
      const strip = (body: any) => (body.job ? { ...body, job: { ...body.job, createdAt: 0, updatedAt: 0 } } : body);
      return {
        statuses: responses.map((r) => r.status),
        committed: bodies[responses.findIndex((r) => r.status === 201)]?.job,
        refused: bodies.find((body) => !body.job),
        retry: [retry.status, await retry.json()] as const,
        workflows: started.mock.calls.length,
        reservations: [...f.store.rows.values()].filter((row) => row.pk.startsWith("OUTPOINT#")).map((row) => row.pk).sort(),
        events: eventRows(f.store).length,
        strip,
      };
    };
    for (const recordEvents of [false, true]) {
      const r = await run(recordEvents);
      expect([...r.statuses].sort()).toEqual([201, 409]);
      expect(r.refused).toEqual({ error: "State changed. Refresh and try again.", code: "state_conflict" });
      // The same-key retry returns the committed job and starts its workflow again.
      expect(r.retry).toEqual([200, { job: r.committed }]);
      expect(r.workflows).toBe(2);
      expect(r.reservations).toEqual([`OUTPOINT#${"11".repeat(32)}:0`, `OUTPOINT#${"22".repeat(32)}:0`]);
      expect(r.events).toBe(recordEvents ? 1 : 0);
    }
    const [plain, recording] = [await run(false), await run(true)];
    const view = ({ strip, events, committed, retry, ...rest }: Awaited<ReturnType<typeof run>>) => ({
      ...rest,
      statuses: [...rest.statuses].sort(),
      committed: strip({ job: committed }),
      retry: [retry[0], strip(retry[1])],
    });
    expect(view(recording)).toEqual(view(plain));
  });
});

describe("the resend path", () => {
  it("records a submitted deposit the miner no longer has, after the resend decides, and nothing else changes", async () => {
    const address = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
    const scriptHex = "51".repeat(100);
    const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, version: 2 });
    tx.addInput({ txid: new Uint8Array(32).fill(3), index: 0, sequence: 0xfffffffe });
    tx.addOutput({ amount: 50_000n, script: hex.decode(scriptHex) });
    const raw = hex.encode(tx.toBytes(true, false));
    const run = async (outcome: "refused" | "accepted" | "known") => {
      const miner = new Slipstream("https://slipstream.test", async () => undefined);
      const f = await setup({ miner, exactSubmit: true });
      const a = await f.as(address);
      const id = crypto.randomUUID();
      await f.store.put({ pk: `OWNER#${address}`, sk: `VAULT#${id}`, version: 0, fundingRawTxHex: raw, fundingSubmission: "submitted", vault: {
        id, scriptHex, config: "A", publicStateJson: JSON.stringify({ config: "A", full_script_hex: scriptHex }),
        scriptHash: createHash("sha256").update(Buffer.from(scriptHex, "hex")).digest("hex"), paymentAddress: address, network: "mainnet", status: "submitted",
        funding: { txid: transactionId(raw), vout: 0, value: "50000" },
      } });
      vi.spyOn(miner, "credential").mockResolvedValue({} as never);
      const seen = vi.spyOn(miner, "seen").mockResolvedValue(outcome === "known");
      const submit = vi.spyOn(miner, "submitFunding").mockImplementation(async () => {
        if (outcome === "refused") throw new MinerRejection("txn-mempool-conflict");
        return { status: "success" as const, message: transactionId(raw) };
      });
      const response = await a.post(`/api/vaults/${id}/fund/resubmit`);
      const { fundingResubmittedAt, ...row } = (await f.store.get(`OWNER#${address}`, `VAULT#${id}`))!;
      return { status: response.status, body: await response.json(), row: { ...row, version: 0 }, seen: seen.mock.calls.length, posts: submit.mock.calls.length, events: (await recorded(f.store, address)).map((e) => [e.type, e.subjectId === id, e.status]) };
    };
    const refused = await run("refused");
    expect(refused).toMatchObject({ status: 201, body: { submission: "submitted", vault: { status: "submitted" } }, seen: 1, posts: 1, events: [["deposit.dropped", true, "dropped"]] });
    expect(refused.row).toMatchObject({ fundingSubmission: "submitted", vault: { status: "submitted" } });
    expect((await run("accepted")).events).toEqual([]);
    expect(await run("known")).toMatchObject({ posts: 0, events: [] });
  });
});

describe("error codes", () => {
  it("pass through the watched miner and the event recorder unchanged", async () => {
    const address = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
    const scriptHex = "51".repeat(100);
    const tx = new btc.Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true, version: 2 });
    tx.addInput({ txid: new Uint8Array(32).fill(6), index: 0, sequence: 0xfffffffe });
    tx.addOutput({ amount: 50_000n, script: hex.decode(scriptHex) });
    const raw = hex.encode(tx.toBytes(true, false));
    const miner = new Slipstream("https://slipstream.test", async () => undefined);
    const f = await setup({ miner, exactSubmit: true });
    const a = await f.as(address);
    const vault = (status: string, id = crypto.randomUUID()) => ({
      pk: `OWNER#${address}`, sk: `VAULT#${id}`, version: 0, fundingRawTxHex: raw, vault: {
        id, scriptHex, config: "A", publicStateJson: JSON.stringify({ config: "A", full_script_hex: scriptHex }),
        scriptHash: createHash("sha256").update(Buffer.from(scriptHex, "hex")).digest("hex"), paymentAddress: address, network: "mainnet", status,
        ...(status === "submitted" ? { funding: { txid: transactionId(raw), vout: 0, value: "50000" } } : {}),
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(miner, "credential").mockResolvedValue({} as never);
    // A miner error coded where it's thrown keeps its code through the resend path's watcher.
    const resend = vault("submitted");
    await f.store.put(resend);
    vi.spyOn(miner, "seen").mockImplementation(() =>
      withApiErrorCode("miner_request_failed", () => Promise.reject(new Error("upstream"))),
    );
    const refused = await a.post(`/api/vaults/${(resend.vault as PublicVault).id}/fund/resubmit`);
    expect({ status: refused.status, code: (await refused.json()).code }).toEqual({ status: 500, code: "miner_request_failed" });
    // So does a store error through the event recorder.
    const fresh = vault("unfunded");
    await f.store.put(fresh);
    const put = MemoryStore.prototype.put.bind(f.store);
    vi.spyOn(f.store, "put").mockImplementation((row, expected, options) =>
      row.sk === fresh.sk ? withApiErrorCode("chain_unavailable", () => Promise.reject(new Error("table"))) : put(row, expected, options),
    );
    const failed = await a.post(`/api/vaults/${(fresh.vault as PublicVault).id}/fund/submit`, { rawTxHex: raw, amount: "50000", costAccepted: true });
    expect({ status: failed.status, code: (await failed.json()).code }).toEqual({ status: 500, code: "chain_unavailable" });
  });
});

describe("operator notes", () => {
  it("lists every row the reconcile CLIs now write, and who can read webhook secrets", async () => {
    const runbook = readFileSync(path.join(process.cwd(), "docs/OPERATIONAL-RUNBOOK.md"), "utf8");
    // What a reconcile writes through the recorder beyond its own rows.
    const inner = new MemoryStore();
    await registerWebhook(inner, "owner-a", { url: "https://hooks.example.com/" }, receiver().resolve);
    const store = recordOwnerEvents(inner);
    const touched = new Set<string>();
    for (const method of ["put", "get", "atomicPut"] as const) {
      const original = (inner[method] as (...args: any[]) => Promise<any>).bind(inner);
      vi.spyOn(inner, method).mockImplementation((async (...args: any[]) => {
        const rows = method === "atomicPut" ? args[0].map((w: any) => w.row) : method === "put" ? [args[0]] : [{ sk: args[1] }];
        for (const row of rows) touched.add(String(row.sk).split("#")[0]);
        return original(...args);
      }) as never);
    }
    await store.atomicPut([{ row: { pk: "OWNER#owner-a", sk: "JOB#j", version: 0, job: { id: "j", status: "confirmed", stage: "verification" } } }]);
    await store.settle();
    // Both places that list what the reconcile CLIs need.
    const passages = [
      runbook.slice(runbook.indexOf("The CLI needs GetItem"), runbook.indexOf("Batch DescribeJobs")),
      runbook.slice(runbook.indexOf("This command records a conditional observation"), runbook.indexOf("It takes no transaction bytes")),
    ];
    for (const passage of passages)
      for (const kind of [...touched].filter((k) => k !== "JOB" && k !== "TX"))
        expect(passage).toContain(kind === "EVENT" ? "`EVENT#`" : `\`${kind}\``);
    const section = runbook.slice(runbook.indexOf("## Webhook signing secrets"));
    expect(section).toContain("coordinator role");
    expect(readFileSync(path.join(process.cwd(), "terraform/data.tf"), "utf8")).toMatch(/point_in_time_recovery \{ enabled = true \}/);
    expect(section).toContain("point-in-time recovery");
    expect(section).toContain("doesn't purge");
  });

  it("inventories event and webhook rows, leaving the signing secret out rather than refusing", async () => {
    const store = new MemoryStore();
    const { secret } = await registerWebhook(store, "owner-a", { url: "https://hooks.example.com/" }, receiver().resolve);
    const recorder = recordOwnerEvents(store);
    await recorder.put({ pk: "OWNER#owner-a", sk: "JOB#j", version: 0, job: { id: "j", status: "queued", stage: "pinning" } });
    await recorder.settle();
    const rows = [...store.rows.values()];
    const report = inventoryRows(rows);
    expect(report.counts).toMatchObject({ operational: 2, job: 1, unclassified: 0 });
    expect(report.unclassifiedKeys).toEqual([]);
    expect(JSON.stringify(inventorySnapshot({ rows }))).not.toContain(secret);
    expect(JSON.stringify(rows)).toContain(secret);
    // Only that field is dropped: anything else credential-shaped still refuses.
    expect(() => inventoryRows([...rows, { pk: "OWNER#owner-a", sk: "WEBHOOKS", version: 1, hooks: [], apiKey: "x" }])).toThrow(/CredentialMaterialRejected/);
  });
});

describe("webhooks", () => {
  it("registers at most five, shows each secret once and deletes", async () => {
    const f = await setup();
    const a = await f.as("owner-a");
    const secrets: string[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await a.post("/api/webhooks", { url: `https://hooks.example.com/${i}`, ...(i ? { events: ["withdrawal.awaiting_authorization"] } : {}) });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      expect(body.webhook).toMatchObject({ id: expect.stringMatching(/^wh_[a-f0-9]{24}$/), status: "active", events: i ? ["withdrawal.awaiting_authorization"] : null });
      secrets.push(body.secret);
    }
    const refused = await a.post("/api/webhooks", { url: "https://hooks.example.com/6" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "webhook_limit_reached" });
    const listed = await (await a.get("/api/webhooks")).text();
    for (const secret of secrets) expect(listed).not.toContain(secret);
    expect(listed).not.toContain("secret");
    const [first] = JSON.parse(listed).webhooks;
    expect(await (await a.post(`/api/webhooks/${first.id}/delete`)).json()).toEqual({ deleted: true });
    const again = await a.post(`/api/webhooks/${first.id}/delete`);
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ code: "webhook_not_found" });
    expect((await (await a.get("/api/webhooks")).json()).webhooks).toHaveLength(4);
    expect((await a.post("/api/webhooks", { url: "https://hooks.example.com/x", events: ["withdrawal.nope"] })).status).toBe(400);
  });

  it.each([
    ["http://hooks.example.com/", "webhook_url_invalid"],
    ["https://user:pass@hooks.example.com/", "webhook_url_invalid"],
    ["https://hooks.example.com:8443/", "webhook_url_invalid"],
    ["not a url", "webhook_url_invalid"],
    ["https://127.0.0.1/", "webhook_url_forbidden"],
    ["https://0x7f.1/", "webhook_url_forbidden"],
    ["https://10.1.2.3/", "webhook_url_forbidden"],
    ["https://100.64.0.1/", "webhook_url_forbidden"],
    ["https://169.254.169.254/latest/meta-data/", "webhook_url_forbidden"],
    ["https://192.168.1.1/", "webhook_url_forbidden"],
    ["https://224.0.0.1/", "webhook_url_forbidden"],
    ["https://[::1]/", "webhook_url_forbidden"],
    ["https://[fd00:ec2::254]/", "webhook_url_forbidden"],
    ["https://[fe80::1]/", "webhook_url_forbidden"],
    ["https://[::ffff:127.0.0.1]/", "webhook_url_forbidden"],
    ["https://localhost/", "webhook_url_forbidden"],
    ["https://api.localhost/", "webhook_url_forbidden"],
    ["https://intranet/", "webhook_url_forbidden"],
  ])("refuses %s with %s before resolving it", async (url, code) => {
    const f = await setup();
    const response = await (await f.as("owner-a")).post("/api/webhooks", { url });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code });
    expect(f.hooks.resolve).not.toHaveBeenCalled();
  });

  it.each([
    [["10.0.0.5"], "webhook_url_forbidden"],
    [[PUBLIC, "172.16.0.1"], "webhook_url_forbidden"],
    [["fd12::1"], "webhook_url_forbidden"],
    [[], "webhook_url_unresolvable"],
  ])("refuses a host name that resolves to %j", async (addresses, code) => {
    const f = await setup();
    const a = await f.as("owner-a");
    f.hooks.resolve.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
    const response = await a.post("/api/webhooks", { url: "https://rebind.example.com/" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code });
    f.hooks.resolve.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    expect(await (await a.post("/api/webhooks", { url: "https://gone.example.com/" })).json()).toMatchObject({ code: "webhook_url_unresolvable" });
    expect(await (await a.get("/api/webhooks")).json()).toEqual({ webhooks: [] });
  });

  it("classifies addresses", () => {
    for (const address of [PUBLIC, "8.8.8.8", "2606:4700:4700::1111"]) expect(publicAddress(address)).toBe(true);
    for (const address of ["0.0.0.0", "127.0.0.53", "10.0.0.1", "100.127.255.255", "169.254.169.254", "172.31.255.255", "192.0.2.1", "192.168.0.1", "198.18.0.1", "203.0.113.9", "239.255.255.250", "255.255.255.255", "::", "::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2001:db8::1", "2002:c000:0201::1", "fc00::1", "fe80::1", "ff02::1", "example.com"])
      expect(publicAddress(address)).toBe(false);
  });

  it("registers webhooks only for allowlisted owners when there's a list; reads and deletion stay open", async () => {
    const f = await setup({ ownerLimits: { allowlist: new Set(["owner-a"]), maxActiveJobs: null, maxGpuSeconds: null } });
    const a = await f.as("owner-a"),
      b = await f.as("owner-b");
    expect((await a.post("/api/webhooks", { url: "https://hooks.example.com/a" })).status).toBe(201);
    const refused = await b.post("/api/webhooks", { url: "https://hooks.example.com/b" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "owner_not_allowlisted" });
    expect(f.hooks.resolve).toHaveBeenCalledOnce();
    expect(await (await b.get("/api/webhooks")).json()).toEqual({ webhooks: [] });
    expect((await b.post("/api/webhooks/wh_missing/delete")).status).toBe(404);
  });

  it("ignores Idempotency-Key on registration, so no response with a secret is ever stored or replayed", async () => {
    const f = await setup();
    const token = tokenFor("owner-a");
    await f.as("owner-a");
    const register = () =>
      f.app.request("/api/webhooks", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "register-once-1" },
        body: JSON.stringify({ url: "https://hooks.example.com/" }),
      });
    const [first, second] = [await register(), await register()];
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.headers.get("Idempotency-Replayed")).toBeNull();
    const [a, b] = [await first.json(), await second.json()];
    expect(a.webhook.id).not.toBe(b.webhook.id);
    expect(a.secret).not.toBe(b.secret);
    const rows = [...f.store.rows.values()];
    expect(rows.filter((row) => row.sk.startsWith("IDEMPOTENCY#"))).toEqual([]);
    for (const secret of [a.secret, b.secret])
      expect(rows.filter((row) => JSON.stringify(row).includes(secret)).map((row) => row.sk)).toEqual(["WEBHOOKS"]);
  });

  it("records no event for an idempotent replay, which doesn't run the handler", async () => {
    const f = await setup({ versionedAlias: true });
    const token = tokenFor("owner-a");
    await f.as("owner-a");
    const job = await seedJob(f.store, "owner-a");
    const pause = () =>
      f.app.request(`/v1/jobs/${job.id}/pause`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": "pause-once-01" },
      });
    const first = await pause();
    const replay = await pause();
    expect([first.status, replay.status]).toEqual([200, 200]);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await recorded(f.store, "owner-a")).map((e) => e.type)).toEqual(["withdrawal.paused"]);
  });

  it("delivers a signed, thin notification to the address it checked", async () => {
    const f = await setup();
    const a = await f.as("owner-a");
    const { secret } = await (await a.post("/api/webhooks", { url: "https://hooks.example.com/qsb?tag=1" })).json();
    const job = await seedJob(f.store, "owner-a");
    await a.post(`/api/jobs/${job.id}/pause`);
    expect(f.hooks.calls).toHaveLength(1);
    const [request] = f.hooks.calls;
    expect(request).toMatchObject({ url: "https://hooks.example.com/qsb?tag=1", hostname: "hooks.example.com", address: PUBLIC, family: 4 });
    const event = JSON.parse(request.body);
    expect(event).toEqual({ id: expect.any(String), type: "withdrawal.paused", subjectId: job.id, status: "paused", stage: "pinning", at: expect.any(String) });
    expect(request.headers["qsb-event-id"]).toBe(event.id);
    const [, t, v1] = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(request.headers["qsb-signature"])!;
    expect(Math.abs(Number(t) - Date.now() / 1000)).toBeLessThan(5);
    const expected = createHmac("sha256", secret).update(`${t}.${request.body}`).digest();
    expect(timingSafeEqual(expected, Buffer.from(v1, "hex"))).toBe(true);
    expect(await (await a.get("/api/webhooks")).json()).toMatchObject({ webhooks: [{ failures: 0, pending: 0, lastDeliveryAt: expect.any(String) }] });
    // The event is in the log whether or not the webhook arrived; it is the record.
    expect((await recorded(f.store, "owner-a")).map((e) => e.id)).toEqual([event.id]);
  });

  it("checks every resolved address and connects to an IPv4 one", async () => {
    const f = await setup();
    const a = await f.as("owner-a");
    f.hooks.resolve.mockResolvedValue([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: PUBLIC, family: 4 },
    ]);
    await a.post("/api/webhooks", { url: "https://dual.example.com/" });
    await a.post(`/api/jobs/${(await seedJob(f.store, "owner-a")).id}/pause`);
    expect(f.hooks.calls[0]).toMatchObject({ hostname: "dual.example.com", address: PUBLIC, family: 4 });
    expect(f.hooks.resolve).toHaveBeenLastCalledWith("dual.example.com", expect.any(Number));
  });

  it("delivers only subscribed event types", async () => {
    const f = await setup();
    const a = await f.as("owner-a");
    await a.post("/api/webhooks", { url: "https://hooks.example.com/", events: ["withdrawal.failed"] });
    const job = await seedJob(f.store, "owner-a");
    await a.post(`/api/jobs/${job.id}/pause`);
    expect(f.hooks.transport).not.toHaveBeenCalled();
  });

  it("refuses to connect when the name has since moved to a private address", async () => {
    const f = await setup();
    const a = await f.as("owner-a");
    await a.post("/api/webhooks", { url: "https://rebind.example.com/" });
    f.hooks.resolve.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    await a.post(`/api/jobs/${(await seedJob(f.store, "owner-a")).id}/pause`);
    expect(f.hooks.transport).not.toHaveBeenCalled();
    expect((await (await a.get("/api/webhooks")).json()).webhooks[0]).toMatchObject({ failures: 1, lastError: "url_forbidden", pending: 1 });
  });

  it.each(["hangs", "throws"])("answers on time and unchanged when the receiver %s", async (mode) => {
    const run = async (withHook: boolean) => {
      const f = await setup();
      f.hooks.transport.mockImplementation(mode === "hangs" ? () => new Promise(() => {}) : async () => { throw new Error("ECONNRESET"); });
      const a = await f.as("owner-a");
      if (withHook) await a.post("/api/webhooks", { url: "https://hooks.example.com/" });
      const job = await seedJob(f.store, "owner-a", { id: "00000000-0000-4000-8000-000000000001", vaultId: "00000000-0000-4000-8000-000000000002" });
      const started = Date.now();
      const response = await a.post(`/api/jobs/${job.id}/pause`);
      const body = await response.json();
      return { status: response.status, elapsed: Date.now() - started, job: { ...body.job, updatedAt: undefined }, webhooks: (await (await a.get("/api/webhooks")).json()).webhooks };
    };
    const plain = await run(false),
      hooked = await run(true);
    expect(hooked.status).toBe(plain.status);
    expect(hooked.job).toEqual(plain.job);
    expect(hooked.elapsed).toBeLessThan(4500);
    expect(hooked.webhooks[0]).toMatchObject({ failures: 1, lastError: mode === "hangs" ? "timeout" : "network", pending: 1 });
  }, 15_000);
});

describe("webhook retries", () => {
  async function queued() {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-09-29T00:00:00.000Z") });
    const store = new MemoryStore();
    const hooks = receiver(500);
    await registerWebhook(store, "owner-a", { url: "https://hooks.example.com/" }, hooks.resolve);
    const event = { id: `evt_${"a".repeat(32)}`, type: "withdrawal.searching", subjectId: "j", status: "searching", at: new Date().toISOString() } as OwnerEvent;
    await enqueueDeliveries(store, "owner-a", [event, event]);
    const flush = () => deliverDue(store, "owner-a", hooks, { deadline: Date.now() + 3000 });
    const hook = async () => ((await store.get("OWNER#owner-a", "WEBHOOKS"))!.hooks as any[])[0];
    return { store, hooks, flush, hook, event };
  }

  it("backs off after a failure, then delivers and resets", async () => {
    const f = await queued();
    await f.flush();
    expect(f.hooks.transport).toHaveBeenCalledTimes(1);
    expect(await f.hook()).toMatchObject({ failures: 1, lastError: "http_500", retryAt: Date.now() + RETRY_DELAYS_MS[0] });
    await f.flush();
    expect(f.hooks.transport).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + RETRY_DELAYS_MS[0]);
    f.hooks.transport.mockResolvedValue({ status: 200 });
    await f.flush();
    expect(f.hooks.transport).toHaveBeenCalledTimes(2);
    expect(await f.hook()).toMatchObject({ failures: 0, status: "active" });
    expect((await f.store.get("OWNER#owner-a", "WEBHOOKS"))!.pending).toEqual([]);
  });

  it(`marks a webhook failing after ${FAILING_AFTER} failed rounds and stops sending`, async () => {
    const f = await queued();
    for (let round = 0; round < FAILING_AFTER; round++) {
      await f.flush();
      vi.setSystemTime(Date.now() + RETRY_DELAYS_MS.at(-1)!);
    }
    expect(f.hooks.transport).toHaveBeenCalledTimes(FAILING_AFTER);
    expect(await f.hook()).toMatchObject({ status: "failing", failures: FAILING_AFTER });
    await enqueueDeliveries(f.store, "owner-a", [{ ...f.event, id: `evt_${"b".repeat(32)}` }]);
    await f.flush();
    expect(f.hooks.transport).toHaveBeenCalledTimes(FAILING_AFTER);
    expect((await f.store.get("OWNER#owner-a", "WEBHOOKS"))!.pending).toEqual([]);
  });

  it("a round that outlived its lease leaves a delivery another round has claimed alone", async () => {
    const f = await queued();
    const answers: ((status: number) => void)[] = [];
    f.hooks.transport.mockImplementation(() => new Promise((resolve) => answers.push((status) => resolve({ status }))));
    const stale = f.flush();
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    // Frozen past its lease: another round claims the same delivery and is still sending it.
    vi.setSystemTime(Date.now() + LEASE_MS + 1);
    const fresh = f.flush();
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[0](500);
    await stale;
    const [pending] = (await f.store.get("OWNER#owner-a", "WEBHOOKS"))!.pending as any[];
    expect(pending.nextAt).toBeGreaterThan(Date.now());
    expect(pending.attempts).toBe(0);
    expect(await f.hook()).toMatchObject({ failures: 0 });
    // So a third round still doesn't send it again.
    await f.flush();
    expect(f.hooks.transport).toHaveBeenCalledTimes(2);
    answers[1](200);
    await fresh;
    expect((await f.store.get("OWNER#owner-a", "WEBHOOKS"))!.pending).toEqual([]);
  });

  it("a round that outlived its lease counts no failure, and releases its delivery", async () => {
    const f = await queued();
    let answer!: (status: number) => void;
    f.hooks.transport.mockImplementation(() => new Promise((resolve) => (answer = (status) => resolve({ status }))));
    const stale = f.flush();
    await vi.waitFor(() => expect(f.hooks.transport).toHaveBeenCalledOnce());
    vi.setSystemTime(Date.now() + LEASE_MS + 1);
    answer(500);
    await stale;
    expect(await f.hook()).toMatchObject({ failures: 0 });
    expect((await f.store.get("OWNER#owner-a", "WEBHOOKS"))!.pending).toMatchObject([{ attempts: 0, nextAt: 0 }]);
  });

  it("does not send a delivery that another flush has claimed", async () => {
    const f = await queued();
    let finish!: () => void;
    f.hooks.transport.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ status: 200 }); }));
    const first = f.flush();
    await vi.waitFor(() => expect(f.hooks.transport).toHaveBeenCalledTimes(1));
    await f.flush();
    finish();
    await first;
    expect(f.hooks.transport).toHaveBeenCalledTimes(1);
  });
});
