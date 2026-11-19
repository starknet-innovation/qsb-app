// One-input PQB withdrawals: the vault is the only input and pays the fee (issue #168).
// Synthetic public fixtures only: no real GPU solve, no mainnet spend.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { SFNClient } from "@aws-sdk/client-sfn";
vi.mock("../src/lib/releases/registry.generated", async () => {
  const { servedFixture, pqbFixture } = await import("./solver-fixture");
  return { default: [servedFixture, pqbFixture] };
});
vi.mock("../sdk/public-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sdk/public-runtime")>();
  const { publicPlannerDouble } = await import("./sdk-planner-double");
  return { publicRuntime: () => publicPlannerDouble(actual.publicRuntime()) };
});
import reference from "./fixtures/pqb-reference.json";
import { adoptPqb, pqbPacket, pqbProblem, pqbStart, pqbTransaction, PQB_MAX_SCRIPTSIG } from "../src/lib/pqb";
import { withdrawalSchema, type Job, type PublicVault, type Withdrawal } from "../src/lib/model";
import { pinSolver, withVaultConfiguration } from "../src/lib/provenance";
import { transactionVsize, verifyWithdrawalCommitment, withdrawalVsize } from "../src/lib/transactions";
import { buildLock } from "../src/pqb-core/lock";
import { assemble, pinFields } from "../src/pqb-core/spend";
import { problemFromPacket } from "../src/pqb-core/grind";
import { concat, fromHex, hash160, toInt } from "../src/pqb-core/primitives";
import { pushData } from "../src/pqb-core/l1gen";
import { legacySighashAll, parseScript, serializeTx, type Tx } from "../src/pqb-core/tx";
import { verifyPqbWitness } from "../sdk/verify-pqb-witness";
import { assertWithdrawalSpendAgainstJob } from "../server/transaction-checks";
import { buildStoredSpendRecord } from "../server/job-spend-record";
import { Esplora } from "../server/chain";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { NETWORK_CONFIG } from "../src/lib/network";
import { fixtureVault, pqbFixture, servedFixture } from "./solver-fixture";
import { managedProviders, solve, wallet, world } from "./sdk-fixture";
import { QsbClient } from "../sdk/index";
import { coordinatorSignedResultSchema } from "../src/mainnet/coordinatorResult";

