// Hermetic world for the SDK and CLI tests: createApp in-process with the
// in-memory store, a fake Esplora behind the real Esplora client, a fake miner
// and a recording transport. No socket is opened and nothing leaves the process.
import { randomBytes } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { Esplora } from "../server/chain";
import { MinerHttpError, Slipstream } from "../server/providers";
import { outputScript } from "../src/lib/transactions";
import type { Job, Withdrawal } from "../src/lib/model";
import { nodeQsb, loopbackTestSigner, QsbClient, type LocalQsb, type QsbClientOptions } from "../sdk";

const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };
const GENESIS = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
export const API = "http://127.0.0.1:8787";

/** Just enough of the Esplora HTTP API, over an in-memory ledger. */
export class FakeChain {
  private txs = new Map<string, { raw: string; tx: btc.Transaction; height?: number }>();
  private blocks = [GENESIS];
  add(raw: string): string {
    const tx = btc.Transaction.fromRaw(hex.decode(raw), opts);
    if (!this.txs.has(tx.id)) this.txs.set(tx.id, { raw: raw.toLowerCase(), tx });
    return tx.id;
  }
  mine(...ids: string[]) {
    this.blocks.push(hex.encode(randomBytes(32)));
    for (const id of ids) this.txs.get(id)!.height = this.blocks.length - 1;
  }
  has(id: string) {
    return this.txs.has(id);
  }
  confirmed(id: string) {
    return this.txs.get(id)?.height !== undefined;
  }
  private spender(id: string, vout: number) {
    for (const [txid, { tx }] of this.txs)
      for (let vin = 0; vin < tx.inputsLength; vin++) {
        const input = tx.getInput(vin);
        if (input.txid && hex.encode(input.txid) === id && input.index === vout) return { txid, vin };
      }
  }
  readonly fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const text = (body: string) => new Response(body);
    const json = (body: unknown) => new Response(JSON.stringify(body));
    const missing = () => new Response("not found", { status: 404 });
    const status = (height?: number) =>
      height === undefined
        ? { confirmed: false }
        : { confirmed: true, block_height: height, block_hash: this.blocks[height] };
    let m: RegExpExecArray | null;
    if ((m = /^\/block-height\/(\d+)$/.exec(path)))
      return this.blocks[Number(m[1])] ? text(this.blocks[Number(m[1])]) : missing();
    if (path === "/blocks/tip/height") return text(String(this.blocks.length - 1));
    if ((m = /^\/tx\/([0-9a-f]{64})\/hex$/.exec(path)))
      return this.txs.has(m[1]) ? text(this.txs.get(m[1])!.raw) : missing();
    if ((m = /^\/tx\/([0-9a-f]{64})\/status$/.exec(path)))
      return this.txs.has(m[1]) ? json(status(this.txs.get(m[1])!.height)) : missing();
    if ((m = /^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/.exec(path))) {
      const spent = this.spender(m[1], Number(m[2]));
      return json(spent ? { spent: true, ...spent } : { spent: false });
    }
    if ((m = /^\/address\/([^/]+)\/utxo$/.exec(path))) {
      const script = hex.encode(outputScript(decodeURIComponent(m[1])));
      const rows = [];
      for (const [txid, { tx, height }] of this.txs)
        for (let vout = 0; vout < tx.outputsLength; vout++) {
          const out = tx.getOutput(vout);
          if (out.script && hex.encode(out.script) === script && !this.spender(txid, vout))
            rows.push({ txid, vout, value: Number(out.amount), status: status(height) });
        }
      return json(rows);
    }
    return missing();
  }) as typeof fetch;
}

export type Recorded = { method: string; url: string; headers: Record<string, string>; body: string };

export function world() {
  const store = new MemoryStore();
  const chain = new FakeChain();
  const minerSubmissions: string[] = [];
  const credential = new Slipstream("https://slipstream.mara.com", async () => undefined);
  /** MARA's quote, and whether its POSTs lose their answer; tests change both. */
  const rates = { submit_fee_rate: 1, market_rate: 2, effective_rate: 2.5 };
  const lost = { deposit: false, withdrawal: false };
  const relay = (kind: keyof typeof lost) => async (raw: string) => {
    if (lost[kind]) throw new Error("socket hang up");
    minerSubmissions.push(raw);
    return { status: "success", message: chain.add(raw) };
  };
  const miner = {
    rates: async () => ({ ...rates }),
    credential: () => credential.credential(),
    submitFunding: relay("deposit"),
    submit: relay("withdrawal"),
    seen: async (id: string) => chain.has(id),
    status: async (id: string) => {
      if (!chain.has(id)) throw new MinerHttpError(400, "Transaction not found");
      return { transaction: { txid: id, status: { confirmed: chain.confirmed(id) } } };
    },
  } as unknown as Slipstream;
  const consensus = { verified: [] as string[], async verify(raw: string) { this.verified.push(raw); } };
  // The sign-in challenge names APP_ORIGIN, read once here; the SDK signs only its own origin's.
  const previousOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = API;
  const app = createApp(store, {
    chain: new Esplora("https://esplora.invalid", chain.fetch),
    miner,
    enabled: true,
    exactSubmit: true,
    consensus,
  });
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previousOrigin;
  const requests: Recorded[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (typeof input !== "string" || new URL(url).origin !== API) throw new Error(`Unexpected destination ${url}`);
    // The SDK sends JSON text only; any other body would go unrecorded, so it fails the test.
    if (init?.body !== undefined && init.body !== null && typeof init.body !== "string")
      throw new Error("Unrecorded request body");
    requests.push({
      method: init?.method ?? "GET",
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ?? "",
    });
    return app.fetch(new Request(url, init));
  }) as typeof fetch;
  return { store, chain, app, miner, consensus, minerSubmissions, requests, rates, lost, fetch: transport };
}

