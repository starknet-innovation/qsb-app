import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { Esplora } from "../server/chain";
import { Slipstream } from "../server/providers";
import { leaseSeconds } from "../server/idempotency";
import { transactionId } from "../server/runtime/miner-inclusion";
import { buildStoredSpendRecord } from "../server/job-spend-record";
import { inventoryRows } from "../server/runtime/storage-authority";
import { outputScript } from "../src/lib/transactions";
import { BITCOIN_NETWORK } from "../src/lib/network";
import type { Job, PublicVault, Withdrawal } from "../src/lib/model";

// Unsigned or placeholder-signed transactions only: no keys are needed or used.
const opts = { allowUnknownOutputs: true, allowUnknownInputs: true };
const owner = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
const other = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20).fill(9) });
const tokens = { [owner]: "A".repeat(43), [other]: "C".repeat(43) };
const scriptHex = "51".repeat(100);
const scriptHash = createHash("sha256").update(Buffer.from(scriptHex, "hex")).digest("hex");
const key = "k-0123456789abcdef";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network is not available in tests"); }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function vaultFor(paymentAddress: string, status: PublicVault["status"] = "unfunded"): PublicVault {
  return {
    id: randomUUID(),
    name: "cold-1",
    createdAt: new Date().toISOString(),
    network: "mainnet",
    config: "A",
    scriptHex,
    scriptHash,
    paymentAddress,
    publicStateJson: JSON.stringify({ config: "A", hash_mode: "sha256", n: 150, round_sigs: [], full_script_hex: scriptHex }),
    status,
  } as PublicVault;
}

function deposit(seed = 1) {
  const tx = new btc.Transaction({ ...opts, version: 2 });
  tx.addInput({ txid: new Uint8Array(32).fill(seed), index: 0, sequence: 0xfffffffe });
  tx.addOutput({ amount: 50_000n, script: hex.decode(scriptHex) });
  tx.addOutputAddress(owner, 40_000n, BITCOIN_NETWORK);
  return hex.encode(tx.toBytes(true, false));
}

/** A coordinator withdrawal awaiting authorization, and the exact transaction it authorizes. */
function withdrawal(vault: PublicVault) {
  const manifest: Withdrawal = {
    vaultId: vault.id,
    funding: vault.funding!,
    helper: { txid: "22".repeat(32), vout: 1, value: "10000" },
    destination: owner,
    outputScript: hex.encode(outputScript(owner)),
    outputValue: "90000",
    fee: "20000",
    idempotencyKey: randomUUID(),
    costAccepted: true,
  };
  const job: Job = {
    id: manifest.idempotencyKey,
    owner,
    vaultId: vault.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "awaiting_authorization",
    stage: "verification",
    manifest,
    manifestHash: "ab".repeat(32),
    attempt: 0,
    computeSeconds: 0,
    solution: { sequence: 0x80000000, locktime: 500000000, round1: [0, 1, 2, 3, 4, 5, 6, 7, 8], round2: [9, 10, 11, 12, 13, 14, 15, 16, 17] },
    revision: 0,
  };
  const record = buildStoredSpendRecord(job);
  const tx = new btc.Transaction({ version: 1, lockTime: record.locktime, ...opts });
  tx.addInput({ txid: record.helper.txid, index: record.helper.vout, sequence: 0xfffffffe });
  tx.addInput({ txid: record.funding.txid, index: record.funding.vout, sequence: record.sequence });
  tx.addOutput({ script: hex.decode(record.outputScript), amount: BigInt(record.outputValue) });
  tx.updateInput(0, { finalScriptWitness: [Uint8Array.of(0x30, 0x01), Uint8Array.of(0x02)] }, true);
  tx.updateInput(1, { finalScriptSig: Uint8Array.of(0x01) }, true);
  return { job, raw: hex.encode(tx.toBytes(true, true)) };
}

