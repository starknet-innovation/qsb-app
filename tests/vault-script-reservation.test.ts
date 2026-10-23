import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { createApp } from "../server/app";
import { Conflict, DynamoStore, MemoryStore, scriptReservation, type AtomicWrite, type Row } from "../server/store";
import { Esplora } from "../server/chain";
import type { Slipstream } from "../server/providers";
import { backfillScriptReservations } from "../server/script-reservations";
import { BITCOIN_NETWORK, NETWORK_CONFIG } from "../src/lib/network";
import type { PublicVault } from "../src/lib/model";
import { withVaultConfiguration } from "../src/lib/provenance";
import { ApiRequestError } from "../src/lib/session";
import { depositRefusal, registrationError } from "../src/lib/vault-registration";

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

async function fixture(store = new MemoryStore(), options: { scriptLookupMs?: number; miner?: Slipstream } = {}) {
  /** Deposits are on; unless a test brings its own, the miner is never reached, so any call fails. */
  const minerCalls: string[] = [];
  const miner = options.miner ?? (new Proxy({}, {
    get: (_, name) => () => {
      minerCalls.push(String(name));
      throw new Error("The miner was called.");
    },
  }) as Slipstream);
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
  const funded = new Map<string, { chain: number; mempool: number; spent?: number } | (() => Response)>();
  const lookups: string[] = [];
  const network = { genesis: NETWORK_CONFIG.genesisHash };
  /** How long each chain answer takes; a request whose signal ends first fails as fetch's does. */
  const latency = { ms: 0 };
  /** Each chain request's signal, by path. */
  const signals = new Map<string, AbortSignal>();
  const chain = new Esplora("https://chain.test", async (input, init) => {
    const path = new URL(String(input)).pathname;
    const signal = init?.signal ?? undefined;
    if (signal) signals.set(path, signal);
    signal?.throwIfAborted();
    if (latency.ms)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, latency.ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });
    if (path === "/block-height/0") return new Response(network.genesis);
    const hash = /^\/scripthash\/([0-9a-f]{64})$/.exec(path)?.[1];
    if (!hash) return new Response("", { status: 404 });
    lookups.push(hash);
    const counts = funded.get(hash) ?? { chain: 0, mempool: 0 };
    if (typeof counts === "function") return counts();
    return Response.json({
      chain_stats: { funded_txo_count: counts.chain, spent_txo_count: counts.spent ?? 0 },
      mempool_stats: { funded_txo_count: counts.mempool, spent_txo_count: 0 },
      scripthash: hash,
    });
  });
  const app = createApp(store, { chain, scriptLookupMs: options.scriptLookupMs, enabled: true, exactSubmit: true, miner });
  const call = async (method: "GET" | "POST", path: string, owner: string, body?: unknown) => {
    const response = await app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.get(owner)}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const register = (vault: PublicVault) => call("POST", "/vaults", vault.paymentAddress, vault);
  /** Every vault row and script reservation in the store. */
  const rows = () => {
    const all = [...store.rows.values()];
    return {
      vaults: all.filter((row) => row.sk.startsWith("VAULT#")).map((row) => (row.vault as PublicVault).id),
      reservations: all.filter((row) => row.pk.startsWith("SCRIPT#")),
    };
  };
  return { store, funded, network, latency, signals, lookups, minerCalls, call, register, rows };
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
    const store = new MemoryStore();
    const f = await fixture(store);
    const scriptHex = script();
    const first = vaultFor(owners[0], scriptHex);
    expect((await f.register(first)).status).toBe(201);
    const writes = vi.spyOn(store, "atomicPut");
    for (const second of [vaultFor(owners[1], scriptHex), vaultFor(owners[0], scriptHex)]) {
      const refusal = await f.register(second);
      expect(refusal).toEqual(registered);
      // The refusal names neither the vault that holds the script nor its address.
      expect(JSON.stringify(refusal)).not.toContain(first.id);
      expect(JSON.stringify(refusal)).not.toContain(owners[0]);
    }
    // Refused on the reservation read: no transaction was even tried.
    expect(writes).not.toHaveBeenCalled();
    expect(f.rows().vaults).toEqual([first.id]);
    expect(f.rows().reservations.map((row) => row.vaultId)).toEqual([first.id]);
    // The chain is asked first each time.
    expect(f.lookups).toEqual([first.scriptHash, first.scriptHash, first.scriptHash]);
  });

  it("answers a reserved script that is paid like any paid script, so the refusal doesn't say a vault here has it", async () => {
    const f = await fixture();
    const scriptHex = script();
    const first = vaultFor(owners[0], scriptHex);
    expect((await f.register(first)).status).toBe(201);
    f.funded.set(first.scriptHash, { chain: 1, mempool: 0 });
    expect(await f.register(vaultFor(owners[1], scriptHex))).toMatchObject({ status: 409, body: { code: "vault_script_paid" } });
    expect(f.rows().vaults).toEqual([first.id]);
  });

  it("lets exactly one of two concurrent registrations of a script, from two addresses, succeed", async () => {
    const store = new MemoryStore();
    const f = await fixture(store);
    const writes = vi.spyOn(store, "atomicPut");
    const scriptHex = script();
    const vaults = owners.map((owner) => vaultFor(owner, scriptHex));
    const results = await Promise.all(vaults.map((vault) => f.register(vault)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = vaults[results.findIndex((r) => r.status === 201)];
    expect(results.find((r) => r.status === 409)).toEqual(registered);
    // Both requests passed the checks before the write; the transaction decided.
    expect(writes.mock.settledResults.map((r) => r.type).sort()).toEqual(["fulfilled", "rejected"]);
    expect(writes.mock.settledResults.find((r) => r.type === "rejected")?.value).toBeInstanceOf(Conflict);
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
    for (const counts of [{ chain: 1, mempool: 0 }, { chain: 0, mempool: 1 }, { chain: 1, mempool: 0, spent: 1 }]) {
      const vault = vaultFor(owners[0], script());
      f.funded.set(vault.scriptHash, counts);
      expect(await f.register(vault)).toEqual({
        status: 409,
        body: { error: "This script has already been paid on chain, so it can't be a new vault.", code: "vault_script_paid" },
      });
    }
    expect(f.rows()).toEqual({ vaults: [], reservations: [] });
  });

  it("gives both chain reads one deadline, and writes nothing once it has passed", async () => {
    // Each read alone is well inside the deadline; the two together aren't.
    const f = await fixture(new MemoryStore(), { scriptLookupMs: 300 });
    f.latency.ms = 200;
    const vault = vaultFor(owners[0], script());
    expect(await f.register(vault)).toMatchObject({ status: 503, body: { code: "chain_unavailable" } });
    expect(f.rows()).toEqual({ vaults: [], reservations: [] });
    // The network check's request got the deadline's signal too, not only the script's.
    expect(f.signals.get("/block-height/0")?.aborted).toBe(true);
    // Slow but inside the deadline: registered.
    f.latency.ms = 20;
    expect((await f.register(vault)).status).toBe(201);
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

describe("the operator's script-reservation backfill", () => {
  afterEach(() => vi.restoreAllMocks());
  /** A vault row written without a reservation, as POST /api/vaults once did. */
  const unreserved = async (store: MemoryStore, vault: PublicVault) =>
    store.put({ pk: `OWNER#${vault.paymentAddress}`, sk: `VAULT#${vault.id}`, version: 0, vault });
  const older = (vault: PublicVault, createdAt: string) => withVaultConfiguration({ ...vault, createdAt });

  it("reports first, then reserves each unreserved vault's script, after which the API refuses it", async () => {
    const store = new MemoryStore();
    const f = await fixture(store);
    const legacy = vaultFor(owners[0], script());
    await unreserved(store, legacy);
    // Without a reservation, a second vault of the script would be registered.
    const dry = await backfillScriptReservations(store, await store.vaultRows(), false);
    expect(dry).toEqual({ applied: false, vaults: 1, reserved: 1, alreadyReserved: 0, duplicates: [], unreadable: [], unsettled: [] });
    expect(f.rows().reservations).toEqual([]);
    const applied = await backfillScriptReservations(store, await store.vaultRows(), true);
    expect(applied).toMatchObject({ applied: true, reserved: 1, duplicates: [] });
    expect(f.rows().reservations).toEqual([scriptReservation(owners[0], legacy)]);
    expect(await f.register(vaultFor(owners[1], legacy.scriptHex))).toEqual(registered);
    // The report names vaults, never their owners.
    expect(JSON.stringify(applied)).not.toContain(owners[0]);
    // Run again, it changes nothing.
    expect(await backfillScriptReservations(store, await store.vaultRows(), true)).toMatchObject({ reserved: 0, alreadyReserved: 1 });
  });

  it("reserves the earlier of two rows sharing a script and reports the other, as a dry run does", async () => {
    const store = new MemoryStore();
    const scriptHex = script();
    // By time, not text: as text, the one without milliseconds would sort later.
    const first = older(vaultFor(owners[1], scriptHex), "2026-10-01T00:00:00Z");
    const second = older(vaultFor(owners[0], scriptHex), "2026-10-01T00:00:00.500Z");
    await unreserved(store, second);
    await unreserved(store, first);
    for (const apply of [false, true])
      expect(await backfillScriptReservations(store, await store.vaultRows(), apply)).toMatchObject({
        reserved: 1,
        duplicates: [{ vault: second.id, heldBy: first.id }],
      });
    expect((await store.get(`SCRIPT#${first.scriptHash}`, "RESERVATION"))?.vaultId).toBe(first.id);
  });

  it("gives a shared script to the row whose deposit got furthest, before earlier ones", async () => {
    const store = new MemoryStore();
    const scriptHex = script();
    const funding = { txid: "cd".repeat(32), vout: 0, value: "50000" };
    const unfunded = older(vaultFor(owners[0], scriptHex), "2026-10-01T00:00:00.000Z");
    const submitted = { ...older(vaultFor(owners[1], scriptHex), "2026-10-02T00:00:00.000Z"), status: "submitted" as const, funding };
    const confirmed = { ...older(vaultFor(owners[0], scriptHex), "2026-10-03T00:00:00.000Z"), status: "confirmed" as const, funding };
    for (const vault of [unfunded, submitted, confirmed]) await unreserved(store, vault);
    expect(await backfillScriptReservations(store, await store.vaultRows(), true)).toMatchObject({
      reserved: 1,
      duplicates: [
        { vault: submitted.id, heldBy: confirmed.id },
        { vault: unfunded.id, heldBy: confirmed.id },
      ],
    });
  });

  it("leaves a script another vault holds, and a row whose hash isn't its script's, as they are", async () => {
    const store = new MemoryStore();
    const legacy = vaultFor(owners[0], script());
    await unreserved(store, legacy);
    // Registered after the deploy, before the backfill ran.
    const newer = vaultFor(owners[1], legacy.scriptHex);
    await store.put(scriptReservation(owners[1], newer));
    const broken = { ...vaultFor(owners[1], script()), scriptHash: "00".repeat(32) };
    await unreserved(store, broken);
    expect(await backfillScriptReservations(store, await store.vaultRows(), true)).toEqual({
      applied: true,
      vaults: 2,
      reserved: 0,
      alreadyReserved: 0,
      duplicates: [{ vault: legacy.id, heldBy: newer.id }],
      unreadable: [broken.id],
      unsettled: [],
    });
    expect((await store.get(`SCRIPT#${legacy.scriptHash}`, "RESERVATION"))?.vaultId).toBe(newer.id);
    expect(await store.get(`SCRIPT#${broken.scriptHash}`, "RESERVATION")).toBeUndefined();
  });

  it("reports a script reserved between its read and its write as a duplicate, and an unsettled write as such", async () => {
    const store = new MemoryStore();
    const legacy = vaultFor(owners[0], script());
    await unreserved(store, legacy);
    const put = store.put.bind(store);
    // A registration of the same script commits between the backfill's read and its write.
    const newer = vaultFor(owners[1], legacy.scriptHex);
    vi.spyOn(store, "put").mockImplementationOnce(async () => {
      await put(scriptReservation(owners[1], newer));
      throw new Conflict("Concurrent update");
    });
    expect(await backfillScriptReservations(store, await store.vaultRows(), true)).toMatchObject({
      reserved: 0,
      duplicates: [{ vault: legacy.id, heldBy: newer.id }],
      unsettled: [],
    });
    // DynamoDB's answer to a PutItem on an item a transaction still holds: nothing to read yet.
    const other = new MemoryStore();
    const pending = vaultFor(owners[0], script());
    await unreserved(other, pending);
    // A later row on the same script is unsettled too, not a duplicate of a vault that holds nothing.
    const twin = older(vaultFor(owners[1], pending.scriptHex), "2099-01-01T00:00:00.000Z");
    await unreserved(other, twin);
    vi.spyOn(other, "put").mockRejectedValueOnce(Object.assign(new Error("in flight"), { name: "TransactionConflictException" }));
    expect(await backfillScriptReservations(other, await other.vaultRows(), true)).toMatchObject({
      reserved: 0,
      duplicates: [],
      unsettled: [pending.id, twin.id],
    });
    // Any other failure stops the run.
    vi.spyOn(other, "put").mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    await expect(backfillScriptReservations(other, await other.vaultRows(), true)).rejects.toThrow("denied");
  });

  it("scans every page of the table for vault rows, with consistent reads", async () => {
    const vault: Row = { pk: "OWNER#a", sk: "VAULT#1", version: 0 };
    const send = vi
      .spyOn(DynamoDBDocumentClient.prototype, "send")
      .mockResolvedValueOnce({ Items: [vault], LastEvaluatedKey: { pk: "OWNER#a", sk: "VAULT#1" } } as never)
      .mockResolvedValueOnce({ Items: [{ pk: "OWNER#a", sk: "JOB#1", version: 0 }] } as never);
    expect(await new DynamoStore("qsb-test-records").vaultRows()).toEqual([vault]);
    const scans = send.mock.calls.map(([command]) => (command as ScanCommand).input);
    expect(scans.map((input) => input.ExclusiveStartKey)).toEqual([undefined, { pk: "OWNER#a", sk: "VAULT#1" }]);
    expect(scans.every((input) => input.ConsistentRead && input.TableName === "qsb-test-records")).toBe(true);
  });

  it.each([
    [{ AWS_REGION: "eu-west-2", QSB_NETWORK: "mainnet" }, [], "TableNameRequired"],
    [{ TABLE_NAME: "qsb-test-records", QSB_NETWORK: "mainnet" }, [], "AwsRegionRequired"],
    [{ TABLE_NAME: "qsb-test-records", AWS_REGION: "eu-west-2" }, [], "MainnetEnvironmentRequired"],
    [{ TABLE_NAME: "qsb-test-records", AWS_REGION: "eu-west-2", QSB_NETWORK: "mainnet" }, ["--force"], "InvalidOptions"],
  ])("the CLI refuses before touching the table: %o %o", (env, args, reason) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/reserve-vault-scripts.ts", ...args], {
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ action: "refuse", reason });
    expect(result.stdout).toBe("");
  });
});

describe("a vault whose script another vault holds takes no deposit", () => {
  const legacy = async (store: MemoryStore, vault: PublicVault) =>
    store.put({ pk: `OWNER#${vault.paymentAddress}`, sk: `VAULT#${vault.id}`, version: 0, vault });
  const refused = {
    status: 409,
    body: { error: "Another vault on this deployment holds this vault's script, so this vault takes no deposit.", code: "vault_script_registered" },
  };

  it("refuses every deposit route before anything is recorded or sent", async () => {
    const store = new MemoryStore();
    const f = await fixture(store);
    // Two vault rows on one script, both older than reservations; the backfill gave the script to
    // the first. The second holds a submitted deposit, which a resend would send to the miner and
    // an export would mark as exported.
    // A script a transaction can carry: OP_1 to OP_16 only.
    const scriptHex = Array.from(randomBytes(100), (b) => (0x51 + (b % 16)).toString(16)).join("");
    const holder = vaultFor(owners[0], scriptHex);
    const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, version: 2 });
    tx.addInput({ txid: new Uint8Array(32).fill(7), index: 0 });
    tx.addOutput({ script: hex.decode(scriptHex), amount: 50_000n });
    const loser = { ...vaultFor(owners[1], scriptHex), status: "submitted" as const, funding: { txid: tx.id, vout: 0, value: "50000" } };
    await legacy(store, holder);
    await store.put({
      pk: `OWNER#${owners[1]}`, sk: `VAULT#${loser.id}`, version: 0, vault: loser,
      fundingRawTxHex: hex.encode(tx.toBytes(true, false)),
    });
    await store.put(scriptReservation(owners[0], holder));
    const before = structuredClone([...store.rows.entries()]);
    const deposit = { rawTxHex: "00", amount: "50000", costAccepted: true };
    for (const [method, path, body] of [
      ["POST", `/vaults/${loser.id}/fund`, { txid: "ab".repeat(32), amount: "50000", costAccepted: true }],
      ["POST", `/vaults/${loser.id}/fund/submit`, deposit],
      ["GET", `/vaults/${loser.id}/fund/signed`, undefined],
      ["POST", `/vaults/${loser.id}/fund/resubmit`, {}],
    ] as const)
      expect(await f.call(method, path, owners[1], body), path).toEqual(refused);
    expect([...store.rows.entries()]).toEqual(before);
    expect(f.minerCalls).toEqual([]);
    // Nor does /funding offer its stored bytes while the chain doesn't know the deposit: only the
    // chain answers for it, and nothing is marked exported.
    const funding = await f.call("GET", `/vaults/${loser.id}/funding`, owners[1]);
    expect(funding).toMatchObject({ status: 409, body: { code: "chain_transaction_not_found" } });
    expect(JSON.stringify(funding)).not.toContain(store.rows.get(`OWNER#${owners[1]}|VAULT#${loser.id}`)!.fundingRawTxHex as string);
    expect([...store.rows.entries()]).toEqual(before);
    // Nor is it offered as resendable, while a submitted vault with no reservation still is.
    const unreserved = { ...vaultFor(owners[1], script()), status: "submitted" as const };
    await store.put({ pk: `OWNER#${owners[1]}`, sk: `VAULT#${unreserved.id}`, version: 0, vault: unreserved, fundingRawTxHex: "00" });
    const listed = (await f.call("GET", "/vaults", owners[1])).body;
    expect(listed.resendable).toEqual([unreserved.id]);
    // It's listed as taking no deposit, so clients refuse before anything is signed; the holder isn't.
    expect(listed.noDeposit).toEqual([loser.id]);
    expect((await f.call("GET", "/vaults", owners[0])).body.noDeposit).toEqual([]);
    // The vault that holds the script, and a vault row with no reservation, get past the check on a deposit route.
    expect(await f.call("GET", `/vaults/${holder.id}/fund/signed`, owners[0])).toMatchObject({ status: 404, body: { code: "signed_deposit_not_found" } });
    expect(await f.call("POST", `/vaults/${unreserved.id}/fund/resubmit`, owners[1], {})).toMatchObject({ status: 409, body: { code: "signed_deposit_not_found" } });
    expect(f.minerCalls).toEqual([]);
  });
});

