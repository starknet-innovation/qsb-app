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
import {
  EVENT_SETTLE_MS,
  listOwnerEvents,
  recordOwnerEvents,
  type OwnerEvent,
} from "../server/owner-events";
import {
  FAILING_AFTER,
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

  it("returns from a write without waiting for its event, and bounds the wait at settle", async () => {
    const inner = new MemoryStore();
    const store = recordOwnerEvents(inner);
    const put = inner.put.bind(inner);
    vi.spyOn(inner, "put").mockImplementation((row, expected) =>
      row.sk.startsWith("EVENT#") ? new Promise(() => {}) : put(row, expected),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await store.put({ pk: "OWNER#a", sk: "JOB#j", version: 0, job: { id: "j", status: "queued", stage: "pinning" } });
    expect((await inner.get("OWNER#a", "JOB#j"))?.job).toMatchObject({ status: "queued" });
    const started = Date.now();
    await store.settle({ budgetMs: 200 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("keeps the caller's write when the event write fails, and records the event at settle", async () => {
    const inner = new MemoryStore();
    const store = recordOwnerEvents(inner);
    const put = inner.put.bind(inner);
    let failing = true;
    vi.spyOn(inner, "put").mockImplementation(async (row, expected) => {
      if (row.sk.startsWith("EVENT#") && failing) throw new Error("throttled");
      return put(row, expected);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await store.put({ pk: "OWNER#a", sk: "JOB#j", version: 0, job: { id: "j", status: "queued", stage: "pinning" } });
    expect((await inner.get("OWNER#a", "JOB#j"))?.job).toMatchObject({ status: "queued" });
    expect(eventRows(inner)).toHaveLength(0);
    failing = false;
    await store.settle();
    expect((await recorded(inner, "a")).map((e) => e.type)).toEqual(["withdrawal.queued"]);
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
    const flush = () => deliverDue(store, "owner-a", hooks, Date.now() + 3000);
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
