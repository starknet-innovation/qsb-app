import { it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { Signer } from "bip322-js";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { MemoryStore, type Store } from "../server/store";
import {
  MemoryStore as RuntimeMemoryStore,
  runtimeTransactItems,
} from "../supervised/runtime/source/outputs/qsb-vault/server/store";
import { rollbackCanonicalAcceptance } from "../server/runtime/storage-authority";
import { createSupervisedCreationApp } from "../supervised/dispatch/routes";
import { receiveOne } from "../supervised/dispatch/queue";
import { address, privateKey, publicKey } from "./supervised-fixture";
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
async function enrollQueued(
  store: Store,
  address: string,
  jobId: string,
  job: { execution: unknown },
) {
  const invocationId = hash(
    "OWNER#" +
      address +
      ":JOB#" +
      jobId +
      ":" +
      fingerprint(job.execution),
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
    jobHash: fingerprint(job),
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
  return ticket;
}
async function setup() {
  const ready = await prepared("generation");
  const { store, address, jobId } = ready;
  const created = await createExplicitJob(
    withCreationOutbox(store),
    address,
    ready.body,
    async () => {},
  );
  const ticket = await enrollQueued(store, address, jobId, created.job);
  return { store, ticket, address, jobId };
}
function queueClient(ticket: string) {
  return {
    async send(command: { constructor: { name: string } }) {
      if (command.constructor.name === "ReceiveMessageCommand")
        return {
          Messages: [{ Body: ticket, ReceiptHandle: "receipt-1" }],
        };
      return {};
    },
  };
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
it("creates, consumes, and claims through the Lambda route under writer exclusion", async () => {
  const posted = await postSupervised("generation");
  expect(posted.response.status).toBe(201);
  const stored = await posted.store.get(
    "OWNER#" + posted.address,
    "JOB#" + posted.jobId,
  );
  const job = stored?.job as {
    reservationAuthorityGeneration: number;
    execution: unknown;
    manifest: {
      funding: { txid: string; vout: number };
      helper: { txid: string; vout: number };
    };
  };
  const authority = await posted.store.get(AUTHORITY_PK, AUTHORITY_SK);
  expect(job.reservationAuthorityGeneration).toBe(authority?.generation);
  expect(
    await posted.store.get("SYSTEM#QSB_RESERVATIONS", "SCHEMA"),
  ).toBeUndefined();
  const ticket = await enrollQueued(
    posted.store,
    posted.address,
    posted.jobId,
    job,
  );
  let claims = 0;
  const consumed = await receiveOne(
    posted.store,
    async (request) => {
      claims += 1;
      const claimed = await claimHost(posted.store, request);
      expect(claimed.status).toBe("claimed");
      expect(claimed.requestHash).toBe(fingerprint(request));
      return {
        accepted: true as const,
        invocationId: request.invocationId,
        executionHash: request.executionHash,
      };
    },
    "https://sqs.example.invalid/supervised",
    queueClient(ticket) as never,
  );
  expect(claims).toBe(1);
  expect(consumed).toMatchObject({ state: "accepted" });
  expect(
    await posted.store.get(
      "OWNER#" + posted.address,
      "V5_HOST_LAUNCH#" + posted.jobId,
    ),
  ).toMatchObject({ status: "claimed" });
  for (const point of [job.manifest.funding, job.manifest.helper]) {
    const reservation = await posted.store.get(
      `OUTPOINT#${point.txid.toLowerCase()}:${point.vout}`,
      "RESERVATION",
    );
    expect(reservation?.authorityGeneration).toBe(
      job.reservationAuthorityGeneration,
    );
  }
});
it("refuses a generation change between Lambda create and host claim", async () => {
  const posted = await postSupervised("generation");
  expect(posted.response.status).toBe(201);
  const stored = await posted.store.get(
    "OWNER#" + posted.address,
    "JOB#" + posted.jobId,
  );
  const job = stored?.job as { execution: unknown };
  const ticket = await enrollQueued(
    posted.store,
    posted.address,
    posted.jobId,
    job,
  );
  const key = `${AUTHORITY_PK}|${AUTHORITY_SK}`;
  const memory = posted.store as MemoryStore;
  const authority = memory.rows.get(key);
  memory.rows.set(key, {
    ...authority!,
    generation: Number(authority!.generation) + 1,
  });
  let claims = 0;
  await expect(
    receiveOne(
      posted.store,
      async (request) => {
        claims += 1;
        await claimHost(posted.store, request);
        return {
          accepted: true as const,
          invocationId: request.invocationId,
          executionHash: request.executionHash,
        };
      },
      "https://sqs.example.invalid/supervised",
      queueClient(ticket) as never,
    ),
  ).rejects.toThrow(/Reservation authority changed/);
  expect(claims).toBe(0);
  expect(
    await posted.store.get(
      "OWNER#" + posted.address,
      "V5_HOST_LAUNCH#" + posted.jobId,
    ),
  ).toBeUndefined();
  expect(
    await posted.store.get(
      "OWNER#" + posted.address,
      "V5_ADMISSION#" + posted.jobId,
    ),
  ).toBeUndefined();
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
vi.mock(
  "../supervised/runtime/source/work/yukon-pin-adapter-20260923/adapter.ts",
  () => ({
    pinRange: () => {
      throw new Error("pin adapter is not used at work start");
    },
    pinRequest: () => {
      throw new Error("pin adapter is not used at work start");
    },
    pinResult: () => {
      throw new Error("pin adapter is not used at work start");
    },
  }),
);
const executionBoundaryModule =
  "../supervised/runtime/source/work/yukon-resource-session-locator-20260923/execution.ts";
function censusOf(
  runtime: RuntimeMemoryStore,
  record?: (writes: {
    row: { pk: string; sk: string; version: number };
    conditionOnly?: boolean;
    expected?: number;
  }[]) => void,
) {
  return {
    get: runtime.get.bind(runtime),
    put: runtime.put.bind(runtime),
    delete: runtime.delete.bind(runtime),
    list: runtime.list.bind(runtime),
    reservationRows: runtime.reservationRows.bind(runtime),
    all: (pk: string) => runtime.list(pk, ""),
    atomicPut: async (
      writes: {
        row: { pk: string; sk: string; version: number };
        conditionOnly?: boolean;
        expected?: number;
      }[],
    ) => {
      record?.(writes);
      await runtime.atomicPut(writes);
    },
  };
}
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
  expect(response.status).toBe(201);
  const stored = await runtime.get("OWNER#" + ready.address, "JOB#" + ready.jobId);
  const job = stored?.job as {
    execution: unknown;
    manifest: {
      funding: { txid: string; vout: number };
      helper: { txid: string; vout: number };
    };
  };
  const ticket = await enrollQueued(runtime, ready.address, ready.jobId, job);
  await receiveOne(
    runtime,
    async (request) => {
      await claimHost(runtime, request);
      return {
        accepted: true as const,
        invocationId: request.invocationId,
        executionHash: request.executionHash,
      };
    },
    "https://sqs.example.invalid/supervised",
    queueClient(ticket) as never,
  );
  const invocation = await runtime.get(
    "OWNER#" + ready.address,
    "V5_INVOCATION#" + ready.jobId,
  );
  return {
    runtime,
    address: ready.address,
    jobId: ready.jobId,
    job,
    request: JSON.parse(String(invocation?.request)),
    config: invocation?.runtimeConfig,
  };
}
it("starts supervisor work on the runtime store without rewriting the generation authority", async () => {
  const claimed = await claimedOnRuntime();
  const authorityBefore = await claimed.runtime.get(AUTHORITY_PK, AUTHORITY_SK);
  const reservationVersions = new Map<string, number>();
  for (const point of [claimed.job.manifest.funding, claimed.job.manifest.helper]) {
    const key = `OUTPOINT#${point.txid.toLowerCase()}:${point.vout}`;
    reservationVersions.set(
      key,
      (await claimed.runtime.get(key, "RESERVATION"))?.version ?? -1,
    );
  }
  const written: string[] = [];
  const set = claimed.runtime.rows.set.bind(claimed.runtime.rows);
  claimed.runtime.rows.set = (key, value) => {
    written.push(String(key));
    return set(key, value);
  };
  const batches: {
    row: { pk: string; sk: string; version: number };
    conditionOnly?: boolean;
    expected?: number;
  }[][] = [];
  const { executionBoundary } = await import(executionBoundaryModule);
  const boundary = await executionBoundary(
    censusOf(claimed.runtime, (writes) => {
      batches.push(writes);
    }),
    claimed.address,
    claimed.request,
    claimed.config,
  );
  written.length = 0;
  batches.length = 0;
  const invocationId = claimed.request.invocationId as string;
  await boundary.store.atomicPut([
    {
      row: {
        pk: "SUPERVISION#supervised-" + invocationId,
        sk: "OWNER",
        version: 1,
        status: "operating",
      },
    },
    {
      row: {
        pk: "VALIDATION#isolated-yukon-pin-" + invocationId,
        sk: "SCOPE",
        version: 1,
        phase: "bootstrap",
      },
    },
  ]);
  const workStart = batches[0] ?? [];
  const fenced = workStart.filter(
    (write) =>
      (write.row.pk === AUTHORITY_PK && write.row.sk === AUTHORITY_SK) ||
      (write.row.sk === "RESERVATION" && write.row.pk.startsWith("OUTPOINT#")),
  );
  expect(fenced).toHaveLength(3);
  const items = runtimeTransactItems("QsbYukonIsolatedSynthetic", workStart);
  for (const write of fenced) {
    const item = items[workStart.indexOf(write)];
    expect(write.conditionOnly).toBe(true);
    expect(item).toHaveProperty("ConditionCheck");
    expect(item).not.toHaveProperty("Put");
  }
  expect(written).not.toContain(`${AUTHORITY_PK}|${AUTHORITY_SK}`);
  for (const key of reservationVersions.keys())
    expect(written).not.toContain(`${key}|RESERVATION`);
  expect((await claimed.runtime.get(AUTHORITY_PK, AUTHORITY_SK))?.version).toBe(
    authorityBefore?.version,
  );
  for (const [key, version] of reservationVersions)
    expect((await claimed.runtime.get(key, "RESERVATION"))?.version).toBe(version);
  expect(
    (await claimed.runtime.get("OWNER#" + claimed.address, "JOB#" + claimed.jobId))?.job,
  ).toMatchObject({ status: "bootstrapping" });
});
it("refuses supervisor work start after the reservation generation changes", async () => {
  const claimed = await claimedOnRuntime();
  const key = `${AUTHORITY_PK}|${AUTHORITY_SK}`;
  const authority = claimed.runtime.rows.get(key);
  claimed.runtime.rows.set(key, {
    ...authority!,
    generation: Number(authority!.generation) + 1,
  });
  const { executionBoundary } = await import(executionBoundaryModule);
  await expect(
    executionBoundary(
      censusOf(claimed.runtime),
      claimed.address,
      claimed.request,
      claimed.config,
    ),
  ).rejects.toThrow(/Paused or changed admission/);
  expect(
    await claimed.runtime.get(
      "SUPERVISION#supervised-" + claimed.request.invocationId,
      "OWNER",
    ),
  ).toBeUndefined();
});
it("refuses supervisor work start after canonical acceptance is stopped", async () => {
  const claimed = await claimedOnRuntime();
  await rollbackCanonicalAcceptance(claimed.runtime);
  const { executionBoundary } = await import(executionBoundaryModule);
  await expect(
    executionBoundary(
      censusOf(claimed.runtime),
      claimed.address,
      claimed.request,
      claimed.config,
    ),
  ).rejects.toThrow(/Canonical reservation authority not enrolled/);
  expect(
    await claimed.runtime.get(
      "SUPERVISION#supervised-" + claimed.request.invocationId,
      "OWNER",
    ),
  ).toBeUndefined();
});