const twoInput = withdrawalSchema.parse(reference.manifest);
const { helper: _helper, ...rest } = twoInput;
// The same vault output and payee; the vault alone now pays the fee.
const oneInput: Withdrawal = withdrawalSchema.parse({ ...rest, outputValue: "99000", fee: "1000" });
const [locktime, sequence] = pinFields(BigInt(reference.pinNonce));
const prior = { locktime, sequence, round1: reference.priorSelection, round2: [] };
let generated: ReturnType<typeof adoptPqb>;
beforeAll(() => { generated = adoptPqb(JSON.stringify({ config: "PQB", seed: reference.seed })); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("one-input PQB transaction and problems", () => {
  it("builds version 1, the vault as the only input, one output, and the fee from the vault", () => {
    const tx = pqbTransaction(oneInput, sequence, locktime);
    expect(tx.version).toBe(1);
    expect(tx.locktime).toBe(locktime);
    expect(tx.vin).toHaveLength(1);
    expect(tx.vin[0]).toMatchObject({ txid: oneInput.funding.txid, vout: oneInput.funding.vout, sequence });
    expect(tx.vout).toEqual([{ value: 99000n, script: fromHex(oneInput.outputScript) }]);
    expect(() => pqbTransaction({ ...oneInput, outputValue: "99001" })).toThrow("amounts");
    expect(() => pqbTransaction({ ...twoInput, helper: { ...twoInput.funding } })).toThrow("inputs");
  });

  it("grinds every stage at input 0, over a problem the two-input layout can't satisfy", () => {
    for (const stage of [0, 1, 2]) {
      const packet = pqbPacket(generated.publicStateJson, oneInput, stage, prior);
      expect(packet.n_in).toBe(0);
      expect(pqbPacket(generated.publicStateJson, twoInput, stage, prior).n_in).toBe(1);
      expect(pqbProblem(generated.publicStateJson, oneInput, stage, prior))
        .not.toBe(pqbProblem(generated.publicStateJson, twoInput, stage, prior));
    }
    // The pinning problem still finds nSequence and nLockTime in the one-input preimage.
    const pin = problemFromPacket(pqbPacket(generated.publicStateJson, oneInput, 0));
    expect(pin.seq_off).toBeLessThan(pin.lt_off!);
  });

  it("assembles the one-input witness with a SIGHASH_ALL co-signature over input 0", () => {
    // Witness assembly only: these default subsets do not solve the real hash puzzles.
    const lock = buildLock("PQB", fromHex(reference.seed));
    const tx = pqbTransaction(oneInput, sequence, locktime);
    const out = assemble(lock, { txid: oneInput.funding.txid, vout: 0, amount: 100000 }, [], {
      transaction: tx, inputIndex: 0, selection: [reference.priorSelection, [0, 1, 2, 4, 5, 6, 7, 8, 10]],
    });
    expect(out.simError).toBeNull();
    expect(out.tx.vin).toHaveLength(1);
    expect(out.tx.vin[0].scriptSig).toEqual(out.scriptSig);
    expect(out.scriptSig.length).toBeLessThanOrEqual(PQB_MAX_SCRIPTSIG);
    expect(out.zCosig).toBe(toInt(legacySighashAll(out.tx, 0, lock.script)));
    const pushes = parseScript(out.scriptSig), sig = pushes.at(-2)![2]!, pk = pushes.at(-1)![2]!;
    expect(secp256k1.verify(sig.subarray(0, -1), legacySighashAll(out.tx, 0, lock.script), pk,
      { format: "der", prehash: false, lowS: true })).toBe(true);
    // The SDK verifier checks input 0 and still refuses unsolved puzzle signatures.
    expect(() => verifyPqbWitness(out.hex, reference.scriptHex, 0)).toThrow(/signature|SIGHASH_ALL/);
    expect(() => verifyPqbWitness(out.hex, reference.scriptHex, 1)).toThrow("vault input is missing");
  });

  it("verifies a synthetic one-input co-signature at input 0 and rejects an edited output", () => {
    // Synthetic signature/stack component fixture, not a real PQB hash-puzzle solution.
    const key = new Uint8Array(32).fill(7), pk = secp256k1.getPublicKey(key, true);
    const script = concat([0x76, 0xa9], pushData(hash160(pk)), [0x88, 0xad, 0x51]);
    const tx: Tx = { version: 1, locktime: 500000000,
      vin: [{ txid: "22".repeat(32), vout: 0, sequence: 0x80000000, scriptSig: new Uint8Array() }],
      vout: [{ value: 10000n, script: Uint8Array.from([0x51]) }] };
    const sig = concat(secp256k1.sign(legacySighashAll(tx, 0, script), key, { prehash: false, format: "der" }), [1]);
    tx.vin[0].scriptSig = concat(pushData(sig), pushData(pk));
    expect(() => verifyPqbWitness(hex.encode(serializeTx(tx)), hex.encode(script), 0)).not.toThrow();
    tx.vout[0].value++;
    expect(() => verifyPqbWitness(hex.encode(serializeTx(tx)), hex.encode(script), 0)).toThrow("Invalid PQB signature");
  });

  it("returns the fields a device rebuilds the transaction from", () => {
    const solution = { sequence, locktime, round1: [0, 1, 2, 3, 4, 5, 6, 7], round2: [8, 9, 10, 11, 12, 13, 14, 15, 16],
      pqb: { pinning: `${sequence} ${locktime} 3 0 0 1`, round0: "0,1,2,3,4,5,6,7 5 1 0 1", round1: "0,1,2,3,4,5,6,7,8 9 2 0 1" } };
    expect(pqbStart(generated.publicStateJson, oneInput, solution)).toEqual({ sequence, locktime,
      round0: solution.round1, round1: solution.round2, picks: [3, 5, 9] });
    expect(() => pqbStart(generated.publicStateJson, oneInput, { ...solution, pqb: { pinning: solution.pqb.pinning } }))
      .toThrow("Incomplete");
  });

  it("bounds the fee by the one-input size, which has no witness", () => {
    const script = fromHex(oneInput.outputScript);
    const tx: Tx = { ...pqbTransaction(oneInput, sequence, locktime) };
    tx.vin[0].scriptSig = new Uint8Array(PQB_MAX_SCRIPTSIG);
    const vsize = withdrawalVsize(null, script.length, PQB_MAX_SCRIPTSIG);
    expect(transactionVsize(hex.encode(serializeTx(tx)))).toBe(vsize);
    expect(vsize).toBeLessThan(withdrawalVsize(false, script.length, PQB_MAX_SCRIPTSIG));
  });
});

/** A placeholder vault scriptSig shaped like PQB's top: a SIGHASH_ALL co-signature, then its key. */
const cosigned = (hashtype = "01") => "09" + "aa".repeat(8) + hashtype + "21" + "02" + "bb".repeat(32);
/** A signed-shaped one-input spend: the scriptSig is a placeholder, the checks bind its layout. */
function oneInputRaw(change: { locktime?: number; sequence?: number; amount?: bigint; extra?: "input" | "output";
  scriptSig?: string } = {}) {
  const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true, version: 1,
    lockTime: change.locktime ?? locktime });
  if (change.extra === "input") tx.addInput({ txid: "22".repeat(32), index: 1, sequence: 0xfffffffe });
  tx.addInput({ txid: oneInput.funding.txid, index: oneInput.funding.vout, sequence: change.sequence ?? sequence });
  tx.addOutput({ script: hex.decode(oneInput.outputScript), amount: change.amount ?? 99000n });
  if (change.extra === "output") tx.addOutput({ script: hex.decode(oneInput.outputScript), amount: 1n });
  tx.updateInput(change.extra === "input" ? 1 : 0, { finalScriptSig: hex.decode(change.scriptSig ?? cosigned()) }, true);
  return hex.encode(tx.toBytes(true, true));
}
const solvedJob = (manifest: Withdrawal = oneInput) => ({ manifest, status: "awaiting_authorization",
  solution: { sequence, locktime, round1: [0, 1, 2, 3, 4, 5, 6, 7], round2: [8, 9, 10, 11, 12, 13, 14, 15, 16],
    pqb: { pinning: "a", round0: "b", round1: "c" } } }) as unknown as Job;

