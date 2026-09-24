import { it, expect } from "vitest";
import { createHash } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { MemoryStore } from "../server/store";
import { fingerprint, vaultConfiguration } from "../src/lib/provenance";
import {
  createExplicitJob,
  CAPABILITY,
  CONTRACT,
} from "../supervised/archive/entry";
import { supervisedProfileId } from "../supervised/archive/work/yukon-app-routing-20260923/routing";
import { enableInProcessWriterExclusion } from "../server/runtime/storage-authority";
import { AUTHORITY_PK, AUTHORITY_SK } from "../server/runtime/reservation-guard";
import { MANIFEST as PIN } from "../supervised/archive/work/yukon-pin-preflight-20260923/execution-gate";
import { MANIFEST as SUBSET } from "../supervised/archive/work/yukon-indexed-controller-20260923/execution-gate";
import {
  withCreationOutbox,
  publishPending,
  consumeTicket,
} from "../supervised/dispatch/bridge";
import { claimHost, HOST, DISTRIBUTION } from "../supervised/host/claim";
const hash = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");
/** Invented, unfunded public metadata. No private keys, real request files, chain or GPU execution. */
async function setup() {
  const store = new MemoryStore();
  const publicKey =
    "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  const address = btc.p2wpkh(hex.decode(publicKey)).address!;
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
  await enableInProcessWriterExclusion(store, "store-transaction-condition");
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
  const created = await createExplicitJob(
    withCreationOutbox(store),
    address,
    { manifest, request, execution: { releaseId: supervisedProfileId } },
    async () => {},
  );
  const invocationId = hash(
    "OWNER#" +
      address +
      ":JOB#" +
      jobId +
      ":" +
      fingerprint(created.job.execution),
  );
  const now = Date.now(),
    stage = (endpoint: string) => ({
      endpoint,
      parent: "isolated-yukon-pin-" + invocationId,
      owner: address,
      revision: 1,
      deadlineMs: now + 600000,
      submissionCutoffMs: now + 500000,
    });
  const config = {
    format: "qsb-common-operational-v1",
    blueprint: {
      format: "qsb-common-lifetime-v1",
      network: "mainnet",
      runId: "supervised-" + invocationId,
      pin: stage("syntheticpin"),
      subset: {
        ...stage("syntheticsubset"),
        scope: "isolated-yukon-subset-" + invocationId,
      },
    },
    pin: {
      id: "syntheticpin",
      createdAt: new Date(now).toISOString(),
      image: "UNENROLLED_REGISTRY/qsb-vault-worker@" + PIN,
      socket: "/tmp/synthetic-pin.sock",
    },
    subset: {
      id: "syntheticsubset",
      createdAt: new Date(now).toISOString(),
      image: "UNENROLLED_REGISTRY/qsb-vault-worker@" + SUBSET,
      socket: "/tmp/synthetic-subset.sock",
    },
  };
  await store.put({
    pk: "OWNER#" + address,
    sk: "DISPATCH_CONFIG#" + jobId,
    version: 1,
    enabled: true,
    jobHash: fingerprint(created.job),
    config,
  });
  await store.put({
    ...HOST,
    version: 1,
    enabled: true,
    format: "qsb-fixed-linux-host-v1",
    distributionHash: DISTRIBUTION,
    region: "eu-west-1",
    table: "QsbYukonIsolatedSynthetic",
    maxLifetimeMs: 600000,
    maxActions: 10,
    pollIntervalMs: 1000,
  });
  let ticket = "";
  await publishPending(store, async (t) => {
    ticket = JSON.stringify(t);
  });
  return { store, ticket, address, jobId };
}
it("composes actual creation, outbox, dispatch, admission and host claim; duplicate delivery never launches twice", async () => {
  const f = await setup();
  let calls = 0;
  const launch = async (r: any) => {
    calls++;
    const c = await claimHost(f.store, r);
    expect(c.requestHash).toBe(fingerprint(r));
    return {
      accepted: true as const,
      invocationId: r.invocationId,
      executionHash: r.executionHash,
    };
  };
  const results = await Promise.allSettled([
    consumeTicket(f.store, f.ticket, launch),
    consumeTicket(f.store, f.ticket, launch),
  ]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  expect(calls).toBe(1);
  expect((await consumeTicket(f.store, f.ticket, launch)).state).toBe(
    "reconcile_existing",
  );
  expect(calls).toBe(1);
  expect(
    (await f.store.get("OWNER#" + f.address, "JOB#" + f.jobId))?.job,
  ).toMatchObject({ status: "starting" });
});
it("lost host acknowledgement survives new consumer without a second launch", async () => {
  const f = await setup();
  let calls = 0;
  await expect(
    consumeTicket(f.store, f.ticket, async (r) => {
      calls++;
      await claimHost(f.store, r);
      throw Error("simulated lost acknowledgement");
    }),
  ).rejects.toThrow("unknown");
  await consumeTicket(f.store, f.ticket, async () => {
    calls++;
    throw Error("must not run");
  });
  expect(calls).toBe(1);
  expect(
    (await f.store.get("OWNER#" + f.address, "V5_INVOCATION#" + f.jobId))
      ?.status,
  ).toBe("unknown");
});
it("revoked capability before consumption stops host launch", async () => {
  const f = await setup();
  await f.store.put(
    { ...CAPABILITY, version: 2, enabled: false, contract: CONTRACT },
    1,
  );
  let calls = 0;
  await expect(
    consumeTicket(f.store, f.ticket, async () => {
      calls++;
      throw Error();
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
it("configuration mutation racing invocation transaction prevents launch", async () => {
  const f = await setup(),
    atomic = f.store.atomicPut.bind(f.store);
  f.store.atomicPut = async (writes) => {
    if (writes.some((w) => w.row.sk.startsWith("V5_INVOCATION#"))) {
      const e = (await f.store.get(
        "OWNER#" + f.address,
        "DISPATCH_CONFIG#" + f.jobId,
      ))!;
      await f.store.put({ ...e, version: 2, enabled: false }, 1);
    }
    return atomic(writes);
  };
  let calls = 0;
  await expect(
    consumeTicket(f.store, f.ticket, async () => {
      calls++;
      throw Error();
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
it("enables writer exclusion, then creates, consumes, and claims under the generation authority", async () => {
  const f = await setup();
  const authority = await f.store.get(AUTHORITY_PK, AUTHORITY_SK);
  expect(authority).toMatchObject({
    legacyExcluded: true,
    canonicalAccepting: true,
  });
  expect(await f.store.get("SYSTEM#QSB_RESERVATIONS", "SCHEMA")).toBeUndefined();
  const stored = await f.store.get("OWNER#" + f.address, "JOB#" + f.jobId);
  const job = stored?.job as {
    reservationAuthorityGeneration: number;
    manifest: {
      funding: { txid: string; vout: number };
      helper: { txid: string; vout: number };
    };
  };
  expect(job.reservationAuthorityGeneration).toBe(authority?.generation);
  for (const point of [job.manifest.funding, job.manifest.helper]) {
    const reservation = await f.store.get(
      `OUTPOINT#${point.txid.toLowerCase()}:${point.vout}`,
      "RESERVATION",
    );
    expect(reservation?.authorityGeneration).toBe(authority?.generation);
    expect(reservation?.pk).toBe(
      `OUTPOINT#${point.txid.toLowerCase()}:${point.vout}`,
    );
  }
  const consumed = await consumeTicket(f.store, f.ticket, async (request) => {
    const claimed = await claimHost(f.store, request);
    expect(claimed.requestHash).toBe(fingerprint(request));
    return {
      accepted: true as const,
      invocationId: request.invocationId,
      executionHash: request.executionHash,
    };
  });
  expect(consumed.state).toBe("accepted");
  expect(
    await f.store.get("OWNER#" + f.address, "V5_HOST_LAUNCH#" + f.jobId),
  ).toMatchObject({ status: "claimed" });
});
