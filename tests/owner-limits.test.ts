import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { SFNClient } from "@aws-sdk/client-sfn";
// Hermetic: synthetic keys and outpoints, an injected chain and miner, no network.
vi.mock("../src/lib/releases/registry.generated", async () => {
  const { servedFixture, otherFixture } = await import("./solver-fixture");
  return { default: [servedFixture, otherFixture] };
});
import { createApp } from "../server/app";
import { Conflict, MemoryStore, type AtomicWrite } from "../server/store";
import {
  ACTIVE_JOBS_SK,
  GPU_SECONDS_SK,
  OwnerLimitsInvalid,
  claimWithdrawalSlot,
  ownerLimits,
  type OwnerLimits,
} from "../server/owner-limits";
import { fixtureVault, servedFixture } from "./solver-fixture";
import type { Job } from "../src/lib/model";

const payment = btc.p2wpkh(
  hex.decode("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
);
const owner = payment.address!;
const outsider = btc.p2wpkh(
  hex.decode("02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"),
).address!;
const pk = `OWNER#${owner}`;
const token = "a".repeat(43);
const off = (): OwnerLimits => ({ allowlist: null, maxActiveJobs: null, maxGpuSeconds: null });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture(limits?: OwnerLimits, store = new MemoryStore()) {
  vi.stubEnv("SOLVER_RELEASE_ID", servedFixture.id);
  vi.stubEnv("WORKFLOW_ARN", "arn:aws:states:eu-west-1:123456789012:stateMachine:test");
  await store.put({
    pk: `SESSION#${createHash("sha256").update(token).digest("hex")}`,
    sk: "AUTH",
    version: 0,
    owner,
    network: "mainnet",
  });
  const chain = { unspent: vi.fn().mockResolvedValue({}), raw: vi.fn(), status: vi.fn() };
  const miner = { submit: vi.fn(), test: vi.fn(), credential: vi.fn(), rates: vi.fn() };
  const app = createApp(store, {
    enabled: true,
    exactSubmit: true,
    chain: chain as any,
    miner: miner as any,
    ...(limits ? { ownerLimits: limits } : {}),
  });
  const workflow = vi.spyOn(SFNClient.prototype, "send").mockResolvedValue({} as never);
  let vaults = 0;
  // A confirmed vault with its own outpoints, and a withdrawal manifest for it.
  async function withdrawal() {
    vaults++;
    const funding = { txid: (0x10 + vaults).toString(16).repeat(32), vout: 0, value: "1000" };
    const vault = { ...fixtureVault, id: crypto.randomUUID(), status: "confirmed", funding };
    await store.put({ pk, sk: `VAULT#${vault.id}`, version: 0, vault });
    return {
      vaultId: vault.id,
      funding,
      helper: { txid: (0x80 + vaults).toString(16).repeat(32), vout: 0, value: "500" },
      destination: owner,
      outputScript: hex.encode(payment.script),
      outputValue: "1200",
      fee: "300",
      idempotencyKey: crypto.randomUUID(),
      costAccepted: true,
    };
  }
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const post = (path: string, body: unknown = {}) =>
    app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  const get = (path: string, auth = true) => app.request(path, auth ? { headers } : {});
  const snapshot = () => structuredClone([...store.rows]);
  // Every row but vaults, which the fixture adds for each new manifest.
  const written = () => snapshot().filter(([key]) => !key.includes("|VAULT#"));
  const jobs = () => [...store.rows.values()].filter((r) => r.sk.startsWith("JOB#"));
  const setStatus = async (id: string, status: Job["status"]) => {
    const row = (await store.get(pk, `JOB#${id}`))!;
    await store.put({ ...row, version: row.version + 1, job: { ...(row.job as Job), status } }, row.version);
  };
  return { store, app, chain, miner, workflow, withdrawal, post, get, snapshot, written, jobs, setStatus };
}

describe("configuration", () => {
  it("is off when unset or empty", () => {
    expect(ownerLimits({})).toEqual(off());
    expect(
      ownerLimits({ QSB_OWNER_ALLOWLIST: " , ", QSB_OWNER_MAX_ACTIVE_JOBS: "", QSB_OWNER_MAX_GPU_SECONDS: " " }),
    ).toEqual(off());
  });
  it("reads the allowlist and positive integer limits", () => {
    expect(
      ownerLimits({
        QSB_OWNER_ALLOWLIST: ` ${owner} ,${outsider}`,
        QSB_OWNER_MAX_ACTIVE_JOBS: "2",
        QSB_OWNER_MAX_GPU_SECONDS: " 3600 ",
      }),
    ).toEqual({ allowlist: new Set([owner, outsider]), maxActiveJobs: 2, maxGpuSeconds: 3600 });
  });
  it.each(["0", "-1", "1.5", "1e3", "abc", "9007199254740993"])("refuses a malformed limit %s", (value) => {
    expect(() => ownerLimits({ QSB_OWNER_MAX_ACTIVE_JOBS: value })).toThrow(OwnerLimitsInvalid);
    expect(() => ownerLimits({ QSB_OWNER_MAX_GPU_SECONDS: value })).toThrow(OwnerLimitsInvalid);
  });
});

describe("defaults", () => {
  it("create withdrawals as before and report the limits as off", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) expect((await f.post("/api/jobs", await f.withdrawal())).status).toBe(201);
    expect([...f.store.rows.keys()].filter((k) => k.includes("LIMIT#"))).toEqual([]);
    expect((await (await f.get("/api/config")).json()).ownerLimits).toEqual({
      allowlist: false,
      allowlisted: null,
      maxActiveJobs: null,
      maxGpuSeconds: null,
    });
  });
});