describe("one-input exact-spend binding", () => {
  it("accepts exactly the approved one-input spend and refuses each change", () => {
    expect(() => assertWithdrawalSpendAgainstJob(solvedJob(), oneInputRaw())).not.toThrow();
    for (const change of [{ locktime: locktime + 1 }, { sequence: sequence + 1 }, { amount: 99001n },
      { amount: 98999n }, { extra: "input" as const }, { extra: "output" as const },
      // A co-signature that doesn't commit to the outputs (SIGHASH_NONE), or none on top.
      { scriptSig: cosigned("02") }, { scriptSig: cosigned("81") }, { scriptSig: "0101" }])
      expect(() => assertWithdrawalSpendAgainstJob(solvedJob(), oneInputRaw(change))).toThrow("ExactSpendMismatch");
    // A one-input spend never satisfies a two-input intent.
    expect(() => assertWithdrawalSpendAgainstJob(solvedJob({ ...twoInput, outputValue: "109000" }), oneInputRaw()))
      .toThrow("ExactSpendMismatch");
    expect(() => verifyWithdrawalCommitment(oneInputRaw(), oneInput, solvedJob().solution!)).not.toThrow();
    expect(() => verifyWithdrawalCommitment(oneInputRaw({ extra: "input" }), oneInput, solvedJob().solution!))
      .toThrow("approved intent");
  });

  it("stores a spend record without a helper", () => {
    const record = buildStoredSpendRecord(solvedJob());
    expect(record).not.toHaveProperty("helper");
    expect(record).toMatchObject({ funding: { txid: oneInput.funding.txid, vout: 0, valueSats: "100000" },
      outputValue: "99000", fee: "1000", sequence, locktime });
    expect(() => buildStoredSpendRecord(solvedJob({ ...oneInput, fee: "999" }))).toThrow("ExactSpendMismatch");
  });

  it("matches a one-input spender of the funding outpoint", async () => {
    const raw = oneInputRaw(), id = btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownInputs: true,
      allowUnknownOutputs: true }).id, block = "44".repeat(32);
    const chain = new Esplora("https://example.invalid", async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/block-height/0") return new Response(NETWORK_CONFIG.genesisHash);
      if (path === `/tx/${oneInput.funding.txid}/outspend/0`)
        return Response.json({ spent: true, txid: id, vin: 0, status: { confirmed: true } });
      if (path === `/tx/${id}/hex`) return new Response(raw);
      if (path === `/tx/${id}/status`) return Response.json({ confirmed: true, block_height: 100, block_hash: block });
      if (path === "/block-height/100") return new Response(block);
      if (path === "/blocks/tip/height") return new Response("102");
      throw Error(`Unexpected path ${path}`);
    });
    expect(await chain.withdrawalInclusion(oneInput)).toMatchObject({ outpointMatched: true, outputMatched: true });
    await expect(chain.withdrawalInclusion({ ...oneInput, outputValue: "98000", fee: "2000" })).rejects.toThrow("output mismatch");
    await expect(chain.withdrawalInclusion(twoInput)).rejects.toThrow("input mismatch");
  });
});