async function fixture() {
  const store = new MemoryStore();
  for (const address of [owner, other])
    await store.put({
      pk: `SESSION#${createHash("sha256").update(tokens[address]).digest("hex")}`,
      sk: "AUTH",
      version: 0,
      owner: address,
      network: "mainnet",
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400,
    });
  const vault = vaultFor(owner);
  await store.put({ pk: `OWNER#${owner}`, sk: `VAULT#${vault.id}`, version: 0, vault });
  const chain = new Esplora("https://chain.test", async () => new Response("", { status: 500 }));
  vi.spyOn(chain, "unspent").mockResolvedValue({ previousTxHex: "00", confirmations: 1 });
  const miner = new Slipstream("https://slipstream.mara.com", async () => undefined);
  const submitFunding = vi.spyOn(miner, "submitFunding").mockImplementation(async (raw: string) => ({ status: "success" as const, message: transactionId(raw) }));
  const submit = vi.spyOn(miner, "submit").mockImplementation(async (raw: string) => ({ status: "success" as const, message: transactionId(raw) }));
  const seen = vi.spyOn(miner, "seen").mockResolvedValue(false);
  const credential = vi.spyOn(miner, "credential");
  const consensus = { verify: vi.fn(async () => {}) };
  const app = createApp(store, { chain, miner, consensus, enabled: true, exactSubmit: true });
  const call = (
    path: string,
    body: unknown,
    options: { key?: string; as?: string; prefix?: "/api" | "/v1" } = {},
  ) =>
    app.request(`${options.prefix ?? "/api"}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokens[options.as ?? owner]}`,
        ...(options.key === undefined ? {} : { "idempotency-key": options.key }),
      },
      body: JSON.stringify(body),
    });
  const fund = (raw = deposit(), options: Parameters<typeof call>[2] = {}) =>
    call(`/vaults/${vault.id}/fund/submit`, { rawTxHex: raw, amount: "50000", costAccepted: true }, options);
  const keys = async () =>
    [...store.rows.values()].filter((row) => row.sk.startsWith("IDEMPOTENCY#"));
  /** Seed a confirmed vault and a job awaiting authorization, for /jobs/:id/submit. */
  const exact = async () => {
    const confirmed = { ...vaultFor(owner, "confirmed"), scriptHex: "51", funding: { txid: "11".repeat(32), vout: 0, value: "100000" } };
    const { job, raw } = withdrawal(confirmed);
    await store.put({ pk: `OWNER#${owner}`, sk: `VAULT#${confirmed.id}`, version: 0, vault: confirmed });
    await store.put({ pk: `OWNER#${owner}`, sk: `JOB#${job.id}`, version: 0, job });
    return { job, raw, post: (options: Parameters<typeof call>[2] = {}) => call(`/jobs/${job.id}/submit`, { rawTxHex: raw }, options) };
  };
  return { store, vault, app, call, fund, keys, exact, submitFunding, submit, seen, credential, consensus };
}

const json = async (response: Response) => ({ status: response.status, body: await response.json() });