describe("owner allowlist", () => {
  it("refuses every cost- or funds-moving route for an unlisted owner, writing and starting nothing", async () => {
    const limits = off();
    const f = await fixture(limits);
    const manifest = await f.withdrawal();
    expect((await f.post("/api/jobs", manifest)).status).toBe(201);
    const paused = await f.withdrawal();
    const created = await (await f.post("/api/jobs", paused)).json();
    await f.setStatus(created.job.id, "paused");
    f.workflow.mockClear();
    f.chain.unspent.mockClear();
    limits.allowlist = new Set([outsider]);
    const before = f.written();
    const vaultId = manifest.vaultId;
    for (const [method, path, body] of [
      ["POST", "/api/vaults", { ...fixtureVault, id: crypto.randomUUID(), status: "unfunded", paymentAddress: owner }],
      ["POST", `/api/vaults/${vaultId}/fund`, { txid: "11".repeat(32), amount: "1000", costAccepted: true }],
      ["POST", `/api/vaults/${vaultId}/fund/submit`, { rawTxHex: "00", amount: "1000", costAccepted: true }],
      ["GET", `/api/vaults/${vaultId}/fund/signed`],
      ["POST", `/api/vaults/${vaultId}/fund/resubmit`, {}],
      ["POST", "/api/jobs", await f.withdrawal()],
      ["POST", "/api/jobs", manifest],
      ["POST", `/api/jobs/${created.job.id}/resume`, {}],
    ] as const) {
      const response = method === "GET" ? await f.get(path) : await f.post(path, body);
      expect([path, response.status]).toEqual([path, 403]);
      expect(await response.json()).toEqual({
        error: "This wallet is not on this deployment's allowlist.",
        code: "owner_not_allowlisted",
      });
    }
    expect(f.written()).toEqual(before);
    expect(f.workflow).not.toHaveBeenCalled();
    expect(f.chain.unspent).not.toHaveBeenCalled();
    expect(f.chain.raw).not.toHaveBeenCalled();
    expect(f.miner.submit).not.toHaveBeenCalled();
    expect(f.miner.test).not.toHaveBeenCalled();
  });

  it("keeps sign-in, reads, pause and the withdrawal submit open for an unlisted owner", async () => {
    const limits = off();
    const f = await fixture(limits);
    const created = await (await f.post("/api/jobs", await f.withdrawal())).json();
    limits.allowlist = new Set([outsider]);
    expect((await f.post("/api/auth/challenge", { address: owner })).status).toBe(200);
    expect((await f.get("/api/vaults")).status).toBe(200);
    expect((await f.get("/api/jobs")).status).toBe(200);
    expect((await f.get(`/api/jobs/${created.job.id}/status`)).status).toBe(200);
    expect((await f.post(`/api/jobs/${created.job.id}/pause`)).status).toBe(200);
    // Submitting a solved withdrawal returns the owner's own funds; it is never gated here.
    expect((await f.post(`/api/jobs/${created.job.id}/submit`, { rawTxHex: "00" })).status).not.toBe(403);
  });

  it("lets a listed owner through and reports only the caller's own standing", async () => {
    const limits = { ...off(), allowlist: new Set([owner, "bc1qlisted"]) };
    const f = await fixture(limits);
    expect((await f.post("/api/jobs", await f.withdrawal())).status).toBe(201);
    const listed = await (await f.get("/api/config")).text();
    expect(JSON.parse(listed).ownerLimits).toMatchObject({ allowlist: true, allowlisted: true });
    expect((await (await f.get("/api/config", false)).json()).ownerLimits).toMatchObject({ allowlisted: null });
    limits.allowlist = new Set([outsider]);
    const unlisted = await (await f.get("/api/config")).text();
    expect(JSON.parse(unlisted).ownerLimits).toMatchObject({ allowlist: true, allowlisted: false });
    for (const text of [listed, unlisted]) {
      expect(text).not.toContain(outsider);
      expect(text).not.toContain("bc1qlisted");
    }
  });

  it("is read from QSB_OWNER_ALLOWLIST", async () => {
    const f = await fixture();
    vi.stubEnv("QSB_OWNER_ALLOWLIST", outsider);
    expect((await f.post("/api/jobs", await f.withdrawal())).status).toBe(403);
    vi.stubEnv("QSB_OWNER_ALLOWLIST", `${outsider},${owner}`);
    expect((await f.post("/api/jobs", await f.withdrawal())).status).toBe(201);
  });

  it("refuses, writing nothing, when a limit is malformed", async () => {
    const f = await fixture();
    vi.stubEnv("QSB_OWNER_MAX_ACTIVE_JOBS", "two");
    const before = f.written();
    const response = await f.post("/api/jobs", await f.withdrawal());
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("owner_limits_invalid");
    expect(f.jobs()).toHaveLength(0);
    expect(f.written()).toEqual(before);
    expect(f.workflow).not.toHaveBeenCalled();
    // Reads stay open: the config reports no limits rather than failing.
    const config = await f.get("/api/config");
    expect(config.status).toBe(200);
    expect((await config.json()).ownerLimits).toBeNull();
    expect((await f.get("/api/jobs")).status).toBe(200);
  });
});

