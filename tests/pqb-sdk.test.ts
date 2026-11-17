import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/lib/releases/registry.generated", async () => {
  const { servedFixture, pqbFixture } = await import("./solver-fixture");
  return { default: [servedFixture, pqbFixture] };
});
import { pqbFixture, servedFixture } from "./solver-fixture";
import { API, managedProviders, wallet, world } from "./sdk-fixture";
import { QsbClient } from "../sdk/client";
import { assertSolverPin } from "../src/lib/provenance";
import { publicRuntime } from "../sdk/public-runtime";
beforeEach(() => {
  vi.stubEnv("SOLVER_RELEASE_ID", pqbFixture.id);
  vi.stubGlobal("fetch", () => { throw new Error("Unexpected network request"); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("registers and funds a public PQB descriptor, then journals its pinned withdrawal without a seed", async () => {
  const w = world(), owner = wallet(w.chain), manager = await managedProviders(w, owner);
  const descriptor = await manager.generate("PQB");
  const seed = JSON.parse(manager.state.get(descriptor.scriptHash)!).seed as string;
  const client = new QsbClient({ baseUrl: API, fetch: w.fetch, ...manager.providers });
  const { vault } = await client.vaults.create({ name: "external PQB", descriptor });
  expect(vault.configuration.protocol).toBe("pqb-v1");
  await expect(client.vaults.create({ name: "duplicate", descriptor })).rejects.toThrow("reuses");
  const deposit = await client.deposits.prepare(vault.id, { amount: 200000n, feeRate: "2", utxos: [{ txid: owner.fundingTxid, vout: 0 }] });
  const signed = await manager.signer.signPsbt(owner.address, deposit.psbt, deposit.signInputs);
  const submitted = await client.deposits.submit(deposit, signed, { costAccepted: true });
  w.chain.mine(submitted.txid);
  await expect(client.deposits.prepare(vault.id, { amount: 1000n, feeRate: "2", utxos: [{ txid: owner.fundingTxid, vout: 1 }] })).rejects.toThrow("already has a deposit");
  const input = { vaultId: vault.id, destination: owner.address, helper: { txid: owner.fundingTxid, vout: 1 }, feeRate: "2", costAccepted: true as const };
  vi.stubEnv("SOLVER_RELEASE_ID", servedFixture.id);
  await expect(client.withdrawals.create(input)).rejects.toThrow("different vault protocol");
  expect(manager.rows.size).toBe(0);
  vi.stubEnv("SOLVER_RELEASE_ID", pqbFixture.id);
  const { job } = await client.withdrawals.create(input);
  expect(assertSolverPin(job.solver!, vault).id).toBe(pqbFixture.id);
  expect(manager.rows.get(`qsb-intent:mainnet:${vault.scriptHash}`)).toBe(JSON.stringify(job.manifest));
  for (const request of w.requests) {
    expect(request.body).not.toContain(seed); expect(request.body).not.toContain('"seed"');
    expect(request.body).not.toContain(manager.state.get(descriptor.scriptHash)!);
  }
  expect([...w.store.rows.values()].filter(r => r.pk.startsWith("OUTPOINT#"))).toHaveLength(2);
  const solution = { sequence: 2147483648, locktime: 500000000, round1: [0,1,2,3,4,5,6,7], round2: [8,9,10,11,12,13,14,15,16],
    pqb: { pinning: "2147483648 500000000 0 0 0 1", round0: "0,1,2,3,4,5,6,7 0 0 0 1", round1: "0,1,2,3,4,5,6,7,8 0 0 0 1" } };
  const row = (await w.store.get(`OWNER#${owner.address}`, `JOB#${job.id}`))!;
  await w.store.put({ ...row, version: row.version + 1, job: { ...job, status: "awaiting_authorization", stage: "verification", solution } }, row.version);
  const authorize = vi.spyOn(manager.providers.custody, "authorizeWithdrawal");
  await expect(client.withdrawals.assemble(job.id)).rejects.toThrow(/verification|predicate/);
  expect(authorize).not.toHaveBeenCalled();
}, 30000);

it("rejects private PQB public-state fields and mismatched scripts", async () => {
  const w = world(), owner = wallet(w.chain), manager = await managedProviders(w, owner);
  const descriptor = await manager.generate("PQB");
  const client = new QsbClient({ baseUrl: API, fetch: w.fetch, ...manager.providers });
  const state = JSON.parse(descriptor.publicStateJson);
  await expect(client.vaults.create({ name: "private", descriptor: { ...descriptor, publicStateJson: JSON.stringify({ ...state, seed: "ab".repeat(32) }) } })).rejects.toThrow();
  await expect(publicRuntime().validate({ ...descriptor, publicStateJson: JSON.stringify({ ...state, full_script_hex: "51" }) } as never)).rejects.toThrow("does not match");
});