describe("a deposit write and its script's reservation change together", () => {
  /** A script a transaction can carry (OP_1 to OP_16), and a deposit paying it. */
  const payable = () => {
    const scriptHex = Array.from(randomBytes(100), (b) => (0x51 + (b % 16)).toString(16)).join("");
    const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, version: 2 });
    tx.addInput({ txid: randomBytes(32), index: 0 });
    tx.addOutput({ script: hex.decode(scriptHex), amount: 50_000n });
    return { scriptHex, rawTxHex: hex.encode(tx.toBytes(true, false)) };
  };
  const working = () => {
    const submitted: string[] = [];
    const miner = {
      credential: async () => ({}),
      seen: async () => false,
      submitFunding: async (raw: string) => {
        submitted.push(raw);
        return { status: "success" as const, message: btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownInputs: true, allowUnknownOutputs: true }).id };
      },
    } as unknown as Slipstream;
    return { miner, submitted };
  };
  /** A vault row written without a reservation, as POST /api/vaults once did. */
  const legacy = async (store: MemoryStore, vault: PublicVault, extra: Record<string, unknown> = {}) =>
    store.put({ pk: `OWNER#${vault.paymentAddress}`, sk: `VAULT#${vault.id}`, version: 0, vault, ...extra });
  /** Another vault's registration of the same script, landing just before the next transaction. */
  const registrationLandsFirst = (store: MemoryStore, vault: PublicVault) => {
    const atomicPut = store.atomicPut.bind(store);
    vi.spyOn(store, "atomicPut").mockImplementationOnce(async (writes) => {
      await store.put(scriptReservation(owners[1], { id: randomUUID(), scriptHash: vault.scriptHash }));
      return atomicPut(writes);
    });
  };

  it("claims an unreserved vault's script with its deposit intent", async () => {
    const store = new MemoryStore();
    const { miner, submitted } = working();
    const f = await fixture(store, { miner });
    const { scriptHex, rawTxHex } = payable();
    const vault = vaultFor(owners[0], scriptHex);
    await legacy(store, vault);
    const answer = await f.call("POST", `/vaults/${vault.id}/fund/submit`, owners[0], { rawTxHex, amount: "50000", costAccepted: true });
    expect(answer).toMatchObject({ status: 201, body: { submission: "submitted" } });
    expect(submitted).toEqual([rawTxHex]);
    expect(f.rows().reservations).toEqual([scriptReservation(owners[0], vault)]);
  });

  it("records and sends nothing when another vault reserves the script between the check and the intent", async () => {
    const store = new MemoryStore();
    const { miner, submitted } = working();
    const f = await fixture(store, { miner });
    const { scriptHex, rawTxHex } = payable();
    const vault = vaultFor(owners[0], scriptHex);
    await legacy(store, vault);
    registrationLandsFirst(store, vault);
    const body = { rawTxHex, amount: "50000", costAccepted: true };
    expect(await f.call("POST", `/vaults/${vault.id}/fund/submit`, owners[0], body)).toMatchObject({ status: 409, body: { code: "state_conflict" } });
    expect(submitted).toEqual([]);
    const row = store.rows.get(`OWNER#${owners[0]}|VAULT#${vault.id}`)!;
    expect([(row.vault as PublicVault).status, row.fundingRawTxHex]).toEqual(["unfunded", undefined]);
    // The retry is refused outright.
    expect(await f.call("POST", `/vaults/${vault.id}/fund/submit`, owners[0], body)).toMatchObject({ status: 409, body: { code: "vault_script_registered" } });
    expect(submitted).toEqual([]);
  });

  it("resends nothing when another vault reserves the script just before a resend", async () => {
    const store = new MemoryStore();
    const { miner, submitted } = working();
    const f = await fixture(store, { miner });
    const { scriptHex, rawTxHex } = payable();
    const txid = btc.Transaction.fromRaw(hex.decode(rawTxHex), { allowUnknownInputs: true, allowUnknownOutputs: true }).id;
    const vault = { ...vaultFor(owners[0], scriptHex), status: "submitted" as const, funding: { txid, vout: 0, value: "50000" } };
    await legacy(store, vault, { fundingRawTxHex: rawTxHex, fundingSubmission: "uncertain" });
    registrationLandsFirst(store, vault);
    expect(await f.call("POST", `/vaults/${vault.id}/fund/resubmit`, owners[0], {})).toMatchObject({ status: 409, body: { code: "vault_script_registered" } });
    expect(submitted).toEqual([]);
  });
});