describe("active withdrawals per owner", () => {
  const limited = (maxActiveJobs: number): OwnerLimits => ({ ...off(), maxActiveJobs });

  it("refuses a withdrawal over the limit without writing a job or reservation", async () => {
    const f = await fixture(limited(1));
    expect((await f.post("/api/jobs", await f.withdrawal())).status).toBe(201);
    expect(await f.store.get(pk, ACTIVE_JOBS_SK)).toMatchObject({ version: 0 });
    f.workflow.mockClear();
    const before = f.written();
    const response = await f.post("/api/jobs", await f.withdrawal());
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "owner_active_withdrawal_limit" });
    expect(f.written()).toEqual(before);
    expect(f.jobs()).toHaveLength(1);
    expect([...f.store.rows.keys()].filter((k) => k.startsWith("OUTPOINT#"))).toHaveLength(2);
    expect(f.workflow).not.toHaveBeenCalled();
  });

  it("replays the same idempotency key without taking a slot", async () => {
    const f = await fixture(limited(1));
    const manifest = await f.withdrawal();
    const created = await (await f.post("/api/jobs", manifest)).json();
    const before = f.snapshot();
    const replay = await f.post("/api/jobs", manifest);
    expect(replay.status).toBe(200);
    expect((await replay.json()).job).toEqual(created.job);
    expect(f.snapshot()).toEqual(before);
  });

  it.each(["failed", "awaiting_authorization", "submitted", "confirmed"] as const)(
    "releases the slot when a withdrawal is %s",
    async (status) => {
      const f = await fixture(limited(1));
      const created = await (await f.post("/api/jobs", await f.withdrawal())).json();
      await f.setStatus(created.job.id, status);
      expect((await f.post("/api/jobs", await f.withdrawal())).status).toBe(201);
      expect(await f.store.get(pk, ACTIVE_JOBS_SK)).toMatchObject({ version: 1 });
    },
  );

  it.each(["queued", "searching", "paused"] as const)("keeps the slot while a withdrawal is %s", async (status) => {
    const f = await fixture(limited(1));
    const created = await (await f.post("/api/jobs", await f.withdrawal())).json();
    await f.setStatus(created.job.id, status);
    expect((await f.post("/api/jobs", await f.withdrawal())).status).toBe(429);
  });

  it("counts withdrawals created before the limit was set", async () => {
    const limits = off();
    const f = await fixture(limits);
    for (let i = 0; i < 2; i++) expect((await f.post("/api/jobs", await f.withdrawal())).status).toBe(201);
    limits.maxActiveJobs = 2;
    expect((await f.post("/api/jobs", await f.withdrawal())).status).toBe(429);
  });

  it("fails a claim whose count went stale before its write", async () => {
    const store = new MemoryStore();
    const list = store.list.bind(store);
    const queued = (id: string) => ({ row: { pk, sk: `JOB#${id}`, version: 0, job: { status: "queued" } } });
    vi.spyOn(store, "list").mockImplementationOnce(async (rowPk, prefix) => {
      const stale = await list(rowPk, prefix);
      // Another creation takes the last slot between this count and the claim's write.
      await store.atomicPut([queued("other"), (await claimWithdrawalSlot(store, owner, "other", 1))!]);
      return stale;
    });
    const claim = await claimWithdrawalSlot(store, owner, "mine", 1);
    expect(claim).toBeDefined();
    await expect(store.atomicPut([queued("mine"), claim!])).rejects.toThrow(Conflict);
    expect(await store.get(pk, "JOB#mine")).toBeUndefined();
  });

  it.each([0, 1])("gives exactly one of two concurrent creations the last slot (%s already active)", async (active) => {
    const store = new MemoryStore();
    const f = await fixture(limited(active + 1), store);
    for (let i = 0; i < active; i++) expect((await f.post("/api/jobs", await f.withdrawal())).status).toBe(201);
    const [a, b] = [await f.withdrawal(), await f.withdrawal()];
    // Both requests read the fence and count before either commits.
    const commit = store.atomicPut.bind(store);
    let arrived = 0;
    let both!: () => void;
    const ready = new Promise<void>((resolve) => (both = resolve));
    vi.spyOn(store, "atomicPut").mockImplementation(async (writes: AtomicWrite[]) => {
      if (++arrived === 2) both();
      await ready;
      return commit(writes);
    });
    const responses = await Promise.all([f.post("/api/jobs", a), f.post("/api/jobs", b)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = responses[0].status === 201 ? a : b,
      loser = winner === a ? b : a;
    expect(f.jobs()).toHaveLength(active + 1);
    expect(await store.get(pk, `JOB#${loser.idempotencyKey}`)).toBeUndefined();
    for (const point of [loser.funding, loser.helper])
      expect(await store.get(`OUTPOINT#${point.txid}:${point.vout}`, "RESERVATION")).toBeUndefined();
    for (const point of [winner.funding, winner.helper])
      expect(await store.get(`OUTPOINT#${point.txid}:${point.vout}`, "RESERVATION")).toMatchObject({
        jobId: winner.idempotencyKey,
      });
  });
});

