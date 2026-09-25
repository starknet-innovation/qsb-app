import { describe, expect, it, vi } from "vitest";
import { Signer } from "bip322-js";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { createApp } from "../server/app";
import { Esplora } from "../server/chain";
import { Slipstream } from "../server/providers";
import { MemoryStore } from "../server/store";
import type { Job, PublicVault, Withdrawal } from "../src/lib/model";

async function fixture(intent = true) {
  const key = new Uint8Array(32).fill(7);
  const payment = btc.p2wpkh(secp256k1.getPublicKey(key));
  const owner = payment.address!,
    pk = `OWNER#${owner}`;
  const original = "aa".repeat(32),
    included = "bb".repeat(32);
  const manifest: Withdrawal = {
    vaultId: "00000000-0000-4000-8000-000000000001",
    funding: { txid: "11".repeat(32), vout: 0, value: "50000" },
    helper: { txid: "22".repeat(32), vout: 1, value: "10000" },
    destination: owner,
    outputScript: hex.encode(payment.script),
    outputValue: "59000",
    fee: "1000",
    idempotencyKey: "00000000-0000-4000-8000-000000000002",
    costAccepted: true,
  };
  const job = {
    id: manifest.idempotencyKey,
    owner,
    vaultId: manifest.vaultId,
    status: "submitted",
    txid: original,
    manifest,
  } as Job;
  const vault = {
    id: manifest.vaultId,
    network: "mainnet",
    status: "confirmed",
  } as PublicVault;
  const store = new MemoryStore();
  await store.put({ pk, sk: `JOB#${job.id}`, version: 0, job });
  await store.put({ pk, sk: `VAULT#${vault.id}`, version: 0, vault });
  if (intent)
    await store.put({
      pk,
      sk: `TX#${original}`,
      version: 0,
      kind: "exact-withdrawal",
      jobId: job.id,
      manifest,
      txid: original,
      status: "submitted",
    });
  const chain = new Esplora();
  const inclusion = vi
    .spyOn(chain, "withdrawalInclusion")
    .mockResolvedValue({
      confirmed: true,
      confirmations: 3,
      txid: included,
      blockHeight: 100,
      blockHash: "cc".repeat(32),
      outpointMatched: true,
      outputMatched: true,
    });
  const txidStatus = vi
    .spyOn(chain, "status")
    .mockRejectedValue(new Error("Original txid absent"));
  const miner = new Slipstream();
  const minerStatus = vi
    .spyOn(miner, "status")
    .mockRejectedValue(new Error("Original txid absent"));
  const submit = vi.spyOn(miner, "submit");
  const app = createApp(store, { chain, miner });
  const challenge = await (
    await app.request("/api/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: owner }),
    })
  ).json();
  const signature = Signer.sign(
    btc.WIF().encode(key),
    owner,
    challenge.message,
  );
  const session = await (
    await app.request("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: challenge.id, signature }),
    })
  ).json();
  const get = (path: string) =>
    app.request(path, {
      headers: { authorization: `Bearer ${session.token}` },
    });
  return {
    store,
    pk,
    original,
    included,
    manifest,
    job,
    inclusion,
    txidStatus,
    minerStatus,
    submit,
    get,
  };
}
describe("outpoint-based withdrawal status routes", () => {
  it("confirms both routes using actual spender while preserving original intent and job txid", async () => {
    const f = await fixture();
    const tx = await f.get(`/api/transactions/${f.original}/status`);
    expect(tx.status).toBe(200);
    expect(await tx.json()).toMatchObject({
      txid: f.original,
      includedTxid: f.included,
      status: "confirmed",
      section7Inclusion: { independentlyConfirmed: true },
    });
    const job = await f.get(`/api/jobs/${f.job.id}/status`);
    expect(job.status).toBe(200);
    expect(await job.json()).toMatchObject({
      job: { txid: f.original, status: "confirmed" },
      includedTxid: f.included,
      status: { txid: f.included, confirmed: true },
    });
    expect(f.inclusion).toHaveBeenCalledTimes(2);
    expect(f.inclusion).toHaveBeenCalledWith(f.manifest);
    expect(f.txidStatus).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect((await f.store.get(f.pk, `JOB#${f.job.id}`))?.job).toMatchObject({
      txid: f.original,
    });
    expect(
      (await f.store.get(f.pk, `VAULT#${f.job.vaultId}`))?.vault,
    ).toMatchObject({ status: "spent" });
    expect(await f.store.get(f.pk, `TX#${f.included}`)).toBeUndefined();
  });
  it("requires an existing intent before either status route contacts providers", async () => {
    const f = await fixture(false);
    expect((await f.get(`/api/jobs/${f.job.id}/status`)).status).toBe(404);
    expect((await f.get(`/api/transactions/${f.original}/status`)).status).toBe(
      404,
    );
    expect(f.inclusion).not.toHaveBeenCalled();
    expect(f.txidStatus).not.toHaveBeenCalled();
    expect(f.minerStatus).not.toHaveBeenCalled();
  });
  it("does not mark an unconfirmed outpoint spender as a spent vault", async () => {
    const f = await fixture();
    f.inclusion.mockResolvedValue({
      confirmed: false,
      confirmations: 0,
      txid: f.included,
      outpointMatched: true,
      outputMatched: true,
    });
    const response = await f.get(`/api/jobs/${f.job.id}/status`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job.status).toBe("submitted");
    expect(body).not.toHaveProperty("includedTxid");
    expect(
      (await f.store.get(f.pk, `VAULT#${f.job.vaultId}`))?.vault,
    ).toMatchObject({ status: "confirmed" });
  });
});
