import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import awsRelease from "../src/lib/releases/qsb-solver-aws-v0-1-0.json";
import { transactionVsize } from "../src/lib/transactions";
import { QsbClient, publicApi, type WithdrawalReview } from "../sdk/index";
import { API, createdVault, fundedVault, solvedWithdrawal as solved } from "./sdk-fixture";
vi.mock("../sdk/public-runtime", async importOriginal => {
  const actual = await importOriginal<typeof import("../sdk/public-runtime")>();
  const { publicPlannerDouble } = await import("./sdk-planner-double");
  return { publicRuntime: () => publicPlannerDouble(actual.publicRuntime()) };
});
beforeEach(() => vi.stubEnv("SOLVER_RELEASE_ID", awsRelease.id));
afterEach(() => vi.unstubAllEnvs());
const passphrase = "unused compatibility argument";
const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };
const newAddress = () => btc.p2wpkh(secp256k1.getPublicKey(randomBytes(32), true)).address!;
describe("withdrawals.submit approval", () => {
  it("shows the exact values bound to the txid and sends nothing without that approval", async () => {
    const s = await solved(passphrase);
    const signed = await s.client.withdrawals.assemble(s.job.id);
    const submits = () => s.w.requests.filter((r) => r.url.endsWith(`/jobs/${s.job.id}/submit`)).length;
    await expect(s.client.withdrawals.submit(signed, {} as never)).rejects.toThrow("approve callback");
    for (const answer of [undefined, false, true, "ab".repeat(32), signed.txid.toUpperCase()])
      await expect(s.client.withdrawals.submit(signed, { approve: () => answer as string })).rejects.toThrow("not approved");
    expect(submits()).toBe(0);

    // What the callback sees is derived from the signed bytes and the stored job, not from the file.
    const tx = btc.Transaction.fromRaw(hex.decode(signed.rawTxHex), opts);
    const output = tx.getOutput(0);
    const fee = BigInt(s.job.manifest.funding.value) + BigInt(s.job.manifest.helper!.value) - output.amount!;
    const vsize = transactionVsize(signed.rawTxHex);
    const seen: WithdrawalReview[] = [];
    const result = await s.client.withdrawals.submit(signed, {
      approve: async (review) => {
        seen.push(review);
        expect(submits()).toBe(0);
        return review.txid;
      },
    });
    expect(seen).toEqual([
      {
        network: "mainnet",
        jobId: s.job.id,
        vaultId: s.vault.id,
        txid: tx.id,
        destination: btc.Address(btc.NETWORK).encode(btc.OutScript.decode(output.script!)),
        outputValue: output.amount!.toString(),
        fee: fee.toString(),
        vsize,
        feeRate: Number((fee * 1000n) / BigInt(vsize)) / 1000,
        minerMinimumFeeRate: 2,
      },
    ]);
    expect(seen[0].destination).toBe(s.destination);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(result).toEqual({ txid: tx.id, status: "submitted" });
    expect(submits()).toBe(1);
    // A second submit stops before asking: the withdrawal already has its transaction.
    const approve = vi.fn(() => signed.txid);
    await expect(s.client.withdrawals.submit(signed, { approve })).rejects.toThrow("already submitted");
    expect(approve).not.toHaveBeenCalled();
    expect(submits()).toBe(1);
  }, 120000);

  it("refuses a signed result whose transaction was edited, before asking for approval", async () => {
    const s = await solved(passphrase);
    const signed = await s.client.withdrawals.assemble(s.job.id);
    const payout = hex.encode(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(s.destination)));
    const redirected = hex.encode(btc.OutScript.encode(btc.Address(btc.NETWORK).decode(newAddress())));
    expect(signed.rawTxHex.split(payout)).toHaveLength(2);
    const approve = vi.fn(() => signed.txid);
    await expect(
      s.client.withdrawals.submit({ ...signed, rawTxHex: signed.rawTxHex.replace(payout, redirected) }, { approve }),
    ).rejects.toThrow("differs from the approved intent");
    expect(approve).not.toHaveBeenCalled();
  }, 120000);
});