describe("the webapp's message when the server refuses a new vault", () => {
  it("says nothing was saved, and to keep the downloaded backup when the script isn't new", () => {
    const message = (code: string, status = 409) => (registrationError(new ApiRequestError("server text", status, code)) as Error).message;
    expect(message("chain_unavailable", 503)).toBe("The server couldn't check this vault's script on chain, so it saved nothing. Try again shortly.");
    expect(message("chain_error", 502)).toBe(message("chain_unavailable", 503));
    for (const code of ["vault_script_paid", "vault_script_registered"]) {
      expect(message(code)).toContain("nothing was saved");
      expect(message(code)).toMatch(/keep the backup you downloaded/i);
    }
    const other = new ApiRequestError("Invalid vault ownership or funding state.", 400, "vault_invalid");
    expect(registrationError(other)).toBe(other);
  });

  it("says a refused deposit sent nothing and shouldn't be resent", () => {
    const refused = new ApiRequestError("server text", 409, "vault_script_registered");
    expect(depositRefusal(refused)?.message).toBe(
      "Another vault on this server has this vault's script, so this vault takes no deposit. Don't make a deposit for it. This request sent nothing. If you submitted this deposit before, it may still confirm: the vault shows it once it's mined, so keep this vault's recovery backup.",
    );
    // A broadcast Xverse already made isn't something this request could have held back.
    expect(depositRefusal(refused, "ab".repeat(32))?.message).toBe(
      `Another vault on this server has this vault's script, so this vault takes no deposit. Don't make a deposit for it. The app won't record the transaction Xverse broadcast, ${"ab".repeat(32)}: it may still confirm, and the app never spends it. Keep this vault's recovery backup: its secrets are what can spend that payment.`,
    );
    // Any other failure stays an uncertain submission.
    expect(depositRefusal(new ApiRequestError("Unable to complete the request. Please retry.", 502, "miner_request_failed"))).toBeUndefined();
    expect(depositRefusal(new Error("fetch failed"))).toBeUndefined();
  });
});
