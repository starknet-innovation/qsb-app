import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import { Signer } from "bip322-js";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { MemoryStore, type Store } from "../server/store";
import { MemoryStore as RuntimeMemoryStore } from "../supervised/runtime/source/outputs/qsb-vault/server/store";
import { createSupervisedCreationApp } from "../supervised/dispatch/routes";
import { address, privateKey, publicKey } from "./supervised-fixture";
import { vaultConfiguration } from "../src/lib/provenance";
import {
  historicalCudaProgram,
  WATCHED_YUKON_SUBSET,
  watchedYukonSubsetProgram,
} from "../src/lib/cuda-program";
import {
  createExplicitJob,
  CAPABILITY,
  CONTRACT,
} from "../supervised/archive/entry";
import { supervisedProfileId } from "../supervised/archive/work/yukon-app-routing-20260923/routing";
import { enableInProcessWriterExclusion } from "../server/runtime/storage-authority";
import { withCreationOutbox } from "../supervised/dispatch/bridge";
const hash = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");
/** Invented, unfunded public metadata. No private keys, real request files, chain or GPU execution. */
async function prepared(authority: "generation" | "schema", store: Store = new MemoryStore()) {
  const id = "10000000-0000-4000-8000-000000000001",
    jobId = "10000000-0000-4000-8000-000000000002";
  const point = (c: string) => ({
    txid: c.repeat(64),
    vout: 0,
    value: "10000",
  });
  const state = {
    config: "A",
    hash_mode: "sha256",
    n: 150,
    t1s: 8,
    t1b: 1,
    t2s: 7,
    t2b: 2,
    hors_commitments: [
      Array(150).fill("11".repeat(20)),
      Array(150).fill("22".repeat(20)),
    ],
    dummy_sigs: [Array(150).fill("30"), Array(150).fill("30")],
    pin_r: 1,
    pin_s: 1,
    pin_sig: "30",
    round_sigs: [
      { r: 1, s: 1, sig: "30" },
      { r: 1, s: 1, sig: "30" },
    ],
    full_script_hex: "51",
  };
  const vault: any = {
    id,
    name: "Synthetic metadata only",
    createdAt: "2026-01-01T00:00:00.000Z",
    network: "mainnet",
    config: "A",
    scriptHex: "51",
    scriptHash: hash(hex.decode("51")),
    paymentAddress: address,
    publicStateJson: JSON.stringify(state),
    funding: point("1"),
    status: "confirmed",
    cudaProgram: historicalCudaProgram(),
  };
  vault.configuration = vaultConfiguration(vault);
  const manifest = {
    vaultId: id,
    funding: point("1"),
    helper: point("2"),
    destination: address,
    outputScript: hex.encode(btc.p2wpkh(hex.decode(publicKey)).script),
    outputValue: "19000",
    fee: "1000",
    idempotencyKey: jobId,
    costAccepted: true,
  };
  const request = {
    format: "qsb-mainnet-search-request-v1",
    network: "mainnet",
    genesisHash:
      "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
    id,
    vault,
    wallet: { address, publicKey, type: "p2wpkh" },
    manifest,
  };
  if (authority === "generation")
    await enableInProcessWriterExclusion(store, "store-transaction-condition");
  else
    await store.put({
      pk: "SYSTEM#QSB_RESERVATIONS",
      sk: "SCHEMA",
      version: 1,
      format: "qsb-canonical-reservations-v1",
      state: "active",
      writerPolicy: "canonical-only",
      legacyWritersStopped: true,
      migrationComplete: true,
      generation: 1,
      legacyInventoryHash: "ab".repeat(32),
      canonicalInventoryHash: "cd".repeat(32),
    });
  await store.put({
    ...CAPABILITY,
    version: 1,
    enabled: true,
    contract: CONTRACT,
  });
  await store.put({
    pk: "OWNER#" + address,
    sk: "VAULT#" + id,
    version: 0,
    vault,
  });
  return {
    store,
    address,
    jobId,
    body: { manifest, request, execution: { releaseId: supervisedProfileId } },
  };
}
const confirmingLedger = {
  assertNetwork: async () => undefined,
  unspent: async () => ({ previousTxHex: "00", confirmations: 1 }),
};
async function login(
  app: ReturnType<typeof createSupervisedCreationApp>,
  wallet: string,
) {
  const challenge = await (
    await app.request("/api/auth/challenge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: wallet }),
    })
  ).json();
  const signature = Signer.sign(
    btc.WIF().encode(privateKey),
    wallet,
    challenge.message,
  );
  const verified = await app.request("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: challenge.id, signature }),
  });
  expect(verified.status).toBe(200);
  return (await verified.json()).token as string;
}
it("does not create a supervised subset job for a historical deposit", async () => {
  const ready = await prepared("generation");
  await expect(
    createExplicitJob(
      withCreationOutbox(ready.store),
      ready.address,
      ready.body,
      async () => {},
    ),
  ).rejects.toThrow("CudaProgramNotEnrolled");
  expect(
    await ready.store.get("OWNER#" + ready.address, "JOB#" + ready.jobId),
  ).toBeUndefined();
  expect(
    JSON.stringify([...(ready.store as MemoryStore).rows.values()]),
  ).not.toContain(WATCHED_YUKON_SUBSET.supervisedProfileId);
  const stored = await ready.store.get(
    "OWNER#" + ready.address,
    "VAULT#" + ready.body.manifest.vaultId,
  );
  if (!stored || typeof stored.vault !== "object" || stored.vault === null)
    throw new Error("Vault row missing");
  const subsetVault = {
    ...(stored.vault as Record<string, unknown>),
    cudaProgram: watchedYukonSubsetProgram(),
  };
  await ready.store.put({ ...stored!, vault: subsetVault, version: 1 }, 0);
  await expect(
    createExplicitJob(
      withCreationOutbox(ready.store),
      ready.address,
      {
        ...ready.body,
        request: { ...ready.body.request, vault: subsetVault },
      },
      async () => {},
    ),
  ).rejects.toThrow("DepositCudaProgramMismatch");
  expect(
    await ready.store.get("OWNER#" + ready.address, "JOB#" + ready.jobId),
  ).toBeUndefined();
});

