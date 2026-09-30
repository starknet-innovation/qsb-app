import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { Esplora } from "../server/chain";
import { EVENT_SETTLE_MS, listOwnerEvents } from "../server/owner-events";
import { BITCOIN_NETWORK, NETWORK_CONFIG } from "../src/lib/network";
import { outputScript } from "../src/lib/transactions";
import { withVaultConfiguration } from "../src/lib/provenance";
import { STRAY_OUTPUTS_LISTED, type PublicVault, type Withdrawal } from "../src/lib/model";

// Unsigned transactions and a fake chain API only: no keys, no network.
const opts = { allowUnknownOutputs: true, allowUnknownInputs: true };
const owner = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
const token = "A".repeat(43);
const scriptHex = "51".repeat(100);
const scriptHash = createHash("sha256").update(Buffer.from(scriptHex, "hex")).digest("hex");

afterEach(() => vi.restoreAllMocks());

function depositTx() {
  const tx = new btc.Transaction({ ...opts, version: 2 });
  tx.addInput({ txid: new Uint8Array(32).fill(1), index: 0 });
  tx.addOutput({ amount: 100_000n, script: hex.decode(scriptHex) });
  tx.addOutputAddress(owner, 1_449n, BITCOIN_NETWORK);
  return tx;
}

type Utxo = { txid: string; vout: number; value: number; status: { confirmed: boolean } };

async function fixture(utxos: (deposit: string) => Utxo[] | Response) {
  const store = new MemoryStore();
  await store.put({
    pk: `SESSION#${createHash("sha256").update(token).digest("hex")}`,
    sk: "AUTH",
    version: 0,
    owner,
    network: "mainnet",
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  });
  const deposit = depositTx();
  const vault = withVaultConfiguration({
    id: randomUUID(),
    name: "cold-1",
    createdAt: new Date().toISOString(),
    network: "mainnet",
    config: "A",
    scriptHex,
    scriptHash,
    paymentAddress: owner,
    publicStateJson: JSON.stringify({ config: "A", full_script_hex: scriptHex }),
    status: "confirmed",
    funding: { txid: deposit.id, vout: 0, value: "100000" },
  });
  await store.put({ pk: `OWNER#${owner}`, sk: `VAULT#${vault.id}`, version: 0, vault });
  const blockHash = "00".repeat(31) + "0a";
  const paths: string[] = [];
  const chain = new Esplora("https://chain.test", async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    const reply = (body: unknown) =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
    if (path === "/block-height/0") return reply(NETWORK_CONFIG.genesisHash);
    if (path === `/tx/${deposit.id}/status`)
      return reply({ confirmed: true, block_height: 100, block_hash: blockHash });
    if (path === "/block-height/100") return reply(blockHash);
    if (path === "/blocks/tip/height") return reply("105");
    if (path === `/tx/${deposit.id}/hex`) return reply(hex.encode(deposit.toBytes(true, true)));
    if (path === `/scripthash/${scriptHash}/utxo`) {
      const answer = utxos(deposit.id);
      return answer instanceof Response ? answer : reply(answer);
    }
    return new Response("", { status: 404 });
  });
  const app = createApp(store, { chain, enabled: true, versionedAlias: true });
  const get = (path: string) =>
    app.request(`/v1${path}`, { headers: { authorization: `Bearer ${token}` } });
  const post = (path: string, body: unknown) =>
    app.request(`/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const row = () => store.get(`OWNER#${owner}`, `VAULT#${vault.id}`);
  const events = async () =>
    (await listOwnerEvents(store, owner, { limit: 100 }, Date.now() + EVENT_SETTLE_MS + 1000)).events;
  return { store, vault, deposit, chain, get, post, row, events, paths };
}

const stray = { txid: "cd".repeat(32), vout: 3, value: 25_000, status: { confirmed: true } };
const pending = { txid: "ef".repeat(32), vout: 0, value: 7_000, status: { confirmed: false } };

