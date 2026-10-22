import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { createApp } from "../server/app";
import { Conflict, MemoryStore, type AtomicWrite } from "../server/store";
import { Esplora } from "../server/chain";
import { BITCOIN_NETWORK, NETWORK_CONFIG } from "../src/lib/network";
import type { PublicVault } from "../src/lib/model";
import { withVaultConfiguration } from "../src/lib/provenance";

// One script, one vault, on the whole deployment. A fake chain API behind the real Esplora
// client and the in-memory store; no keys and no network.
const owners = [1, 2].map((fill) =>
  btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20).fill(fill) }),
);
const tokens = new Map(owners.map((owner, i) => [owner, String.fromCharCode(65 + i).repeat(43)]));

function vaultFor(paymentAddress: string, scriptHex: string): PublicVault {
  return withVaultConfiguration({
    id: randomUUID(),
    name: "cold-1",
    createdAt: new Date().toISOString(),
    network: "mainnet",
    config: "A",
    scriptHex,
    scriptHash: createHash("sha256").update(Buffer.from(scriptHex, "hex")).digest("hex"),
    paymentAddress,
    publicStateJson: JSON.stringify({ config: "A", hash_mode: "sha256", n: 150, round_sigs: [], full_script_hex: scriptHex }),
    status: "unfunded",
  });
}