/** A funded wallet: one confirmed transaction paying the key's P2WPKH address twice. */
export function wallet(chain: FakeChain, values = [300000n, 50000n]) {
  const privateKey = randomBytes(32);
  const pub = secp256k1.getPublicKey(privateKey, true);
  const address = btc.p2wpkh(pub).address!;
  const source = new btc.Transaction(opts);
  source.addInput({ txid: randomBytes(32), index: 0 });
  for (const value of values) source.addOutputAddress(address, value);
  const txid = chain.add(hex.encode(source.toBytes(true, false)));
  chain.mine(txid);
  return { privateKey, wif: btc.WIF().encode(privateKey), address, fundingTxid: txid };
}

/** Stand in for the coordinator: record a CPU-verified solution on the job, as it does. */
export async function solve(store: MemoryStore, owner: string, jobId: string) {
  const row = (await store.get(`OWNER#${owner}`, `JOB#${jobId}`))!;
  const job = row.job as Job;
  const solution = {
    sequence: 2147483648,
    locktime: 500000000,
    round1: [0, 1, 2, 3, 4, 5, 6, 7, 8],
    round2: [10, 11, 12, 13, 14, 15, 16, 17, 18],
  };
  await store.put(
    { ...row, version: row.version + 1, job: { ...job, status: "awaiting_authorization", stage: "verification", solution } },
    row.version,
  );
  return solution;
}

/**
 * The real Pyodide runtime, except for assembly. A real Config A hit needs a
 * GPU search (about 2^46 work for the pinning stage alone), and the Python
 * assembler refuses anything else (tests/sdk-runtime.test.ts checks that). This
 * double returns the layout cmd_assemble produces for the manifest and
 * solution, with a placeholder QSB scriptSig, like tests/authorization-harness.tsx.
 */
export function localQsb() {
  const real = nodeQsb();
  const assembled: { state: string; manifest: Withdrawal; solution: NonNullable<Job["solution"]> }[] = [];
  const qsb: LocalQsb = {
    ...real,
    async assembleQsb(state, manifest, solution) {
      const m = manifest as Withdrawal, hit = solution as NonNullable<Job["solution"]>;
      assembled.push({ state, manifest: m, solution: hit });
      const tx = new btc.Transaction({ ...opts, version: 1, lockTime: hit.locktime });
      tx.addInput({ txid: m.helper.txid, index: m.helper.vout, sequence: 0xfffffffe });
      tx.addInput({ txid: m.funding.txid, index: m.funding.vout, sequence: hit.sequence });
      tx.addOutput({ script: hex.decode(m.outputScript), amount: BigInt(m.outputValue) });
      tx.updateInput(1, { finalScriptSig: hex.decode("0101") }, true);
      return hex.encode(tx.toBytes(true, true));
    },
  };
  return { qsb, assembled };
}

type Staging = { wrap?: (next: typeof fetch) => typeof fetch; options?: Partial<QsbClientOptions> };
/** A signed-in SDK client with one registered vault. `backups[0]` is its encrypted backup. */
export async function createdVault(passphrase: string, staging: Staging = {}) {
  const w = world();
  const owner = wallet(w.chain);
  const signer = loopbackTestSigner(owner.wif, API);
  const { qsb } = localQsb();
  const remembered = new Map<string, string>();
  const client = new QsbClient({
    baseUrl: API,
    signer,
    fetch: (staging.wrap ?? ((next) => next))(w.fetch),
    qsb,
    authorizations: { getItem: (k) => remembered.get(k) ?? null, setItem: (k, v) => void remembered.set(k, v) },
    ...staging.options,
  });
  await client.login();
  const backups: string[] = [];
  const keep = async (text: string) => void backups.push(text);
  const { vault } = await client.vaults.create({ name: "sdk client", passphrase, saveBackup: keep });
  return { w, owner, signer, client, vault, backups, keep, qsb };
}
/** The same, with its deposit relayed and confirmed. */
export async function fundedVault(passphrase: string, staging: Staging = {}) {
  const v = await createdVault(passphrase, staging);
  const prepared = await v.client.deposits.prepare(v.vault.id, {
    backup: v.backups[0],
    passphrase,
    amount: 200000n,
    feeRate: "2",
    utxos: [{ txid: v.owner.fundingTxid, vout: 0 }],
  });
  const signed = await v.signer.signPsbt(v.signer.address, prepared.psbt, prepared.signInputs);
  const deposit = await v.client.deposits.submit(prepared, signed, { costAccepted: true });
  v.w.chain.mine(deposit.txid);
  const destination = btc.p2wpkh(secp256k1.getPublicKey(randomBytes(32), true)).address!;
  return { ...v, destination };
}
/** The same, with a withdrawal the coordinator has solved. `backups[1]` binds its intent. */
export async function solvedWithdrawal(passphrase: string, wrap?: Staging["wrap"]) {
  const f = await fundedVault(passphrase, { wrap });
  const { job } = await f.client.withdrawals.create({
    vaultId: f.vault.id,
    backup: f.backups[0],
    passphrase,
    helper: { txid: f.owner.fundingTxid, vout: 1 },
    destination: f.destination,
    feeRate: "3",
    costAccepted: true,
    saveBackup: f.keep,
  });
  await solve(f.w.store, f.owner.address, job.id);
  return { ...f, job };
}