describe("stray payments to a vault's script", () => {
  it("reads the script's outputs by the vault's script hash", async () => {
    const f = await fixture((deposit) => [
      { txid: deposit.toUpperCase(), vout: 0, value: 100_000, status: { confirmed: true } },
    ]);
    expect(await f.chain.scriptOutputs(scriptHash)).toEqual([
      { txid: f.deposit.id, vout: 0, value: "100000", confirmed: true },
    ]);
    expect(f.paths).toContain(`/scripthash/${scriptHash}/utxo`);
    await expect(f.chain.scriptOutputs("not-a-hash")).rejects.toThrow();
  });

  it("flags a confirmed output beyond the recorded funding, once, to the owner and the operator", async () => {
    const f = await fixture((deposit) => [
      { txid: deposit, vout: 0, value: 100_000, status: { confirmed: true } },
      stray,
      pending,
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await f.get(`/vaults/${f.vault.id}/funding`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const flagged = {
      vaultId: f.vault.id,
      count: 1,
      sats: "25000",
      outputs: [{ txid: stray.txid, vout: 3, value: "25000", firstSeenAt: expect.any(String) }],
    };
    // The unconfirmed payment isn't flagged until it confirms; the recorded funding never is.
    expect(body.strayPayments).toEqual(flagged);
    expect((await f.row())?.strayPayments).toEqual(flagged);
    expect((await f.row())?.vault).toEqual(f.vault);
    expect(await f.events()).toMatchObject([
      { type: "deposit.stray_payment", subjectId: f.vault.id, status: "stray_payment" },
    ]);
    const lines = warn.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual([
      JSON.stringify({
        strayPayment: { vaultId: f.vault.id, count: 1, newCount: 1, sats: "25000", outputs: [`${stray.txid}:3`] },
      }),
    ]);
    expect(lines.join("\n")).not.toContain(owner);

    // Checking again finds nothing new: no second write, event or log line.
    const version = (await f.row())!.version;
    const again = await (await f.get(`/vaults/${f.vault.id}/funding`)).json();
    expect(again.strayPayments).toEqual(flagged);
    expect((await f.row())!.version).toBe(version);
    expect(await f.events()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);

    const list = await (await f.get("/vaults")).json();
    expect(list.strayPayments).toEqual([flagged]);
  });

  it("keeps the record a fixed size however many outputs arrive, and flags each increase", async () => {
    const dust = (n: number) => ({ txid: n.toString(16).padStart(64, "0"), vout: 0, value: 546, status: { confirmed: true } });
    let paid = Array.from({ length: 25 }, (_, i) => dust(i + 1));
    const f = await fixture((deposit) => [
      { txid: deposit, vout: 0, value: 100_000, status: { confirmed: true } },
      ...paid,
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = (await (await f.get(`/vaults/${f.vault.id}/funding`)).json()).strayPayments;
    expect(first).toMatchObject({ count: 25, sats: String(25 * 546) });
    expect(first.outputs).toHaveLength(STRAY_OUTPUTS_LISTED);

    paid = Array.from({ length: 5000 }, (_, i) => dust(i + 1));
    const second = (await (await f.get(`/vaults/${f.vault.id}/funding`)).json()).strayPayments;
    expect(second).toMatchObject({ count: 5000, sats: String(5000 * 546) });
    // The listed outputs are the first ones seen; the record doesn't grow.
    expect(second.outputs).toEqual(first.outputs);
    // Only the count and the total change: 20 listed outputs stay within a few KB.
    expect(JSON.stringify((await f.row())!.strayPayments).length).toBeLessThan(4096);
    expect(await f.events()).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(warn.mock.calls[1][0]))).toEqual({
      strayPayment: { vaultId: f.vault.id, count: 5000, newCount: 4975, sats: String(5000 * 546), outputs: [] },
    });
  });

  it("never lets a withdrawal spend a flagged output", async () => {
    const f = await fixture((deposit) => [
      { txid: deposit, vout: 0, value: 100_000, status: { confirmed: true } },
      stray,
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await f.get(`/vaults/${f.vault.id}/funding`);
    expect((await f.row())?.strayPayments).toMatchObject({ count: 1 });
    const before = [...f.store.rows.keys()];
    const manifest: Withdrawal = {
      vaultId: f.vault.id,
      funding: { txid: stray.txid, vout: stray.vout, value: String(stray.value) },
      helper: { txid: f.deposit.id, vout: 1, value: "1449" },
      destination: owner,
      outputScript: hex.encode(outputScript(owner)),
      outputValue: "16449",
      fee: "10000",
      idempotencyKey: randomUUID(),
      costAccepted: true,
    };
    const response = await f.post("/jobs", manifest);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "withdrawal_invalid" });
    // No job, reservation or other row was written.
    expect([...f.store.rows.keys()]).toEqual(before);
  });

  it("keeps the funding response when the lookup fails, and records nothing", async () => {
    const f = await fixture(() => new Response("", { status: 503 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await f.get(`/vaults/${f.vault.id}/funding`);
    expect(response.status).toBe(200);
    expect((await response.json()).strayPayments).toBeNull();
    expect((await f.row())?.strayPayments).toBeUndefined();
    expect(await f.events()).toEqual([]);
    expect(error.mock.calls.map(([line]) => String(line))).toContain(
      JSON.stringify({ strayPayments: "lookup_failed", error: "Error" }),
    );
  });

  it("doesn't look for stray outputs before a vault is funded", async () => {
    const f = await fixture(() => [stray]);
    const unfunded: PublicVault = { ...f.vault, status: "unfunded", funding: undefined };
    const row = (await f.row())!;
    await f.store.put({ ...row, vault: unfunded, version: row.version + 1 }, row.version);
    const response = await f.get(`/vaults/${f.vault.id}/funding`);
    expect(response.status).toBe(409);
    expect(f.paths).not.toContain(`/scripthash/${scriptHash}/utxo`);
  });
});