describe("owner GPU budget at creation", () => {
  it.each([
    [900, 201],
    [901, 429],
  ])("with %s seconds already reserved of 1800", async (reservedSeconds, status) => {
    const f = await fixture({ ...off(), maxGpuSeconds: 1800 });
    await f.store.put({ pk, sk: GPU_SECONDS_SK, version: 0, reservedSeconds });
    const before = f.written();
    const response = await f.post("/api/jobs", await f.withdrawal());
    expect(response.status).toBe(status);
    if (status === 429) {
      expect(await response.json()).toMatchObject({ code: "owner_gpu_budget_reached" });
      expect(f.written()).toEqual(before);
      expect(f.workflow).not.toHaveBeenCalled();
    }
    // Creation reserves nothing: the coordinator charges the budget before each paid POST.
    expect(await f.store.get(pk, GPU_SECONDS_SK)).toMatchObject({ version: 0, reservedSeconds });
  });

  it("reports the effective limits", async () => {
    const f = await fixture({ ...off(), maxActiveJobs: 2, maxGpuSeconds: 3600 });
    expect((await (await f.get("/api/config")).json()).ownerLimits).toEqual({
      allowlist: false,
      allowlisted: null,
      maxActiveJobs: 2,
      maxGpuSeconds: 3600,
    });
  });
});
