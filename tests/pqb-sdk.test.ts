import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/lib/releases/registry.generated", async () => {
  const { servedFixture, pqbFixture } = await import("./solver-fixture");
  return { default: [servedFixture, pqbFixture] };
});
import { pqbFixture, servedFixture } from "./solver-fixture";
import { API, wallet, world } from "./sdk-fixture";
import { QsbClient } from "../sdk/client";
import { loopbackTestSigner } from "../sdk/test-signer";
import { decryptRecovery } from "../src/lib/backup";
import { assertSolverPin } from "../src/lib/provenance";

beforeEach(() => {
  vi.stubEnv("SOLVER_RELEASE_ID", pqbFixture.id);
  vi.stubGlobal("fetch", () => { throw new Error("Unexpected network request"); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("creates, restores, funds and requests a PQB withdrawal through the real SDK/API with no secret upload", async () => {
  // Hermetic chain and miner transports; this is not a GPU solve or a consensus/inclusion test.
  const w = world(), owner = wallet(w.chain), signer = loopbackTestSigner(owner.wif, API);
  const client = new QsbClient({ baseUrl: API, signer, fetch: w.fetch });
  await client.login();
  const passphrase = "public disposable PQB SDK passphrase", backups: string[] = [];
  const saveBackup = async (text: string) => void backups.push(text);
  const { vault, backup } = await client.vaults.create({ name: "PQB SDK fixture", config: "PQB", passphrase, saveBackup });
  const restored = await decryptRecovery(backup, passphrase);
  const seed = JSON.parse(restored.stateJson).seed as string;
  expect(seed).toHaveLength(64); expect(vault.config).toBe("PQB");
  expect(vault.configuration.protocol).toBe("pqb-v1");
  await expect(client.vaults.create({ name: "duplicate", config: "PQB", passphrase, saveBackup,
    stateJson: restored.stateJson })).rejects.toThrow("reuses");
  const deposit = await client.deposits.prepare(vault.id, { backup, passphrase, amount: 200000n,
    feeRate: "2", utxos: [{ txid: owner.fundingTxid, vout: 0 }] });
  const signed = await signer.signPsbt(signer.address, deposit.psbt, deposit.signInputs);
  const submitted = await client.deposits.submit(deposit, signed, { costAccepted: true });
  w.chain.mine(submitted.txid);
  await expect(client.deposits.prepare(vault.id, { backup, passphrase, amount: 1000n,
    feeRate: "2", utxos: [{ txid: owner.fundingTxid, vout: 1 }] })).rejects.toThrow("already has a deposit");
  vi.stubEnv("SOLVER_RELEASE_ID", servedFixture.id);
  const before = backups.length;
  await expect(client.withdrawals.create({ vaultId: vault.id, backup, passphrase, destination: owner.address,
    helper: { txid: owner.fundingTxid, vout: 1 }, feeRate: "2", costAccepted: true, saveBackup })).rejects.toThrow("different vault protocol");
  expect(backups).toHaveLength(before);
  expect(w.requests.filter(r => r.url.endsWith("/jobs") && r.method === "POST")).toHaveLength(0);
  vi.stubEnv("SOLVER_RELEASE_ID", pqbFixture.id);
  const { job } = await client.withdrawals.create({ vaultId: vault.id, backup, passphrase, destination: owner.address,
    helper: { txid: owner.fundingTxid, vout: 1 }, feeRate: "2", costAccepted: true, saveBackup });
  expect(assertSolverPin(job.solver!, vault).id).toBe(pqbFixture.id);
  const reservations = [...w.store.rows.values()].filter(r => r.pk.startsWith("OUTPOINT#"));
  expect(reservations).toHaveLength(2);
  for (const r of w.requests) {
    expect(r.body).not.toContain(seed); expect(r.body).not.toContain(passphrase);
    expect(r.body).not.toContain('"seed"'); expect(r.body).not.toContain(restored.stateJson);
  }
}, 30000);