async function fixture(store = new MemoryStore()) {
  for (const [owner, token] of tokens)
    await store.put({
      pk: `SESSION#${createHash("sha256").update(token).digest("hex")}`,
      sk: "AUTH",
      version: 0,
      owner,
      network: "mainnet",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
  /** What the chain API reports for each script hash: its funded output counts, or another answer. */
  const funded = new Map<string, { chain: number; mempool: number } | (() => Response)>();
  const lookups: string[] = [];
  const network = { genesis: NETWORK_CONFIG.genesisHash };
  const chain = new Esplora("https://chain.test", async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/block-height/0") return new Response(network.genesis);
    const hash = /^\/scripthash\/([0-9a-f]{64})$/.exec(path)?.[1];
    if (!hash) return new Response("", { status: 404 });
    lookups.push(hash);
    const counts = funded.get(hash) ?? { chain: 0, mempool: 0 };
    if (typeof counts === "function") return counts();
    return Response.json({
      chain_stats: { funded_txo_count: counts.chain, spent_txo_count: 0 },
      mempool_stats: { funded_txo_count: counts.mempool, spent_txo_count: 0 },
      scripthash: hash,
    });
  });
  const app = createApp(store, { chain });
  const register = async (vault: PublicVault) => {
    const response = await app.request("/api/vaults", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.get(vault.paymentAddress)}` },
      body: JSON.stringify(vault),
    });
    return { status: response.status, body: await response.json() };
  };
  /** Every vault row and script reservation in the store. */
  const rows = () => {
    const all = [...store.rows.values()];
    return {
      vaults: all.filter((row) => row.sk.startsWith("VAULT#")).map((row) => (row.vault as PublicVault).id),
      reservations: all.filter((row) => row.pk.startsWith("SCRIPT#")),
    };
  };
  return { store, funded, network, lookups, register, rows };
}

const script = () => randomBytes(100).toString("hex");
const registered = {
  status: 409,
  body: { error: "Another vault on this deployment already has this script.", code: "vault_script_registered" },
};

describe("POST /api/vaults registers each script once on the deployment", () => {
  it("reserves the script with the vault row", async () => {
    const f = await fixture();
    const vault = vaultFor(owners[0], script());
    expect(await f.register(vault)).toEqual({ status: 201, body: { vault } });
    expect(f.rows()).toEqual({
      vaults: [vault.id],
      reservations: [{ pk: `SCRIPT#${vault.scriptHash}`, sk: "RESERVATION", version: 0, owner: owners[0], vaultId: vault.id }],
    });
    expect(f.lookups).toEqual([vault.scriptHash]);
  });

  it("refuses the same script from a second address, or a second vault of the first, before any write", async () => {
    const f = await fixture();
    const scriptHex = script();
    const first = vaultFor(owners[0], scriptHex);
    expect((await f.register(first)).status).toBe(201);
    for (const second of [vaultFor(owners[1], scriptHex), vaultFor(owners[0], scriptHex)]) {
      const refusal = await f.register(second);
      expect(refusal).toEqual(registered);
      // The refusal names neither the vault that holds the script nor its address.
      expect(JSON.stringify(refusal)).not.toContain(first.id);
      expect(JSON.stringify(refusal)).not.toContain(owners[0]);
    }
    expect(f.rows().vaults).toEqual([first.id]);
    expect(f.rows().reservations.map((row) => row.vaultId)).toEqual([first.id]);
    // A held reservation refuses before the chain is asked.
    expect(f.lookups).toEqual([first.scriptHash]);
  });

  it("lets exactly one of two concurrent registrations of a script, from two addresses, succeed", async () => {
    const f = await fixture();
    const scriptHex = script();
    const vaults = owners.map((owner) => vaultFor(owner, scriptHex));
    const results = await Promise.all(vaults.map((vault) => f.register(vault)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = vaults[results.findIndex((r) => r.status === 201)];
    expect(results.find((r) => r.status === 409)).toEqual(registered);
    // Both requests passed the reservation and chain checks; the transaction decided.
    expect(f.lookups).toEqual([winner.scriptHash, winner.scriptHash]);
    expect(f.rows().vaults).toEqual([winner.id]);
    expect(f.rows().reservations.map((row) => [row.owner, row.vaultId])).toEqual([[winner.paymentAddress, winner.id]]);
  });

  it("answers a lost race it can't attribute yet with state_conflict, and the retry with vault_script_registered", async () => {
    // DynamoDB's TransactionConflict: the winner's transaction is still in flight, so its
    // reservation isn't readable when the loser looks.
    const store = new MemoryStore();
    const f = await fixture(store);
    const scriptHex = script();
    const winner = vaultFor(owners[0], scriptHex);
    const atomicPut = store.atomicPut.bind(store);
    vi.spyOn(store, "atomicPut").mockImplementationOnce(async (_writes: AtomicWrite[]) => {
      throw new Conflict("Input reserved or concurrent update");
    });
    const loser = vaultFor(owners[1], scriptHex);
    expect(await f.register(loser)).toEqual({
      status: 409,
      body: { error: "State changed. Refresh and try again.", code: "state_conflict" },
    });
    vi.mocked(store.atomicPut).mockImplementation(atomicPut);
    expect((await f.register(winner)).status).toBe(201);
    expect(await f.register(loser)).toEqual(registered);
    expect(f.rows().vaults).toEqual([winner.id]);
  });

  it("keeps a repeat of the same vault a state_conflict, without asking the chain again", async () => {
    const f = await fixture();
    const vault = vaultFor(owners[0], script());
    expect((await f.register(vault)).status).toBe(201);
    expect(await f.register(vault)).toEqual({
      status: 409,
      body: { error: "State changed. Refresh and try again.", code: "state_conflict" },
    });
    expect(f.lookups).toEqual([vault.scriptHash]);
    expect(f.rows().vaults).toEqual([vault.id]);
  });

  it("refuses a script that something already paid, confirmed or in the mempool, spent or not", async () => {
    const f = await fixture();
    for (const counts of [{ chain: 1, mempool: 0 }, { chain: 0, mempool: 1 }]) {
      const vault = vaultFor(owners[0], script());
      f.funded.set(vault.scriptHash, counts);
      expect(await f.register(vault)).toEqual({
        status: 409,
        body: { error: "This script has already been paid on chain, so it can't be a new vault.", code: "vault_script_paid" },
      });
    }
    expect(f.rows()).toEqual({ vaults: [], reservations: [] });
  });

  it("writes nothing when the chain lookup fails, answers badly or is for another network", async () => {
    const f = await fixture();
    const vault = vaultFor(owners[0], script());
    for (const [answer, status] of [
      [() => new Response("", { status: 502 }), 503],
      [() => new Response("not json"), 502],
      [() => Response.json({ chain_stats: {}, mempool_stats: {} }), 502],
    ] as const) {
      f.funded.set(vault.scriptHash, answer);
      expect(await f.register(vault)).toMatchObject({ status, body: { code: status === 503 ? "chain_unavailable" : "chain_error" } });
    }
    f.funded.delete(vault.scriptHash);
    f.network.genesis = "00".repeat(32);
    expect(await f.register(vault)).toMatchObject({ status: 409, body: { code: "chain_error" } });
    expect(f.rows()).toEqual({ vaults: [], reservations: [] });
    f.network.genesis = NETWORK_CONFIG.genesisHash;
    expect((await f.register(vault)).status).toBe(201);
  });
});