describe("Idempotency-Key", () => {
  it("changes nothing for a request without the header", async () => {
    const f = await fixture();
    const vault = vaultFor(owner);
    expect((await f.call("/vaults", vault)).status).toBe(201);
    expect(await json(await f.call("/vaults", vault))).toEqual({ status: 409, body: { error: "State changed. Refresh and try again." } });
    // A header-less retry of a deposit resends the same bytes, as it did before.
    expect((await json(await f.fund())).body).toMatchObject({ submission: "submitted" });
    expect((await json(await f.fund())).body).toMatchObject({ submission: "submitted" });
    expect(f.submitFunding).toHaveBeenCalledTimes(2);
    expect(await f.keys()).toEqual([]);
  });

  it("replays a settled deposit submission, under /api and /v1, with one miner POST", async () => {
    const f = await fixture();
    const first = await f.fund(deposit(), { key });
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotency-replayed")).toBeNull();
    const body = await first.text();
    expect(JSON.parse(body)).toMatchObject({ submission: "submitted" });
    for (const prefix of ["/api", "/v1"] as const) {
      const again = await f.fund(deposit(), { key, prefix });
      expect(again.status).toBe(201);
      expect(again.headers.get("idempotency-replayed")).toBe("true");
      expect(again.headers.get("content-type")).toMatch(/^application\/json/);
      expect(await again.text()).toBe(body);
    }
    expect(f.submitFunding).toHaveBeenCalledOnce();
    expect(f.seen).not.toHaveBeenCalled();
    const [row] = await f.keys();
    expect(row).toMatchObject({ pk: `OWNER#${owner}`, sk: `IDEMPOTENCY#/vaults/:id/fund/submit#${key}`, response: { status: 201, body } });
    expect(row.expiresAt).toBeGreaterThan(Date.now() / 1000 + 86400 - 60);
    // An operational row with no credential-like fields.
    expect(inventoryRows([row]).counts).toMatchObject({ operational: 1, unclassified: 0 });
  });

  it("replays a settled withdrawal submission without a second consensus check or POST", async () => {
    const f = await fixture();
    const w = await f.exact();
    const first = await json(await w.post({ key, prefix: "/v1" }));
    expect(first).toEqual({ status: 200, body: { txid: transactionId(w.raw), status: "submitted" } });
    const again = await w.post({ key });
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(await json(again)).toEqual(first);
    expect(f.consensus.verify).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce();
  });

  it("refuses the same key for a different body or path", async () => {
    const f = await fixture();
    expect((await f.fund(deposit(1), { key })).status).toBe(201);
    const conflict = await json(await f.fund(deposit(2), { key }));
    expect(conflict).toEqual({ status: 409, body: { error: "This Idempotency-Key was already used for a different request.", code: "idempotency_conflict" } });
    const elsewhere = await f.call(`/vaults/${randomUUID()}/fund/submit`, { rawTxHex: deposit(1), amount: "50000", costAccepted: true }, { key });
    expect((await json(elsewhere)).body.code).toBe("idempotency_conflict");
    expect(f.submitFunding).toHaveBeenCalledOnce();
  });

  it("refuses a retry while the first request is in flight", async () => {
    const f = await fixture();
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>((resolve) => (started = resolve));
    f.submitFunding.mockImplementationOnce(async (raw: string) => {
      started();
      await new Promise<void>((resolve) => (release = resolve));
      return { status: "success" as const, message: transactionId(raw) };
    });
    const first = f.fund(deposit(), { key });
    await ready;
    const busy = await f.fund(deposit(), { key, prefix: "/v1" });
    expect(await json(busy)).toEqual({ status: 409, body: { error: "A request with this Idempotency-Key is still in progress.", code: "idempotency_in_progress" } });
    expect(Number(busy.headers.get("retry-after"))).toBeGreaterThan(0);
    release();
    expect((await first).status).toBe(201);
    expect((await f.fund(deposit(), { key })).headers.get("idempotency-replayed")).toBe("true");
    expect(f.submitFunding).toHaveBeenCalledOnce();
  });

  it("does not store a 5xx: the retry runs the handler", async () => {
    const f = await fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.credential.mockRejectedValueOnce(new Error("storage unavailable"));
    expect((await f.fund(deposit(), { key })).status).toBe(500);
    expect(f.submitFunding).not.toHaveBeenCalled();
    const [row] = await f.keys();
    expect(row.response).toBeUndefined();
    expect(row.leaseUntil).toBe(0);
    const retry = await f.fund(deposit(), { key });
    expect(retry.status).toBe(201);
    expect(retry.headers.get("idempotency-replayed")).toBeNull();
    expect(f.submitFunding).toHaveBeenCalledOnce();
  });

  it("does not store an uncertain outcome: the retry follows the handler's own rules", async () => {
    const f = await fixture();
    f.submitFunding.mockRejectedValueOnce(new Error("socket hang up"));
    expect((await json(await f.fund(deposit(), { key }))).body).toMatchObject({ submission: "uncertain" });
    // As without the header: the handler asks MARA first; it already has the deposit, so no POST.
    f.seen.mockResolvedValueOnce(true);
    expect((await json(await f.fund(deposit(), { key }))).body).toMatchObject({ submission: "submitted" });
    expect(f.submitFunding).toHaveBeenCalledOnce();
    expect((await f.fund(deposit(), { key })).headers.get("idempotency-replayed")).toBe("true");
    expect(f.submitFunding).toHaveBeenCalledOnce();
    expect(f.seen).toHaveBeenCalledOnce();
  });

  it("an unfinished request's lease lapses to the handler, which never resubmits a withdrawal", async () => {
    const f = await fixture();
    const w = await f.exact();
    // The outcome is never recorded, as if the Lambda stopped right after the handler.
    const put = f.store.put.bind(f.store);
    vi.spyOn(f.store, "put").mockImplementation(async (row, expected) => {
      if (row.sk.startsWith("IDEMPOTENCY#") && row.response) throw new Error("storage unavailable");
      return put(row, expected);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await json(await w.post({ key }))).body).toMatchObject({ status: "submitted" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"idempotency":"unrecorded"'));
    expect((await json(await w.post({ key }))).body.code).toBe("idempotency_in_progress");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + (leaseSeconds + 1) * 1000);
    const lapsed = await w.post({ key });
    expect(lapsed.status).toBe(200);
    expect(lapsed.headers.get("idempotency-replayed")).toBeNull();
    expect(await lapsed.json()).toEqual({ txid: transactionId(w.raw), status: "submitted" });
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.consensus.verify).toHaveBeenCalledOnce();
  });

  it("keeps each owner's keys apart", async () => {
    const f = await fixture();
    const mine = vaultFor(owner),
      theirs = vaultFor(other);
    expect(await json(await f.call("/vaults", mine, { key }))).toMatchObject({ status: 201, body: { vault: { id: mine.id } } });
    const response = await f.call("/vaults", theirs, { key, as: other });
    expect(response.headers.get("idempotency-replayed")).toBeNull();
    expect(await json(response)).toMatchObject({ status: 201, body: { vault: { id: theirs.id, paymentAddress: other } } });
    expect(await f.store.get(`OWNER#${other}`, `VAULT#${theirs.id}`)).toBeDefined();
    expect((await f.keys()).map((row) => row.pk).sort()).toEqual([`OWNER#${owner}`, `OWNER#${other}`].sort());
  });

  it("refuses a malformed key before the handler runs", async () => {
    const f = await fixture();
    for (const bad of ["", "short", "x".repeat(129), "has space-12345", "dots.1234567", "slash/1234567"]) {
      const vault = vaultFor(owner);
      expect(await json(await f.call("/vaults", vault, { key: bad }))).toEqual({ status: 400, body: { error: "Invalid request", code: "invalid_request", issues: [{ path: ["Idempotency-Key"], message: "Use 8 to 128 letters, digits, '-' or '_'." }] } });
      expect(await f.store.get(`OWNER#${owner}`, `VAULT#${vault.id}`)).toBeUndefined();
    }
    expect(await f.keys()).toEqual([]);
  });

  it("runs a 4xx again and keeps the key bound to its request", async () => {
    const f = await fixture();
    const invalid = { ...vaultFor(owner), paymentAddress: other };
    for (let i = 0; i < 2; i++) {
      const response = await f.call("/vaults", invalid, { key });
      expect(response.status).toBe(400);
      expect(response.headers.get("idempotency-replayed")).toBeNull();
    }
    expect((await json(await f.call("/vaults", vaultFor(owner), { key }))).body.code).toBe("idempotency_conflict");
  });

  it("forgets a key after 24 hours", async () => {
    const f = await fixture();
    expect((await f.call("/vaults", vaultFor(owner), { key })).status).toBe(201);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + (86400 + 1) * 1000);
    const later = vaultFor(owner);
    expect(await json(await f.call("/vaults", later, { key }))).toMatchObject({ status: 201, body: { vault: { id: later.id } } });
  });

  it("replays pause and resume", async () => {
    const f = await fixture();
    const job = { ...withdrawal({ ...f.vault, funding: { txid: "11".repeat(32), vout: 0, value: "100000" } }).job, status: "queued" as const };
    await f.store.put({ pk: `OWNER#${owner}`, sk: `JOB#${job.id}`, version: 0, job });
    for (const [action, status] of [["pause", 200], ["resume", 202]] as const) {
      const first = await json(await f.call(`/jobs/${job.id}/${action}`, {}, { key: `${action}-${key}` }));
      expect(first.status).toBe(status);
      const again = await f.call(`/jobs/${job.id}/${action}`, {}, { key: `${action}-${key}` });
      expect(again.headers.get("idempotency-replayed")).toBe("true");
      expect(await json(again)).toEqual(first);
    }
    // Without the header, a second resume is refused as before.
    expect((await f.call(`/jobs/${job.id}/resume`, {})).status).toBe(409);
  });

  it("holds a lease longer than the API Lambda can run", () => {
    const compute = readFileSync(new URL("../terraform/compute.tf", import.meta.url), "utf8");
    const timeout = Number(/resource "aws_lambda_function" "api" \{[\s\S]*?\btimeout\s*=\s*(\d+)/.exec(compute)?.[1]);
    expect(timeout).toBeGreaterThan(0);
    expect(leaseSeconds).toBeGreaterThan(timeout);
  });
});