describe("external custody boundary", () => {
  it("requires external providers and rejects secret-bearing descriptors before a request", async () => {
    expect(() => new QsbClient({ baseUrl: API, signer: {} } as never)).toThrow();
    const s = await createdVault();
    const before = s.w.requests.length;
    await expect(s.client.vaults.create({ name: "secret", descriptor: { ...await s.generate("PQB"), seed: "ab".repeat(32) } as never })).rejects.toThrow();
    expect(s.w.requests).toHaveLength(before);
  }, 60000);

  it("requires external recovery confirmation before registering or funding a vault", async () => {
    const s = await createdVault();
    const confirm = vi.spyOn(s.providers.custody, "confirmVault").mockRejectedValue(new Error("Recovery storage is unavailable"));
    const before = s.w.requests.filter(r => r.method === "POST" && r.url.endsWith("/vaults")).length;
    await expect(s.client.vaults.create({ name: "not ready", descriptor: await s.generate("PQB") })).rejects.toThrow("Recovery storage");
    expect(s.w.requests.filter(r => r.method === "POST" && r.url.endsWith("/vaults"))).toHaveLength(before);
    await expect(s.client.deposits.prepare(s.vault.id, { amount: 200000n, feeRate: "2", utxos: [{ txid: s.owner.fundingTxid, vout: 0 }] })).rejects.toThrow("Recovery storage");
    expect(confirm).toHaveBeenCalled();
  }, 60000);

  it("retains an exact intent across an unanswered request and a new client", async () => {
    const s = await fundedVault(passphrase);
    const offline = new QsbClient({ baseUrl: API, ...s.providers, fetch: (async (url, init) => {
      if (String(url).endsWith("/jobs") && init?.method === "POST") throw new Error("Lost answer");
      return s.w.fetch(url, init);
    }) as typeof fetch });
    await expect(offline.withdrawals.create({ vaultId: s.vault.id, helper: { txid: s.owner.fundingTxid, vout: 1 },
      destination: s.destination, feeRate: "3", costAccepted: true })).rejects.toThrow("unconfirmed");
    const key = `qsb-intent:mainnet:${s.vault.scriptHash}`;
    const saved = s.rows.get(key)!;
    const resumed = new QsbClient({ baseUrl: API, ...s.providers, fetch: s.w.fetch });
    await expect(resumed.withdrawals.create({ vaultId: s.vault.id, destination: newAddress(), costAccepted: true })).rejects.toThrow("already authorizes");
    const { job } = await resumed.withdrawals.create({ vaultId: s.vault.id, costAccepted: true });
    expect(job.manifest).toEqual(JSON.parse(saved));
    expect(s.rows.get(key)).toBe(saved);
  }, 60000);

  it("atomically rejects concurrent conflicting intent claims", async () => {
    const s = await fundedVault(passphrase);
    const another = new QsbClient({ baseUrl: API, ...s.providers, fetch: s.w.fetch });
    const args = { vaultId: s.vault.id, helper: { txid: s.owner.fundingTxid, vout: 1 }, feeRate: "3", costAccepted: true as const };
    const outcomes = await Promise.allSettled([
      s.client.withdrawals.create({ ...args, destination: s.destination }),
      another.withdrawals.create({ ...args, destination: newAddress() }),
    ]);
    expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(s.w.requests.filter(r => r.method === "POST" && r.url.endsWith("/jobs"))).toHaveLength(1);
  }, 60000);

  it("blocks a second assembly before asking the external signer", async () => {
    const s = await solved(passphrase);
    const authorize = vi.spyOn(s.providers.custody, "authorizeWithdrawal");
    await s.client.withdrawals.assemble(s.job.id);
    const calls = authorize.mock.calls.length;
    const row = (await s.w.store.get(`OWNER#${s.owner.address}`, `JOB#${s.job.id}`))!;
    const changed = structuredClone(row);
    (changed.job as { solution: { sequence: number } }).solution.sequence++;
    await s.w.store.put({ ...changed, version: row.version + 1 }, row.version);
    await expect(s.client.withdrawals.assemble(s.job.id)).rejects.toThrow("Conflicting one-time");
    expect(authorize).toHaveBeenCalledTimes(calls);
  }, 60000);

  it("refuses redirected external authorizations before helper signing", async () => {
    const s = await solved(passphrase);
    const authorize = s.providers.custody.authorizeWithdrawal;
    s.providers.custody.authorizeWithdrawal = async request => {
      const raw = await authorize(request);
      const tx = btc.Transaction.fromRaw(hex.decode(raw), opts);
      tx.updateOutput(0, { script: hex.decode("0014" + "44".repeat(20)) }, true);
      return hex.encode(tx.toBytes(true, true));
    };
    const sign = vi.spyOn(s.signer, "signPsbt");
    await expect(s.client.withdrawals.assemble(s.job.id)).rejects.toThrow("differs from the approved intent");
    expect(sign).not.toHaveBeenCalled();
  }, 60000);

  it("rotates external credentials and follows no redirects", async () => {
    let credential = "A".repeat(43);
    const seen: RequestInit[] = [];
    const s = await createdVault();
    const client = new QsbClient({ baseUrl: API, ...s.providers, credentials: { get: async () => credential },
      fetch: (async (_url, init) => { seen.push(init!); return new Response(JSON.stringify({ vaults: [] })); }) as typeof fetch });
    await client.vaults.list(); credential = "B".repeat(43); await client.vaults.list();
    expect(seen.map(v => new Headers(v.headers).get("X-Qsb-Authorization"))).toEqual([`Bearer ${"A".repeat(43)}`, `Bearer ${"B".repeat(43)}`]);
    expect(seen.every(v => v.redirect === "error")).toBe(true);
    expect(seen.every(v => v.body === undefined)).toBe(true);
    await expect(publicApi({ baseUrl: API, fetch: (async () => new Response('{"error":"gone","code":"vault_not_found"}', { status: 404 })) as typeof fetch }).config())
      .rejects.toMatchObject({ name: "ApiRequestError", code: "vault_not_found", status: 404 });
  }, 60000);
});

it("normalizes external authorization hex before its durable byte binding", async () => {
  const s = await solved(passphrase);
  const authorize = s.providers.custody.authorizeWithdrawal;
  s.providers.custody.authorizeWithdrawal = async request => (await authorize(request)).toUpperCase();
  const signed = await s.client.withdrawals.assemble(s.job.id);
  await expect(s.client.withdrawals.submit(signed, { approve: review => review.txid })).resolves.toMatchObject({ status: "submitted" });
}, 60000);