describe("POST /api/jobs without a helper", () => {
  async function setup(config: "A" | "PQB") {
    vi.stubEnv("SOLVER_RELEASE_ID", config === "PQB" ? pqbFixture.id : servedFixture.id);
    vi.stubEnv("WORKFLOW_ARN", "arn:aws:states:eu-west-1:123456789012:stateMachine:test");
    const store = new MemoryStore(), token = "a".repeat(43);
    const key = hex.decode("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    const payment = btc.p2wpkh(key), owner = payment.address!;
    const funding = { txid: "11".repeat(32), vout: 0, value: "100000" };
    const base = config === "PQB"
      ? withVaultConfiguration({ id: crypto.randomUUID(), name: "pqb", network: "mainnet", config: "PQB",
        createdAt: "2026-11-11T00:00:00.000Z", paymentAddress: owner, scriptHex: generated.scriptHex,
        scriptHash: generated.scriptHash, publicStateJson: generated.publicStateJson, status: "confirmed", funding })
      : { ...fixtureVault, id: crypto.randomUUID(), status: "confirmed", funding };
    const vault = base as PublicVault;
    await store.put({ pk: `OWNER#${owner}`, sk: `VAULT#${vault.id}`, version: 0, vault });
    await store.put({ pk: `SESSION#${createHash("sha256").update(token).digest("hex")}`, sk: "AUTH", version: 0,
      owner, network: "mainnet" });
    const unspent = vi.fn().mockResolvedValue({});
    const app = createApp(store, { enabled: true, chain: { unspent } as never });
    const workflow = vi.spyOn(SFNClient.prototype, "send").mockResolvedValue({} as never);
    const manifest = { vaultId: vault.id, funding, destination: owner, outputScript: hex.encode(payment.script),
      outputValue: "99000", fee: "1000", idempotencyKey: crypto.randomUUID(), costAccepted: true };
    const post = (body: unknown) => app.request("/api/jobs", { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { store, manifest, post, unspent, workflow, vault };
  }

  it("creates a PQB withdrawal that reserves only the vault outpoint", async () => {
    const f = await setup("PQB");
    const response = await f.post(f.manifest);
    expect(response.status).toBe(201);
    const { job } = await response.json();
    expect(job.manifest).not.toHaveProperty("helper");
    expect(job.solver).toEqual(pinSolver(f.vault, pqbFixture.id));
    expect(f.unspent).toHaveBeenCalledTimes(1);
    expect(f.unspent).toHaveBeenCalledWith(f.manifest.funding, f.vault.scriptHex);
    expect([...f.store.rows.values()].filter(row => row.pk.startsWith("OUTPOINT#")).map(row => row.pk))
      .toEqual([`OUTPOINT#${f.manifest.funding.txid}:0`]);
    expect(f.workflow).toHaveBeenCalledTimes(1);
  });

  it("refuses an unbalanced one, and a helper that is the vault outpoint, before any reservation", async () => {
    const f = await setup("PQB");
    for (const body of [{ ...f.manifest, outputValue: "99001" }, { ...f.manifest, helper: f.manifest.funding,
      outputValue: "199000" }]) {
      const before = structuredClone([...f.store.rows]);
      const response = await f.post(body);
      expect(response.status).toBe(400);
      expect([...f.store.rows]).toEqual(before);
    }
    expect(f.unspent).not.toHaveBeenCalled();
  });

  it("refuses a Config A withdrawal without a helper, writing nothing", async () => {
    const f = await setup("A");
    const before = structuredClone([...f.store.rows]);
    const response = await f.post(f.manifest);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "withdrawal_invalid",
      error: "A Config A withdrawal needs a helper input." });
    expect([...f.store.rows]).toEqual(before);
    expect(f.unspent).not.toHaveBeenCalled();
    expect(f.workflow).not.toHaveBeenCalled();
  });
});

describe("SDK one-input withdrawal", () => {
  beforeEach(() => vi.stubEnv("SOLVER_RELEASE_ID", pqbFixture.id));

  it("creates, prepares, assembles and submits a PQB withdrawal whose custody returns the complete transaction", async () => {
    // Hermetic chain/miner and public planner double: not a real GPU solve or mainnet spend.
    const w = world(), owner = wallet(w.chain), manager = await managedProviders(w, owner);
    const requests: Parameters<typeof manager.providers.custody.authorizeWithdrawal>[0][] = [];
    const custody = { ...manager.providers.custody, authorizeWithdrawal: async (request: typeof requests[0]) => {
      requests.push(structuredClone(request));
      return manager.providers.custody.authorizeWithdrawal(request);
    } };
    const client = new QsbClient({ baseUrl: "http://127.0.0.1:8787", fetch: w.fetch, ...manager.providers, custody });
    const { vault } = await client.vaults.create({ name: "device", descriptor: await manager.generate("PQB") });
    const prepared = await client.deposits.prepare(vault.id, { amount: 200000n, feeRate: "2",
      utxos: [{ txid: owner.fundingTxid, vout: 0 }] });
    const deposit = await client.deposits.submit(prepared,
      await manager.signer.signPsbt(owner.address, prepared.psbt, prepared.signInputs), { costAccepted: true });
    w.chain.mine(deposit.txid);
    const destination = btc.p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(5), true)).address!;
    const { job } = await client.withdrawals.create({ vaultId: vault.id, destination, feeRate: "3", costAccepted: true });
    expect(job.manifest).not.toHaveProperty("helper");
    const script = hex.decode(job.manifest.outputScript);
    expect(BigInt(job.manifest.fee)).toBe((BigInt(withdrawalVsize(null, script.length, PQB_MAX_SCRIPTSIG)) * 3000n + 999n) / 1000n);
    expect(BigInt(job.manifest.outputValue) + BigInt(job.manifest.fee)).toBe(200000n);
    await solve(w.store, owner.address, job.id);
    const row = (await w.store.get(`OWNER#${owner.address}`, `JOB#${job.id}`))!;
    const stored = row.job as Job;
    await w.store.put({ ...row, version: row.version + 1, job: { ...stored, solution: {
      ...stored.solution!, round1: [0, 1, 2, 3, 4, 5, 6, 7], round2: [8, 9, 10, 11, 12, 13, 14, 15, 16],
      pqb: { pinning: "2147483648 500000000 3 0 0 1", round0: "0,1,2,3,4,5,6,7 5 1 0 1",
        round1: "0,1,2,3,4,5,6,7,8 9 2 0 1" } } } }, row.version);

    const request = await client.withdrawals.prepare(job.id);
    expect(request).not.toHaveProperty("helperPreviousTxHex");
    expect(request).not.toHaveProperty("helperAddress");
    expect(request.pqbStart).toEqual({ sequence: 2147483648, locktime: 500000000, round0: [0, 1, 2, 3, 4, 5, 6, 7],
      round1: [8, 9, 10, 11, 12, 13, 14, 15, 16], picks: [3, 5, 9] });
    expect(btc.Transaction.fromRaw(hex.decode(request.transaction), { allowUnknownInputs: true,
      allowUnknownOutputs: true }).inputsLength).toBe(1);

    const signed = await client.withdrawals.assemble(job.id);
    expect(requests).toHaveLength(1);
    expect(signed).not.toHaveProperty("helperSighash");
    expect(coordinatorSignedResultSchema.parse(signed)).toEqual(signed);
    const tx = btc.Transaction.fromRaw(hex.decode(signed.rawTxHex), { allowUnknownInputs: true, allowUnknownOutputs: true });
    expect(tx.inputsLength).toBe(1);
    expect(tx.id).toBe(signed.txid);
    // An imported file that claims a helper signature, or carries other bytes, is refused before any submit.
    const approve = async (review: { txid: string }) => review.txid;
    const submissions = w.minerSubmissions.length;
    await expect(client.withdrawals.submit({ ...signed, helperSighash: "SIGHASH_ALL", helperSignatureVerified: true },
      { approve })).rejects.toThrow("externally bound assembly");
    expect(w.minerSubmissions).toHaveLength(submissions);
    const result = await client.withdrawals.submit(signed, { approve });
    expect(result).toEqual({ txid: signed.txid, status: "submitted" });
    expect(w.minerSubmissions).toHaveLength(submissions + 1);
    expect(w.consensus.verified).toContain(signed.rawTxHex);
  }, 60000);

  it("still requires a helper for a Config A vault", async () => {
    vi.stubEnv("SOLVER_RELEASE_ID", servedFixture.id);
    const w = world(), owner = wallet(w.chain), manager = await managedProviders(w, owner);
    const client = new QsbClient({ baseUrl: "http://127.0.0.1:8787", fetch: w.fetch, ...manager.providers });
    const { vault } = await client.vaults.create({ name: "config a", descriptor: await manager.generate("A") });
    const prepared = await client.deposits.prepare(vault.id, { amount: 200000n, feeRate: "2",
      utxos: [{ txid: owner.fundingTxid, vout: 0 }] });
    w.chain.mine((await client.deposits.submit(prepared,
      await manager.signer.signPsbt(owner.address, prepared.psbt, prepared.signInputs), { costAccepted: true })).txid);
    await expect(client.withdrawals.create({ vaultId: vault.id, destination: owner.address, feeRate: "3",
      costAccepted: true })).rejects.toThrow("Choose a helper output");
  }, 60000);
});