async function postSupervised(authority: "generation" | "schema") {
  const ready = await prepared(authority);
  const app = createSupervisedCreationApp(ready.store, {
    enabled: true,
    chain: confirmingLedger,
  });
  const token = await login(app, ready.address);
  const response = await app.request("/api/jobs/supervised", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(ready.body),
  });
  return { ...ready, response };
}
it("refuses the supervised route for a historical deposit", async () => {
  const posted = await postSupervised("generation");
  expect(posted.response.status).toBe(409);
  expect(await posted.response.json()).toEqual({
    error: "Supervised request unavailable or changed.",
  });
  expect(
    await posted.store.get("OWNER#" + posted.address, "JOB#" + posted.jobId),
  ).toBeUndefined();
  expect(JSON.stringify([...(posted.store as MemoryStore).rows.values()])).not.toContain(
    WATCHED_YUKON_SUBSET.supervisedProfileId,
  );
});
it("admits nothing when only a SCHEMA reservation row is enrolled", async () => {
  const posted = await postSupervised("schema");
  expect(posted.response.status).toBe(409);
  expect(await posted.response.json()).toEqual({
    error: "Supervised request unavailable or changed.",
  });
  expect(
    await posted.store.get("OWNER#" + posted.address, "JOB#" + posted.jobId),
  ).toBeUndefined();
  expect(
    await posted.store.get("OUTPOINT#" + "1".repeat(64) + ":0", "RESERVATION"),
  ).toBeUndefined();
  expect(
    await posted.store.get("OUTPOINT#" + "2".repeat(64) + ":0", "RESERVATION"),
  ).toBeUndefined();
  expect(
    await posted.store.get(
      "OWNER#" + posted.address,
      "V5_ADMISSION#" + posted.jobId,
    ),
  ).toBeUndefined();
});
async function claimedOnRuntime() {
  const runtime = new RuntimeMemoryStore();
  const ready = await prepared("generation", runtime);
  const app = createSupervisedCreationApp(ready.store, {
    enabled: true,
    chain: confirmingLedger,
  });
  const token = await login(app, ready.address);
  const response = await app.request("/api/jobs/supervised", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(ready.body),
  });
  expect(response.status).toBe(409);
  expect(
    await runtime.get("OWNER#" + ready.address, "JOB#" + ready.jobId),
  ).toBeUndefined();
  expect(JSON.stringify([...runtime.rows.values()])).not.toContain(
    WATCHED_YUKON_SUBSET.supervisedProfileId,
  );
  return { runtime, address: ready.address, jobId: ready.jobId };
}

it("does not start supervisor work for a historical deposit", async () => {
  const claimed = await claimedOnRuntime();
  expect(
    await claimed.runtime.get("OWNER#" + claimed.address, "JOB#" + claimed.jobId),
  ).toBeUndefined();
});
