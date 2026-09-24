import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Signer } from "bip322-js";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { createSupervisedCreationApp } from "../supervised/dispatch/routes";
import { Conflict, MemoryStore, type Store } from "../server/store";
import contract from "../server/mainnet-capability.json";
import { release } from "../src/lib/model";
import { fingerprint } from "../src/lib/provenance";
import { currentAdmissionClient } from "../src/mainnet/admissionClient";
import { bindSolvedConsumer } from "../src/mainnet/consumer";
import {
  MAINNET_SEARCH_PROFILE,
  prepareMainnetSearchRequest,
  retainedMainnetSubmission,
} from "../src/mainnet/submission";
import { retainedRequests } from "../src/mainnet/retainedRequest";
import { validateRequest } from "../src/mainnet/solvedContract";
import { assertServiceChain } from "../server/runtime/capability";
import { CONTRACT as archiveContract } from "../supervised/archive/work/yukon-mainnet-service-enrollment-20260923/capability";
import { runEnrolledCpuVerifier } from "../server/runtime/cpu-verifier";
import { admitSupervisedJob, claimAdmittedLaunch } from "../server/runtime/dispatcher";
import {
  acknowledgementExpired,
  acknowledgementLine,
  drainSibling,
  launchOwnedProcess,
  localAckStarter,
  openSiblingSlot,
  publishSimulatedVerifiedHit,
  recordLateProviderId,
  replaceOwnedProcess,
  submitProviderOnce,
  type OwnedProcessStart,
} from "../server/runtime/host-bridge";
import {
  componentIdentities,
  writePackageTree,
} from "../server/runtime/package-release";
import { isSearchRunning } from "../server/runtime/types";
import { readAdmittedSolvedBundle } from "../server/runtime/evidence-reader";
import {
  address,
  privateKey,
  publicKey,
  simulatedFacts,
  simulatedMainnetRequest,
} from "./supervised-fixture";

const confirmingLedger = {
  assertNetwork: async () => undefined,
  unspent: async () => ({ previousTxHex: "00", confirmations: 1 }),
};

function handoffApp(store: MemoryStore) {
  return createApp(store, {
    inProcessHandoff: true,
    fundingLedger: confirmingLedger,
  });
}

const request = (path: string, body?: unknown, token?: string) =>
  new Request(`http://localhost/api${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

async function login(
  app: ReturnType<typeof createApp>,
  key = privateKey,
  wallet = address,
) {
  const challenge = await (
    await app.request(request("/auth/challenge", { address: wallet }))
  ).json();
  const signature = Signer.sign(btc.WIF().encode(key), wallet, challenge.message);
  const response = await app.request(
    request("/auth/verify", { id: challenge.id, signature }),
  );
  expect(response.status).toBe(200);
  return (await response.json()).token as string;
}

async function seedCapability(store: MemoryStore) {
  await store.put({
    pk: "SYSTEM#QSB_MAINNET_SERVICE",
    sk: "CAPABILITY",
    version: 1,
    enabled: true,
    contract,
  });
}

function memoryRetention() {
  const rows = new Map<string, string>();
  return retainedRequests(
    {
      getItem: (key) => rows.get(key) ?? null,
      setItem: (key, value) => {
        rows.set(key, value);
      },
    },
    {
      request: async (
        _name: string,
        optionsOrCallback: unknown,
        maybeCallback?: () => unknown,
      ) => {
        const callback =
          typeof optionsOrCallback === "function"
            ? optionsOrCallback
            : maybeCallback;
        return callback?.();
      },
    } as Pick<LockManager, "request">,
  );
}

describe("supervised runtime handoff", () => {
  it("keeps the three capability contracts equal", async () => {
    const declared = (source: string) => {
      const match = source.match(
        /export const CONTRACT=\{format:'([^']+)',network:'([^']+)',coreSourceManifest:'([a-f0-9]{64})',cpuCallback:'([a-f0-9]{64})',profileHash:fingerprint\(supervisedProfile\(\)\),providerGpuLimit:(\d+),broadcastAuthorized:(true|false)\} as const;/,
      );
      if (!match) throw new Error("CapabilityContractUnparsed");
      return {
        format: match[1],
        network: match[2],
        coreSourceManifest: match[3],
        cpuCallback: match[4],
        providerGpuLimit: Number(match[5]),
        broadcastAuthorized: match[6] === "true",
      };
    };
    const archiveDeclared = declared(
      readFileSync(
        "supervised/archive/work/yukon-mainnet-service-enrollment-20260923/capability.ts",
        "utf8",
      ),
    );
    const runtimeDeclared = declared(
      readFileSync(
        "supervised/runtime/source/work/yukon-mainnet-service-enrollment-20260923/capability.ts",
        "utf8",
      ),
    );
    const runtimeRouting = (await import(
      [
        "..",
        "supervised",
        "runtime",
        "source",
        "work",
        "yukon-app-routing-20260923",
        "routing.ts",
      ].join("/")
    )) as { supervisedProfile: () => unknown };
    const runtimeProvenance = (await import(
      [
        "..",
        "supervised",
        "runtime",
        "source",
        "outputs",
        "qsb-vault",
        "src",
        "lib",
        "provenance.ts",
      ].join("/")
    )) as { fingerprint: (value: unknown) => string };
    const runtimeContract = {
      ...runtimeDeclared,
      profileHash: runtimeProvenance.fingerprint(runtimeRouting.supervisedProfile()),
    };
    expect(release.mainnetEnabled).toBe(false);
    expect(archiveDeclared).toEqual(runtimeDeclared);
    expect(archiveContract).toEqual({
      ...archiveDeclared,
      profileHash: contract.profileHash,
    });
    expect(archiveContract).toEqual(contract);
    expect(runtimeContract).toEqual(contract);
    expect(contract.broadcastAuthorized).toBe(false);
  });

  it("keeps in-process admission off the default app and behind the dispatcher", async () => {
    const store = new MemoryStore();
    await seedCapability(store);
    const closed = simulatedMainnetRequest();
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${closed.vault.id}`,
      version: 0,
      vault: closed.vault,
    });
    const plain = createApp(store);
    const token = await login(plain);
    expect(
      (await plain.request(request("/jobs/supervised", closed.prepared.body, token)))
        .status,
    ).toBe(404);
    const dispatched = createSupervisedCreationApp(store);
    const dispatchedToken = await login(dispatched);
    const refused = await dispatched.request(
      request("/jobs/supervised", closed.prepared.body, dispatchedToken),
    );
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: "Supervised job creation is disabled.",
    });
  });

  it("returns the existing job when a concurrent create loses the write", async () => {
    const store = new MemoryStore();
    await seedCapability(store);
    const closed = simulatedMainnetRequest();
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${closed.vault.id}`,
      version: 0,
      vault: closed.vault,
    });
    let conflicted = false;
    const racing = {
      get: store.get.bind(store),
      list: store.list.bind(store),
      put: store.put.bind(store),
      delete: store.delete.bind(store),
      atomicPut: async (writes: Parameters<Store["atomicPut"]>[0]) => {
        await store.atomicPut(writes);
        if (!conflicted) {
          conflicted = true;
          throw new Conflict("concurrent");
        }
      },
    } satisfies Store;
    const admitted = await admitSupervisedJob(
      racing,
      address,
      "mainnet",
      closed.prepared.body,
      confirmingLedger,
    );
    expect(admitted.created).toBe(false);
    expect(admitted.job.id).toBe(closed.prepared.request.manifest.idempotencyKey);
    expect(
      [...store.rows.values()].filter((row) => String(row.sk).startsWith("JOB#")),
    ).toHaveLength(1);
  });

  it("does not queue a job after the capability row is revoked", async () => {
    const inner = new MemoryStore();
    await seedCapability(inner);
    const fixture = simulatedMainnetRequest();
    await inner.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    let revoked = false;
    const store: Store = {
      get: (pk, sk) => inner.get(pk, sk),
      put: (row, expected) => inner.put(row, expected),
      delete: (pk, sk, expected) => inner.delete(pk, sk, expected),
      list: (pk, prefix) => inner.list(pk, prefix),
      atomicPut: async (writes) => {
        const creating = writes.some((write) =>
          String(write.row.sk).startsWith("JOB#"),
        );
        if (creating && !revoked) {
          revoked = true;
          const row = await inner.get("SYSTEM#QSB_MAINNET_SERVICE", "CAPABILITY");
          await inner.put(
            { ...row!, version: row!.version + 1, enabled: false },
            row!.version,
          );
        }
        await inner.atomicPut(writes);
      },
    };
    await expect(
      admitSupervisedJob(store, address, "mainnet", fixture.prepared.body, confirmingLedger),
    ).rejects.toThrow(/Supervised search capability is not active/);
    expect(
      [...inner.rows.values()].filter(
        (row) =>
          String(row.sk).startsWith("JOB#") || String(row.pk).startsWith("OUTPOINT#"),
      ),
    ).toHaveLength(0);
  });

  it("keeps the default service closed and rejects the final composition guards", async () => {
    expect(release.mainnetEnabled).toBe(false);
    expect(contract.broadcastAuthorized).toBe(false);
    expect(() => assertServiceChain("testnet4")).toThrow(/not Bitcoin mainnet/);
    const store = new MemoryStore();
    const app = handoffApp(store);
    const config = await (await app.request(request("/config"))).json();
    expect(config.mainnetEnabled).toBe(false);
    expect(config.operationsEnabled).toBe(false);
    expect(config.supervisedSearch.enabled).toBe(false);
    expect(config.mainnetRecoveryEnabled).toBe(false);
    const closed = simulatedMainnetRequest();
    await seedCapability(store);
    const gated = await (await app.request(request("/config"))).json();
    expect(gated.supervisedSearch.enabled).toBe(false);
    expect(gated.mainnetRecoveryEnabled).toBe(false);
    expect(gated.mainnetEnabled).toBe(false);
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${closed.vault.id}`,
      version: 0,
      vault: closed.vault,
    });
    const token = await login(app);
    const wrongChain = structuredClone(closed.prepared.body) as {
      request: { network: string };
    };
    wrongChain.request.network = "testnet4";
    expect(
      (await app.request(request("/jobs/supervised", wrongChain, token))).status,
    ).toBe(400);
    const otherKey = new Uint8Array(32).fill(2);
    const otherAddress = btc.p2wpkh(
      secp256k1.getPublicKey(otherKey),
      btc.NETWORK,
    ).address!;
    const otherToken = await login(app, otherKey, otherAddress);
    expect(
      (
        await app.request(
          request("/jobs/supervised", closed.prepared.body, otherToken),
        )
      ).status,
    ).toBe(409);
    const created = await app.request(
      request("/jobs/supervised", closed.prepared.body, token),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.job.status).toBe("queued");
    expect(createdBody.runtime).toEqual({
      state: "queued",
      searchRunning: false,
    });
    const replay = await app.request(
      request("/jobs/supervised", closed.prepared.body, token),
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).job.id).toBe(createdBody.job.id);
    expect(
      [...store.rows.values()].filter((row) => String(row.sk).startsWith("JOB#")),
    ).toHaveLength(1);
    const altered = structuredClone(closed.prepared.body);
    altered.manifest.helper.value = "20000";
    altered.manifest.outputValue = "100000";
    altered.request.manifest.helper.value = "20000";
    altered.request.manifest.outputValue = "100000";
    expect(
      (await app.request(request("/jobs/supervised", altered, token))).status,
    ).toBe(409);
    const again = prepareMainnetSearchRequest({
      owner: address,
      vault: closed.vault,
      manifest: {
        ...closed.prepared.request.manifest,
        idempotencyKey: crypto.randomUUID(),
      },
      wallet: { address, publicKey, type: "p2wpkh" },
      releaseId: MAINNET_SEARCH_PROFILE,
    });
    expect(
      (await app.request(request("/jobs/supervised", again.body, token))).status,
    ).toBe(409);
    await store.put(
      {
        pk: "SYSTEM#QSB_MAINNET_SERVICE",
        sk: "CAPABILITY",
        version: 2,
        enabled: false,
        contract,
      },
      1,
    );
    expect(
      (await app.request(request("/jobs/supervised", closed.prepared.body, token)))
        .status,
    ).toBe(503);
  });

  it("preserves an uncertain process launch without starting another process", async () => {
    const store = new MemoryStore();
    const app = handoffApp(store);
    await seedCapability(store);
    const fixture = simulatedMainnetRequest();
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    const token = await login(app);
    const admitted = await (
      await app.request(request("/jobs/supervised", fixture.prepared.body, token))
    ).json();
    expect(admitted.runtime.searchRunning).toBe(false);
    const claimed = await claimAdmittedLaunch(store, address, admitted.job.id);
    expect(claimed.bindings).toMatchObject({
      owner: address,
      requestId: admitted.job.id,
      revision: 0,
      phase: "pinning",
      capability: "search-only",
      release: {
        profileId: "qsb-supervised-pin-v4-subset-v5",
        coreSourceManifest: contract.coreSourceManifest,
        nativeBinariesEnrolled: false,
        broadcastAuthorized: false,
      },
    });
    expect(claimed.bindings.reservations).toHaveLength(2);
    expect(claimed.bindings.configurationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(claimed.bindings.inputHash).toBe(admitted.job.mainnetRequestHash);
    let blockedStarts = 0;
    await expect(
      launchOwnedProcess(
        store,
        address,
        admitted.job.id,
        0,
        "ab".repeat(32),
        async () => {
          blockedStarts += 1;
          return { processId: "should-not-start" };
        },
        new Date(),
        1000,
      ),
    ).rejects.toThrow(/ImmutableInputMismatch/);
    expect(blockedStarts).toBe(0);
    let starts = 0;
    const hanging = localAckStarter(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      200,
      admitted.job.mainnetRequestHash,
    );
    const start: OwnedProcessStart = async () => {
      starts += 1;
      return hanging.start();
    };
    await expect(
      launchOwnedProcess(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        start,
        new Date(),
        200,
      ),
    ).rejects.toThrow(/AcknowledgementTimeout/);
    expect(starts).toBe(1);
    await expect(
      launchOwnedProcess(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        start,
        new Date(),
        200,
      ),
    ).rejects.toThrow(/LaunchRefused/);
    expect(starts).toBe(1);
    const paused = (await store.get(`OWNER#${address}`, `JOB#${admitted.job.id}`))
      ?.job as {
      status: string;
      error?: string;
      runtime: { searchRunning: boolean };
    };
    expect(paused.status).toBe("paused");
    expect(paused.runtime.searchRunning).toBe(false);
    expect(paused.error).toContain("Submission outcome unknown");
    const uncertain = (
      await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`)
    )?.launch as { state: string; processId?: string };
    expect(uncertain.state).toBe("uncertain");
    expect(uncertain.processId).toMatch(/^\d+$/);
    await Promise.all(hanging.exits);
  });

  it("does not record a pid when the child cannot be spawned", async () => {
    const { store, admitted } = await claimedFixture();
    const starter = localAckStarter(
      "qsb-missing-binary",
      [],
      1000,
      admitted.job.mainnetRequestHash,
    );
    await expect(
      launchOwnedProcess(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        starter.start,
        new Date(),
        1000,
      ),
    ).rejects.toThrow(/ProcessIdentityMissing/);
    const launch = (
      await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`)
    )?.launch as { state: string; processId?: string };
    expect(launch.state).toBe("uncertain");
    expect(launch.processId).toBeUndefined();
  });

  it("treats stdout that follows the ack as a violation after the pipe closes", async () => {
    const { store, admitted } = await claimedFixture();
    const line = acknowledgementLine(admitted.job.mainnetRequestHash);
    const starter = localAckStarter(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(line)}); setTimeout(() => process.stdout.write("later\\n", () => process.exit(0)), 200);`,
      ],
      2000,
      admitted.job.mainnetRequestHash,
    );
    const acknowledged = await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      starter.start,
      new Date(),
      2000,
    );
    expect(acknowledged.state).toBe("acknowledged");
    const started = Date.now();
    let protocol = "";
    while (protocol !== "violated" && Date.now() - started < 2000) {
      protocol =
        (
          (await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`))?.launch as {
            stdoutProtocol?: string;
          }
        ).stdoutProtocol ?? "";
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(protocol).toBe("violated");
    await Promise.all(starter.exits);
  });

  it("records one late provider id after an uncertain paid attempt", async () => {
    const store = new MemoryStore();
    const app = handoffApp(store);
    await seedCapability(store);
    const fixture = simulatedMainnetRequest();
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    const token = await login(app);
    const admitted = await (
      await app.request(request("/jobs/supervised", fixture.prepared.body, token))
    ).json();
    await claimAdmittedLaunch(store, address, admitted.job.id);
    const starter = localAckStarter(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(acknowledgementLine(admitted.job.mainnetRequestHash))}, () => process.exit(0))`,
      ],
      2000,
      admitted.job.mainnetRequestHash,
    );
    const acknowledged = await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      starter.start,
      new Date(),
      2000,
    );
    expect(acknowledged.acknowledgement?.searchSuccess).toBe(false);
    expect(
      (
        await app.request(
          request(
            `/jobs/${admitted.job.id}/mainnet-solved-state`,
            undefined,
            token,
          ),
        )
      ).status,
    ).toBe(404);
    let calls = 0;
    await expect(
      submitProviderOnce(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        async () => {
          calls += 1;
          throw new Error("provider timeout");
        },
      ),
    ).rejects.toThrow(/provider timeout/);
    await expect(
      submitProviderOnce(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        async () => {
          calls += 1;
          return { providerId: "should-not-run" };
        },
      ),
    ).rejects.toThrow(/DuplicatePaidSubmission/);
    expect(calls).toBe(1);
    const late = await recordLateProviderId(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      "simulated-provider-late",
    );
    expect(late).toMatchObject({
      providerId: "simulated-provider-late",
      providerSubmissions: 1,
      state: "running",
    });
    await expect(
      recordLateProviderId(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        "simulated-provider-other",
      ),
    ).rejects.toThrow(/DuplicatePaidSubmission/);
    const restarted = await store.get(
      `OWNER#${address}`,
      `LAUNCH#${admitted.job.id}#0`,
    );
    expect(restarted?.launch).toMatchObject({
      providerId: "simulated-provider-late",
      providerSubmissions: 1,
    });
    await Promise.all(starter.exits);
  });

  it("joins a simulated solved handoff through the enrolled readers", async () => {
    const rejected = await runEnrolledCpuVerifier(process.cwd(), {
      action: "verify",
      stage: "pinning",
    });
    expect(rejected).toMatchObject({
      ok: false,
      source: "worker/cpu/handler.py",
    });
    const store = new MemoryStore();
    const app = handoffApp(store);
    await seedCapability(store);
    const fixture = simulatedMainnetRequest();
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    const token = await login(app);
    const fetcher: typeof fetch = (input, init) =>
      Promise.resolve(app.request(String(input), init));
    const submitted = await retainedMainnetSubmission(
      fixture.prepared,
      memoryRetention(),
      () => true,
      async (body) => {
        const response = await app.request(
          request("/jobs/supervised", body, token),
        );
        expect(response.status).toBe(201);
        return response.json();
      },
    ).submit();
    const job = (
      submitted as {
        job: { id: string; status: string; mainnetRequestHash: string };
      }
    ).job;
    expect(job.status).toBe("queued");
    await claimAdmittedLaunch(store, address, job.id);
    const first = localAckStarter(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(acknowledgementLine(job.mainnetRequestHash))}, () => process.exit(0))`,
      ],
      2000,
      job.mainnetRequestHash,
    );
    const acknowledged = await launchOwnedProcess(
      store,
      address,
      job.id,
      0,
      job.mainnetRequestHash,
      first.start,
      new Date("2026-09-23T00:00:00.000Z"),
      1000,
    );
    expect(acknowledged.acknowledgement).toMatchObject({
      searchSuccess: false,
      wholeRangeCovered: false,
    });
    expect(
      acknowledgementExpired(acknowledged, new Date("2026-09-23T00:00:01.000Z")),
    ).toBe(true);
    expect(
      (
        (await store.get(`OWNER#${address}`, `JOB#${job.id}`))?.job as {
          status: string;
          runtime: { searchRunning: boolean };
        }
      ).status,
    ).toBe("queued");
    await expect(
      publishSimulatedVerifiedHit(
        store,
        address,
        job.id,
        0,
        job.mainnetRequestHash,
        acknowledged.processId ?? "",
        simulatedFacts,
        fixture.bundle,
      ),
    ).rejects.toThrow(/AcknowledgementIsNotSuccess/);
    let providerCalls = 0;
    const running = await submitProviderOnce(
      store,
      address,
      job.id,
      0,
      job.mainnetRequestHash,
      async () => {
        providerCalls += 1;
        return { providerId: "simulated-provider" };
      },
    );
    expect(running.state).toBe("running");
    expect(
      (
        (await store.get(`OWNER#${address}`, `JOB#${job.id}`))?.job as {
          status: string;
          runtime: { searchRunning: boolean };
        }
      ).runtime.searchRunning,
    ).toBe(true);
    await expect(
      submitProviderOnce(
        store,
        address,
        job.id,
        0,
        job.mainnetRequestHash,
        async () => {
          providerCalls += 1;
          return { providerId: "simulated-provider-2" };
        },
      ),
    ).rejects.toThrow(/DuplicatePaidSubmission/);
    expect(providerCalls).toBe(1);
    const replacement = localAckStarter(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(acknowledgementLine(job.mainnetRequestHash))}, () => process.exit(0))`,
      ],
      2000,
      job.mainnetRequestHash,
    );
    const replaced = await replaceOwnedProcess(
      store,
      address,
      job.id,
      0,
      job.mainnetRequestHash,
      replacement.start,
      new Date(),
      2000,
      async () => undefined,
    );
    expect(replaced.previousProcessIds).toContain(acknowledged.processId);
    expect(replaced.providerSubmissions).toBe(1);
    expect(providerCalls).toBe(1);
    await expect(
      publishSimulatedVerifiedHit(
        store,
        address,
        job.id,
        0,
        job.mainnetRequestHash,
        acknowledged.processId ?? "",
        simulatedFacts,
        fixture.bundle,
      ),
    ).rejects.toThrow(/StaleProcess/);
    await openSiblingSlot(store, address, job.id, job.mainnetRequestHash);
    await publishSimulatedVerifiedHit(
      store,
      address,
      job.id,
      0,
      job.mainnetRequestHash,
      replaced.processId ?? "",
      simulatedFacts,
      fixture.bundle,
    );
    expect(
      (
        await app.request(
          request(`/jobs/${job.id}/mainnet-solved-state`, undefined, token),
        )
      ).status,
    ).toBe(409);
    await drainSibling(store, address, job.id, job.mainnetRequestHash);
    const reader = currentAdmissionClient(
      job.id,
      fixture.vault.id,
      () => token,
      fetcher,
    );
    const admitted = await reader(fixture.vault.id);
    expect(admitted.mainnetAuthorized).toBe(false);
    expect(admitted.record.bundleSha256).toBe(fingerprint(fixture.bundle));
    const bound = await bindSolvedConsumer(
      fixture.prepared.request,
      fixture.bundle,
      { fundingPreviousTxHex: "00", helperPreviousTxHex: "00" },
      {
        assembly: {
          prepare: async () => {
            throw new Error("assembly not used");
          },
          reimport: async () => {
            throw new Error("assembly not used");
          },
        },
        lock: () => undefined,
        flow: {
          prepare: async () => {
            throw new Error("chain signing not used");
          },
          accept: async () => {
            throw new Error("chain signing not used");
          },
        },
        signPsbt: async () => {
          throw new Error("wallet signing not used");
        },
        readCurrentAdmission: reader,
      } as Parameters<typeof bindSolvedConsumer>[3],
    );
    expect(bound.solvedStateHash).toBe(fingerprint(fixture.bundle));
    bound.dispose();
    const handoff = await (
      await app.request(
        request(`/jobs/${job.id}/signing-handoff`, undefined, token),
      )
    ).json();
    expect(handoff).toMatchObject({
      format: "qsb-signing-handoff-v1",
      broadcastAuthorized: false,
      signingAuthorized: false,
      mainnetEnabled: false,
      coverage: "verified-hit-not-whole-range",
      solverFacts: "simulated",
      chainFacts: "simulated",
      cpuVerification: "simulated",
      binariesProduced: false,
      freshSearch: false,
      siblingsDrained: true,
    });
    expect((await store.get(`OWNER#${address}`, `JOB#${job.id}`))?.job).toMatchObject({
      status: "awaiting_authorization",
      solverFacts: "simulated",
      chainFacts: "simulated",
      coverage: "verified-hit-not-whole-range",
      runtime: { state: "terminal", searchRunning: false },
    });
    const sessionPk = `SESSION#${createHash("sha256").update(token).digest("hex")}`;
    const session = await store.get(sessionPk, "AUTH");
    expect(session).toBeTruthy();
    await store.put({ ...session!, expiresAt: 1, version: session!.version + 1 }, session!.version);
    expect(
      (
        await app.request(
          request(`/jobs/${job.id}/mainnet-solved-state`, undefined, token),
        )
      ).status,
    ).toBe(401);
    const resumed = await login(app);
    expect(
      (
        await currentAdmissionClient(
          job.id,
          fixture.vault.id,
          () => resumed,
          fetcher,
        )(fixture.vault.id)
      ).mainnetAuthorized,
    ).toBe(false);
    await store.put(
      {
        pk: "SYSTEM#QSB_MAINNET_SERVICE",
        sk: "CAPABILITY",
        version: 2,
        enabled: false,
        contract,
      },
      1,
    );
    expect(
      (
        await app.request(
          request(`/jobs/${job.id}/mainnet-solved-state`, undefined, resumed),
        )
      ).status,
    ).toBe(503);
    await Promise.all([...first.exits, ...replacement.exits]);
  });

  it("lets only one concurrent launch pass the claimed version", async () => {
    const store = new MemoryStore();
    await seedCapability(store);
    const fixture = simulatedMainnetRequest();
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    const admitted = await admitSupervisedJob(
      store,
      address,
      "mainnet",
      fixture.prepared.body,
      confirmingLedger,
    );
    await claimAdmittedLaunch(store, address, admitted.job.id);
    let starts = 0;
    const start: OwnedProcessStart = async () => {
      starts += 1;
      return { processId: `concurrent-${starts}` };
    };
    const results = await Promise.allSettled([
      launchOwnedProcess(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        start,
        new Date(),
        1000,
      ),
      launchOwnedProcess(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        start,
        new Date(),
        1000,
      ),
    ]);
    expect(starts).toBe(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected")
      expect(rejected.reason).toBeInstanceOf(Conflict);
  });

  it("rejects stdout that merely contains ack", async () => {
    const store = new MemoryStore();
    await seedCapability(store);
    const fixture = simulatedMainnetRequest();
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    const admitted = await admitSupervisedJob(
      store,
      address,
      "mainnet",
      fixture.prepared.body,
      confirmingLedger,
    );
    await claimAdmittedLaunch(store, address, admitted.job.id);
    const noisy = localAckStarter(
      process.execPath,
      ["-e", "process.stdout.write('package loaded', () => process.exit(0))"],
      2000,
      admitted.job.mainnetRequestHash,
    );
    const diverged = localAckStarter(
      process.execPath,
      ["-e", "process.stdout.write('nope'); setInterval(() => {}, 1000)"],
      5000,
      admitted.job.mainnetRequestHash,
    );
    await expect(diverged.start()).rejects.toThrow(/AcknowledgementRejected/);
    const exitCode = await Promise.race([
      Promise.all(diverged.exits).then((codes) => codes[0]),
      new Promise<number>((_resolve, reject) =>
        setTimeout(() => reject(new Error("still-alive")), 1000),
      ),
    ]);
    expect(exitCode).not.toBeNull();
    await expect(
      launchOwnedProcess(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        noisy.start,
        new Date(),
        2000,
      ),
    ).rejects.toThrow(/AcknowledgementRejected/);
    await Promise.all(noisy.exits);
  });

  it("reserves one outpoint regardless of txid case", async () => {
    const store = new MemoryStore();
    await seedCapability(store);
    const first = simulatedMainnetRequest();
    const second = simulatedMainnetRequest();
    const upper = first.vault.funding!.txid.toUpperCase();
    const helper = { txid: "33".repeat(32), vout: 1, value: "10000" };
    const funding = { ...first.vault.funding!, txid: upper };
    const secondVault = { ...second.vault, funding };
    const request = second.prepared.body.request as {
      vault: typeof secondVault;
      manifest: { funding: typeof funding; helper: typeof helper };
    };
    const nextRequest = {
      ...request,
      vault: secondVault,
      manifest: { ...request.manifest, funding, helper },
    };
    const body = {
      ...second.prepared.body,
      request: nextRequest,
      manifest: {
        ...second.prepared.body.manifest,
        funding,
        helper,
      },
    };
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${first.vault.id}`,
      version: 0,
      vault: first.vault,
    });
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${secondVault.id}`,
      version: 0,
      vault: secondVault,
    });
    await admitSupervisedJob(store, address, "mainnet", first.prepared.body, confirmingLedger);
    await expect(
      admitSupervisedJob(store, address, "mainnet", body, confirmingLedger),
    ).rejects.toThrow(/Outpoint already reserved/);
  });

  async function claimedFixture() {
    const store = new MemoryStore();
    await seedCapability(store);
    const fixture = simulatedMainnetRequest();
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    const admitted = await admitSupervisedJob(
      store,
      address,
      "mainnet",
      fixture.prepared.body,
      confirmingLedger,
    );
    await claimAdmittedLaunch(store, address, admitted.job.id);
    return { store, fixture, admitted };
  }

  it("refuses replacement once process history is full", async () => {
    const { store, admitted } = await claimedFixture();
    const starter = localAckStarter(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(acknowledgementLine(admitted.job.mainnetRequestHash))}, () => process.exit(0))`,
      ],
      2000,
      admitted.job.mainnetRequestHash,
    );
    await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      starter.start,
      new Date(),
      2000,
    );
    const row = await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`);
    const launch = row?.launch as { previousProcessIds: string[]; processId: string };
    launch.previousProcessIds = Array.from({ length: 8 }, (_, index) => `old-${index}`);
    await store.put({ ...row!, launch, version: row!.version + 1 }, row!.version);
    let starts = 0;
    await expect(
      replaceOwnedProcess(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        async () => {
          starts += 1;
          return { processId: "should-not-start" };
        },
        new Date(),
        1000,
        async () => undefined,
      ),
    ).rejects.toThrow(/ReplaceRefused/);
    expect(starts).toBe(0);
    await Promise.all(starter.exits);
  });

  it("rejects a paid submission while replacement is in progress", async () => {
    const { store, admitted } = await claimedFixture();
    const starter = localAckStarter(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(acknowledgementLine(admitted.job.mainnetRequestHash))}, () => process.exit(0))`,
      ],
      2000,
      admitted.job.mainnetRequestHash,
    );
    await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      starter.start,
      new Date(),
      2000,
    );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let submits = 0;
    const replacing = replaceOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => {
        await gate;
        return { processId: "replacement-process" };
      },
      new Date(),
      2000,
      async () => undefined,
    );
    const started = Date.now();
    let state = "";
    while (state !== "replacing") {
      state = (
        (await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`))?.launch as {
          state: string;
        }
      ).state;
      if (Date.now() - started > 2000) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expect(
      submitProviderOnce(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        async () => {
          submits += 1;
          return { providerId: "should-not-submit" };
        },
      ),
    ).rejects.toThrow(/DuplicatePaidSubmission/);
    expect(submits).toBe(0);
    release();
    await replacing;
    await Promise.all(starter.exits);
  });

  it("refuses replacement while a paid submission is in flight", async () => {
    const { store, admitted } = await claimedFixture();
    await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => ({ processId: "paid-in-flight" }),
      new Date(),
      2000,
    );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const submitting = submitProviderOnce(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => {
        entered();
        await gate;
        return { providerId: "in-flight-provider" };
      },
    );
    await inFlight;
    let starts = 0;
    await expect(
      replaceOwnedProcess(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        async () => {
          starts += 1;
          return { processId: "should-not-start" };
        },
        new Date(),
        2000,
        async () => undefined,
      ),
    ).rejects.toThrow(/ProviderSubmissionUnresolved/);
    expect(starts).toBe(0);
    release();
    const running = await submitting;
    expect(running.state).toBe("running");
    expect(running.providerId).toBe("in-flight-provider");
    expect(running.processId).toBe("paid-in-flight");
  });

  it("replaces an uncertain paid launch only after its provider id is reconciled", async () => {
    const { store, admitted } = await claimedFixture();
    await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => ({ processId: "timed-out-submit" }),
      new Date(),
      2000,
    );
    await expect(
      submitProviderOnce(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        async () => {
          throw new Error("provider timeout");
        },
      ),
    ).rejects.toThrow(/provider timeout/);
    const replace = () =>
      replaceOwnedProcess(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        async () => ({ processId: "after-reconcile" }),
        new Date(),
        2000,
        async () => undefined,
      );
    await expect(replace()).rejects.toThrow(/ProviderSubmissionUnresolved/);
    await recordLateProviderId(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      "reconciled-provider",
    );
    const replaced = await replace();
    expect(replaced.state).toBe("running");
    expect(replaced.processId).toBe("after-reconcile");
    expect(replaced.providerId).toBe("reconciled-provider");
  });

  it("drains a live sibling only after the process is stopped", async () => {
    const { store, admitted } = await claimedFixture();
    await openSiblingSlot(store, address, admitted.job.id, admitted.job.mainnetRequestHash);
    const line = acknowledgementLine(admitted.job.mainnetRequestHash);
    const starter = localAckStarter(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(line)}, () => setTimeout(() => {}, 10000))`,
      ],
      2000,
      admitted.job.mainnetRequestHash,
    );
    const acknowledged = await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      1,
      admitted.job.mainnetRequestHash,
      starter.start,
      new Date(),
      2000,
    );
    await expect(
      drainSibling(store, address, admitted.job.id, admitted.job.mainnetRequestHash),
    ).rejects.toThrow(/SiblingProcessStillLive/);
    expect(
      (
        (await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#1`))?.launch as {
          state: string;
        }
      ).state,
    ).toBe("acknowledged");
    let stopped = 0;
    const drained = await drainSibling(
      store,
      address,
      admitted.job.id,
      admitted.job.mainnetRequestHash,
      async (processId) => {
        expect(processId).toBe(acknowledged.processId);
        stopped += 1;
        process.kill(Number(processId), "SIGKILL");
      },
    );
    expect(stopped).toBe(1);
    expect(drained.evidence?.outcome).toBe("drained");
    await Promise.all(starter.exits);
  });

  it("invalidates an acknowledgement when stdout continues past the ack line", async () => {
    const { store, admitted } = await claimedFixture();
    const line = acknowledgementLine(admitted.job.mainnetRequestHash);
    const starter = localAckStarter(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(line)}, () => setTimeout(() => process.stdout.write("more\\n", () => process.exit(0)), 30))`,
      ],
      2000,
      admitted.job.mainnetRequestHash,
    );
    const acknowledged = await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      starter.start,
      new Date(),
      2000,
    );
    expect(acknowledged.state).toBe("acknowledged");
    const started = Date.now();
    let state = acknowledged.state;
    while (state === "acknowledged" && Date.now() - started < 2000) {
      state = (
        (await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`))?.launch as {
          state: typeof state;
        }
      ).state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(state).toBe("uncertain");
    await Promise.all(starter.exits);
  });

  it("keeps a replacement when the superseded process writes more stdout", async () => {
    const { store, admitted } = await claimedFixture();
    const line = acknowledgementLine(admitted.job.mainnetRequestHash);
    const starter = localAckStarter(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(line)}, () => setTimeout(() => process.stdout.write("late\\n", () => process.exit(0)), 50))`,
      ],
      2000,
      admitted.job.mainnetRequestHash,
    );
    const acknowledged = await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      starter.start,
      new Date(),
      2000,
    );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replacing = replaceOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => {
        await gate;
        return { processId: "replacement-pid" };
      },
      new Date(),
      2000,
      async () => undefined,
    );
    const started = Date.now();
    let state = "";
    while (state !== "replacing" && Date.now() - started < 2000) {
      state = (
        (await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`))?.launch as {
          state: string;
        }
      ).state;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(state).toBe("replacing");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const during = (await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`))
      ?.launch as { state: string; processId?: string };
    expect(during.state).toBe("replacing");
    expect(during.processId).toBe(acknowledged.processId);
    release();
    const replaced = await replacing;
    expect(replaced.processId).toBe("replacement-pid");
    expect(replaced.state).toBe("acknowledged");
    expect(replaced.previousProcessIds).toContain(acknowledged.processId);
    await Promise.all(starter.exits);
  });

  it("refuses legacy pause, resume, and submit for a supervised job", async () => {
    const store = new MemoryStore();
    const app = handoffApp(store);
    await seedCapability(store);
    const fixture = simulatedMainnetRequest();
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    const token = await login(app);
    const admitted = await (
      await app.request(request("/jobs/supervised", fixture.prepared.body, token))
    ).json();
    const paused = await app.request(
      request(`/jobs/${admitted.job.id}/pause`, {}, token),
    );
    expect(paused.status).toBe(409);
    const resumed = await app.request(
      request(`/jobs/${admitted.job.id}/resume`, {}, token),
    );
    expect(resumed.status).toBe(503);
    const submitted = await app.request(
      request(`/jobs/${admitted.job.id}/submit`, { rawTxHex: "00" }, token),
    );
    expect(submitted.status).toBe(503);
    const status = await app.request(
      request(`/jobs/${admitted.job.id}/status`, undefined, token),
    );
    expect(status.status).toBe(409);
    expect(
      (
        (await store.get(`OWNER#${address}`, `JOB#${admitted.job.id}`))?.job as {
          status: string;
        }
      ).status,
    ).toBe("queued");
  });

  it("keeps an active search visible while replacing its process", async () => {
    const { store, admitted } = await claimedFixture();
    const line = acknowledgementLine(admitted.job.mainnetRequestHash);
    const starter = localAckStarter(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(line)}, () => process.exit(0))`,
      ],
      2000,
      admitted.job.mainnetRequestHash,
    );
    await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      starter.start,
      new Date(),
      2000,
    );
    await submitProviderOnce(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => ({ providerId: "simulated-provider" }),
    );
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sawOldPid = false;
    const replacing = replaceOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => {
        await gate;
        return { processId: "replacement-search" };
      },
      new Date(),
      2000,
      async (processId) => {
        const launch = (
          await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`)
        )?.launch as {
          state: string;
          processId?: string;
          providerOutcome: string;
          providerId?: string;
        };
        expect(launch.state).toBe("replacing");
        expect(launch.processId).toBe(processId);
        expect(
          isSearchRunning(
            launch as Parameters<typeof isSearchRunning>[0],
          ),
        ).toBe(true);
        sawOldPid = true;
      },
    );
    const started = Date.now();
    let jobStatus = "";
    while (jobStatus !== "searching" && Date.now() - started < 2000) {
      const job = (await store.get(`OWNER#${address}`, `JOB#${admitted.job.id}`))
        ?.job as { status: string; runtime: { searchRunning: boolean } };
      jobStatus = job.status;
      if (jobStatus === "searching") expect(job.runtime.searchRunning).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(jobStatus).toBe("searching");
    release();
    const replaced = await replacing;
    expect(sawOldPid).toBe(true);
    expect(replaced.processId).toBe("replacement-search");
    expect(replaced.state).toBe("running");
    expect(isSearchRunning(replaced)).toBe(true);
    await Promise.all(starter.exits);
  });

  it("does not publish a new pid when the old process cannot be stopped", async () => {
    const { store, admitted } = await claimedFixture();
    const line = acknowledgementLine(admitted.job.mainnetRequestHash);
    const starter = localAckStarter(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(line)}, () => process.exit(0))`,
      ],
      2000,
      admitted.job.mainnetRequestHash,
    );
    const acknowledged = await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      starter.start,
      new Date(),
      2000,
    );
    await expect(
      replaceOwnedProcess(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        async () => ({ processId: "orphaned-if-committed" }),
        new Date(),
        2000,
        async () => {
          throw new Error("stop failed");
        },
      ),
    ).rejects.toThrow(/stop failed/);
    const launch = (
      await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`)
    )?.launch as { state: string; processId?: string; replacement?: string };
    expect(launch.state).toBe("uncertain");
    expect(launch.processId).toBe(acknowledged.processId);
    expect(launch.replacement).toBe("uncertain");
    await Promise.all(starter.exits);
  });

  it("retries a conflicting stdout invalidation until the launch is uncertain", async () => {
    const inner = new MemoryStore();
    let conflicts = 1;
    const store: Store = {
      get: (pk, sk) => inner.get(pk, sk),
      put: (row, expected) => inner.put(row, expected),
      delete: (pk, sk, expected) => inner.delete(pk, sk, expected),
      list: (pk, prefix) => inner.list(pk, prefix),
      atomicPut: async (writes) => {
        const markingUncertain = writes.some((write) => {
          const launch = write.row.launch as { state?: string } | undefined;
          return launch?.state === "uncertain";
        });
        if (markingUncertain && conflicts > 0) {
          conflicts -= 1;
          throw new Conflict("forced");
        }
        await inner.atomicPut(writes);
      },
    };
    await seedCapability(inner);
    const fixture = simulatedMainnetRequest();
    await inner.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    const admitted = await admitSupervisedJob(
      store,
      address,
      "mainnet",
      fixture.prepared.body,
      confirmingLedger,
    );
    await claimAdmittedLaunch(store, address, admitted.job.id);
    let rejectStdout: (error: Error) => void = () => undefined;
    const stdoutExclusive = new Promise<void>((_resolve, reject) => {
      rejectStdout = reject;
    });
    stdoutExclusive.catch(() => undefined);
    const acknowledged = await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => ({ processId: "watched-process", stdoutExclusive }),
      new Date(),
      2000,
    );
    expect(acknowledged.state).toBe("acknowledged");
    rejectStdout(new Error("AcknowledgementRejected"));
    const started = Date.now();
    let state = "acknowledged";
    while (state !== "uncertain" && Date.now() - started < 2000) {
      state = (
        (await inner.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`))?.launch as {
          state: string;
        }
      ).state;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(conflicts).toBe(0);
    expect(state).toBe("uncertain");
  });

  it("refuses a CPU verifier whose sources are not the enrolled bytes", async () => {
    const directory = mkdtempSync(`${tmpdir()}/qsb-cpu-`);
    await expect(
      runEnrolledCpuVerifier(directory, { action: "verify", stage: "pinning" }),
    ).rejects.toThrow(/CpuVerifierNotEnrolled/);
  });

  it("enrolls the CPU verifier from the packaged tree manifest", async () => {
    const directory = mkdtempSync(`${tmpdir()}/qsb-pkg-`);
    writePackageTree(process.cwd(), directory);
    const tree = path.join(directory, "tree");
    const rejected = await runEnrolledCpuVerifier(tree, {
      action: "verify",
      stage: "pinning",
    });
    expect(rejected).toMatchObject({
      ok: false,
      source: "worker/cpu/handler.py",
    });
    rmSync(path.join(directory, "release-manifest.json"));
    await expect(
      runEnrolledCpuVerifier(tree, { action: "verify", stage: "pinning" }),
    ).rejects.toThrow(/CpuVerifierNotEnrolled/);
  });

  it("ignores a forged manifest inside a packaged tree", async () => {
    const directory = mkdtempSync(`${tmpdir()}/qsb-pkg-`);
    writePackageTree(process.cwd(), directory);
    const tree = path.join(directory, "tree");
    const handler = path.join(tree, "worker/cpu/handler.py");
    writeFileSync(handler, "def handler(event):\n    return {'forged': True}\n");
    const manifest = JSON.parse(
      readFileSync(path.join(directory, "release-manifest.json"), "utf8"),
    ) as {
      identities: {
        sourceFiles: Record<string, string>;
        components: Record<string, string>;
      };
    };
    manifest.identities.sourceFiles["worker/cpu/handler.py"] = createHash("sha256")
      .update(readFileSync(handler))
      .digest("hex");
    manifest.identities.components = componentIdentities(
      manifest.identities.sourceFiles,
    );
    mkdirSync(path.join(tree, "release"));
    writeFileSync(
      path.join(tree, "release/source-manifest.json"),
      JSON.stringify(manifest),
    );
    await expect(
      runEnrolledCpuVerifier(tree, { action: "verify", stage: "pinning" }),
    ).rejects.toThrow(/CpuVerifierNotEnrolled/);
  });

  it("refuses an unenrolled Python module beside the CPU verifier", async () => {
    const directory = mkdtempSync(`${tmpdir()}/qsb-pkg-`);
    writePackageTree(process.cwd(), directory);
    const tree = path.join(directory, "tree");
    writeFileSync(path.join(tree, "worker/cpu/sitecustomize.py"), "import os\n");
    await expect(
      runEnrolledCpuVerifier(tree, { action: "verify", stage: "pinning" }),
    ).rejects.toThrow(/CpuVerifierNotEnrolled/);
  });

  it("refuses a package directory that would shadow an enrolled CPU module", async () => {
    const directory = mkdtempSync(`${tmpdir()}/qsb-pkg-`);
    writePackageTree(process.cwd(), directory);
    const tree = path.join(directory, "tree");
    const shadow = path.join(tree, "worker/cpu/qsb_pipeline");
    mkdirSync(shadow);
    writeFileSync(path.join(shadow, "__init__.py"), "VALUE = 'shadow'\n");
    await expect(
      runEnrolledCpuVerifier(tree, { action: "verify", stage: "pinning" }),
    ).rejects.toThrow(/CpuVerifierNotEnrolled/);
    rmSync(shadow, { recursive: true });
    writeFileSync(
      path.join(tree, "worker/cpu/qsb_pipeline.cpython-312-x86_64-linux-gnu.so"),
      "",
    );
    await expect(
      runEnrolledCpuVerifier(tree, { action: "verify", stage: "pinning" }),
    ).rejects.toThrow(/CpuVerifierNotEnrolled/);
  });

  it("does not cache bytecode and still refuses a foreign cache", async () => {
    const directory = mkdtempSync(`${tmpdir()}/qsb-pkg-`);
    writePackageTree(process.cwd(), directory);
    const tree = path.join(directory, "tree");
    const first = await runEnrolledCpuVerifier(tree, {
      action: "verify",
      stage: "pinning",
    });
    const second = await runEnrolledCpuVerifier(tree, {
      action: "verify",
      stage: "pinning",
    });
    expect(first).toMatchObject({ ok: false, source: "worker/cpu/handler.py" });
    expect(second).toMatchObject({ ok: false, source: "worker/cpu/handler.py" });
    expect(existsSync(path.join(tree, "worker/cpu/__pycache__"))).toBe(false);
    mkdirSync(path.join(tree, "worker/cpu/__pycache__"));
    writeFileSync(
      path.join(tree, "worker/cpu/__pycache__/handler.cpython-312.pyc"),
      "not-enrolled",
    );
    await expect(
      runEnrolledCpuVerifier(tree, { action: "verify", stage: "pinning" }),
    ).rejects.toThrow(/CpuVerifierNotEnrolled/);
  });

  it("refuses cached bytecode beside the enrolled CPU sources", async () => {
    const directory = mkdtempSync(`${tmpdir()}/qsb-pkg-`);
    writePackageTree(process.cwd(), directory);
    const tree = path.join(directory, "tree");
    const cache = path.join(tree, "worker/cpu/__pycache__");
    mkdirSync(cache);
    writeFileSync(path.join(cache, "handler.cpython-312.pyc"), "not-enrolled");
    await expect(
      runEnrolledCpuVerifier(tree, { action: "verify", stage: "pinning" }),
    ).rejects.toThrow(/CpuVerifierNotEnrolled/);
  });

  it("retains both process ids when primary and sibling acknowledge together", async () => {
    const { store, admitted } = await claimedFixture();
    await openSiblingSlot(store, address, admitted.job.id, admitted.job.mainnetRequestHash);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const primary = launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => {
        await gate;
        return { processId: "primary-pid" };
      },
      new Date(),
      1000,
    );
    const sibling = launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      1,
      admitted.job.mainnetRequestHash,
      async () => {
        await gate;
        return { processId: "sibling-pid" };
      },
      new Date(),
      1000,
    );
    const started = Date.now();
    while (Date.now() - started < 2000) {
      const primaryLaunch = (
        await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`)
      )?.launch as { state: string };
      const siblingLaunch = (
        await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#1`)
      )?.launch as { state: string };
      if (primaryLaunch.state === "launching" && siblingLaunch.state === "launching") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    release();
    const [primaryResult, siblingResult] = await Promise.all([primary, sibling]);
    expect(primaryResult).toMatchObject({ state: "acknowledged", processId: "primary-pid" });
    expect(siblingResult).toMatchObject({ state: "acknowledged", processId: "sibling-pid" });
  });

  it("allows only one paid provider submission across sibling slots", async () => {
    const { store, admitted } = await claimedFixture();
    await openSiblingSlot(store, address, admitted.job.id, admitted.job.mainnetRequestHash);
    for (const slot of [0, 1]) {
      await launchOwnedProcess(
        store,
        address,
        admitted.job.id,
        slot,
        admitted.job.mainnetRequestHash,
        async () => ({ processId: `slot-${slot}` }),
        new Date(),
        1000,
      );
    }
    let calls = 0;
    const submit = async () => {
      calls += 1;
      return { providerId: `provider-${calls}` };
    };
    const results = await Promise.allSettled([
      submitProviderOnce(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        submit,
      ),
      submitProviderOnce(
        store,
        address,
        admitted.job.id,
        1,
        admitted.job.mainnetRequestHash,
        submit,
      ),
    ]);
    expect(calls).toBe(1);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    if (results[1]?.status === "rejected")
      expect(String(results[1].reason)).toMatch(/DuplicatePaidSubmission/);
  });

  it("does not let a sibling slot submit or publish a paid hit", async () => {
    const { store, admitted, fixture } = await claimedFixture();
    await openSiblingSlot(store, address, admitted.job.id, admitted.job.mainnetRequestHash);
    await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      1,
      admitted.job.mainnetRequestHash,
      async () => ({ processId: "sibling-pid" }),
      new Date(),
      1000,
    );
    let calls = 0;
    await expect(
      submitProviderOnce(
        store,
        address,
        admitted.job.id,
        1,
        admitted.job.mainnetRequestHash,
        async () => {
          calls += 1;
          return { providerId: "sibling-provider" };
        },
      ),
    ).rejects.toThrow(/DuplicatePaidSubmission/);
    expect(calls).toBe(0);
    await expect(
      publishSimulatedVerifiedHit(
        store,
        address,
        admitted.job.id,
        1,
        admitted.job.mainnetRequestHash,
        "sibling-pid",
        simulatedFacts,
        fixture.bundle,
      ),
    ).rejects.toThrow(/DuplicatePaidSubmission/);
    const job = (await store.get(`OWNER#${address}`, `JOB#${admitted.job.id}`))?.job as {
      status: string;
      paidProviderSlot?: number;
      runtime: { searchRunning: boolean };
    };
    expect(job.status).toBe("queued");
    expect(job.paidProviderSlot).toBeUndefined();
    expect(job.runtime.searchRunning).toBe(false);
  });

  it("does not publish a paid result after stdout violates during submit", async () => {
    const { store, admitted } = await claimedFixture();
    let rejectStdout: (error: Error) => void = () => undefined;
    const stdoutExclusive = new Promise<void>((_resolve, reject) => {
      rejectStdout = reject;
    });
    stdoutExclusive.catch(() => undefined);
    await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => ({ processId: "acked-process", stdoutExclusive }),
      new Date(),
      2000,
    );
    await expect(
      submitProviderOnce(
        store,
        address,
        admitted.job.id,
        0,
        admitted.job.mainnetRequestHash,
        async () => {
          rejectStdout(new Error("AcknowledgementRejected"));
          const started = Date.now();
          while (Date.now() - started < 2000) {
            const launch = (
              await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`)
            )?.launch as { stdoutProtocol?: string };
            if (launch.stdoutProtocol === "violated") break;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return { providerId: "should-not-publish" };
        },
      ),
    ).rejects.toThrow(/AcknowledgementRejected/);
    const launch = (
      await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`)
    )?.launch as { state: string; providerId?: string; stdoutProtocol?: string };
    expect(launch.stdoutProtocol).toBe("violated");
    expect(launch.providerId).toBeUndefined();
    expect(launch.state).not.toBe("running");
  });

  it("refuses a sibling after the primary launch is terminal", async () => {
    const { store, admitted } = await claimedFixture();
    const row = await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`);
    const launch = row?.launch as { state: string };
    launch.state = "terminal";
    await store.put({ ...row!, launch, version: row!.version + 1 }, row!.version);
    await expect(
      openSiblingSlot(
        store,
        address,
        admitted.job.id,
        admitted.job.mainnetRequestHash,
      ),
    ).rejects.toThrow(/PrimaryTerminal/);
    expect(
      await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#1`),
    ).toBeUndefined();
  });

  it("does not claim a launch after the capability row is revoked", async () => {
    const inner = new MemoryStore();
    await seedCapability(inner);
    const fixture = simulatedMainnetRequest();
    await inner.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    const admitted = await admitSupervisedJob(
      inner,
      address,
      "mainnet",
      fixture.prepared.body,
      confirmingLedger,
    );
    let revoked = false;
    const store: Store = {
      get: (pk, sk) => inner.get(pk, sk),
      put: (row, expected) => inner.put(row, expected),
      delete: (pk, sk, expected) => inner.delete(pk, sk, expected),
      list: (pk, prefix) => inner.list(pk, prefix),
      atomicPut: async (writes) => {
        const claiming = writes.some((write) =>
          String(write.row.sk).startsWith("LAUNCH#"),
        );
        if (claiming && !revoked) {
          revoked = true;
          const capability = await inner.get(
            "SYSTEM#QSB_MAINNET_SERVICE",
            "CAPABILITY",
          );
          await inner.put(
            { ...capability!, version: capability!.version + 1, enabled: false },
            capability!.version,
          );
        }
        await inner.atomicPut(writes);
      },
    };
    await expect(
      claimAdmittedLaunch(store, address, admitted.job.id),
    ).rejects.toThrow(/Supervised search capability is not active/);
    expect(
      await inner.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`),
    ).toBeUndefined();
  });

  it("does not drain a sibling that is still launching without a pid", async () => {
    const { store, admitted } = await claimedFixture();
    await openSiblingSlot(store, address, admitted.job.id, admitted.job.mainnetRequestHash);
    const row = await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#1`);
    const launch = row?.launch as { state: string; processId?: string };
    launch.state = "launching";
    delete launch.processId;
    await store.put({ ...row!, launch, version: row!.version + 1 }, row!.version);
    await expect(
      drainSibling(store, address, admitted.job.id, admitted.job.mainnetRequestHash),
    ).rejects.toThrow(/SiblingProcessStillLive/);
    expect(
      (
        (await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#1`))?.launch as {
          state: string;
        }
      ).state,
    ).toBe("launching");
  });

  it("does not drain a sibling whose replacement starts while it is stopping", async () => {
    const { store, admitted } = await claimedFixture();
    await openSiblingSlot(store, address, admitted.job.id, admitted.job.mainnetRequestHash);
    const line = acknowledgementLine(admitted.job.mainnetRequestHash);
    const starter = localAckStarter(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(line)}, () => setTimeout(() => {}, 10000))`,
      ],
      2000,
      admitted.job.mainnetRequestHash,
    );
    const acknowledged = await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      1,
      admitted.job.mainnetRequestHash,
      starter.start,
      new Date(),
      2000,
    );
    await expect(
      drainSibling(
        store,
        address,
        admitted.job.id,
        admitted.job.mainnetRequestHash,
        async () => {
          const row = await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#1`);
          const launch = row?.launch as { state: string; replacement?: string };
          launch.state = "replacing";
          launch.replacement = "starting";
          await store.put({ ...row!, launch, version: row!.version + 1 }, row!.version);
        },
      ),
    ).rejects.toThrow(/ReplaceInProgress/);
    const launch = (
      await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#1`)
    )?.launch as { state: string; processId?: string; evidence?: { outcome?: string } };
    expect(launch.state).toBe("replacing");
    expect(launch.processId).toBe(acknowledged.processId);
    expect(launch.evidence?.outcome).toBeUndefined();
    process.kill(Number(acknowledged.processId), "SIGKILL");
    await Promise.all(starter.exits);
  });

  it("refuses an unfunded vault before writing a job or reservation", async () => {
    const store = new MemoryStore();
    await seedCapability(store);
    const fixture = simulatedMainnetRequest();
    const body = structuredClone(fixture.prepared.body);
    body.request.vault.status = "unfunded";
    delete body.request.vault.funding;
    const parsed = validateRequest(body.request);
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${parsed.vault.id}`,
      version: 0,
      vault: parsed.vault,
    });
    await expect(
      admitSupervisedJob(store, address, "mainnet", body, confirmingLedger),
    ).rejects.toThrow(/Confirmed original mainnet owner, vault and route required/);
    expect(
      [...store.rows.values()].filter(
        (row) =>
          String(row.sk).startsWith("JOB#") || String(row.pk).startsWith("OUTPOINT#"),
      ),
    ).toHaveLength(0);
  });

  it("refuses admission when the funding ledger reports a spent outpoint", async () => {
    const store = new MemoryStore();
    await seedCapability(store);
    const fixture = simulatedMainnetRequest();
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    await expect(
      admitSupervisedJob(store, address, "mainnet", fixture.prepared.body, {
        assertNetwork: async () => undefined,
        unspent: async () => {
          throw new Error("spent");
        },
      }),
    ).rejects.toThrow(/not spendable/);
    expect(
      [...store.rows.values()].filter((row) => String(row.sk).startsWith("JOB#")),
    ).toHaveLength(0);
  });

  it("refuses a claim after the vault is no longer confirmed", async () => {
    const store = new MemoryStore();
    await seedCapability(store);
    const fixture = simulatedMainnetRequest();
    await store.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    const admitted = await admitSupervisedJob(
      store,
      address,
      "mainnet",
      fixture.prepared.body,
      confirmingLedger,
    );
    const row = await store.get(`OWNER#${address}`, `VAULT#${fixture.vault.id}`);
    await store.put(
      {
        ...row!,
        version: row!.version + 1,
        vault: { ...fixture.vault, status: "spent" },
      },
      row!.version,
    );
    await expect(
      claimAdmittedLaunch(store, address, admitted.job.id),
    ).rejects.toThrow(/no longer current/);
    expect(
      await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`),
    ).toBeUndefined();
  });

  it("does not claim a launch when the vault row changes during the claim", async () => {
    const inner = new MemoryStore();
    await seedCapability(inner);
    const fixture = simulatedMainnetRequest();
    await inner.put({
      pk: `OWNER#${address}`,
      sk: `VAULT#${fixture.vault.id}`,
      version: 0,
      vault: fixture.vault,
    });
    const admitted = await admitSupervisedJob(
      inner,
      address,
      "mainnet",
      fixture.prepared.body,
      confirmingLedger,
    );
    let bumped = false;
    const store: Store = {
      get: (pk, sk) => inner.get(pk, sk),
      put: (row, expected) => inner.put(row, expected),
      delete: (pk, sk, expected) => inner.delete(pk, sk, expected),
      list: (pk, prefix) => inner.list(pk, prefix),
      atomicPut: async (writes) => {
        const claiming = writes.some((write) =>
          String(write.row.sk).startsWith("LAUNCH#"),
        );
        if (claiming && !bumped) {
          bumped = true;
          const vault = await inner.get(`OWNER#${address}`, `VAULT#${fixture.vault.id}`);
          await inner.put({ ...vault!, version: vault!.version + 1 }, vault!.version);
        }
        await inner.atomicPut(writes);
      },
    };
    await expect(
      claimAdmittedLaunch(store, address, admitted.job.id),
    ).rejects.toThrow(/no longer current/);
    expect(
      await inner.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`),
    ).toBeUndefined();
  });

  it("invalidates a verified hit when stdout violates after terminal evidence", async () => {
    const { store, admitted, fixture } = await claimedFixture();
    let rejectStdout: (error: Error) => void = () => undefined;
    const stdoutExclusive = new Promise<void>((_resolve, reject) => {
      rejectStdout = reject;
    });
    stdoutExclusive.catch(() => undefined);
    const acknowledged = await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => ({ processId: "terminal-watch", stdoutExclusive }),
      new Date(),
      2000,
    );
    await submitProviderOnce(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => ({ providerId: "simulated-provider" }),
    );
    await publishSimulatedVerifiedHit(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      acknowledged.processId ?? "",
      simulatedFacts,
      fixture.bundle,
    );
    rejectStdout(new Error("AcknowledgementRejected"));
    const started = Date.now();
    let protocol = "";
    while (protocol !== "violated" && Date.now() - started < 2000) {
      protocol =
        (
          (await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`))?.launch as {
            stdoutProtocol?: string;
          }
        ).stdoutProtocol ?? "";
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await expect(
      readAdmittedSolvedBundle(store, address, admitted.job.id),
    ).rejects.toThrow(/stdout protocol/);
    const launch = (
      await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`)
    )?.launch as { evidence?: unknown; stdoutProtocol?: string };
    expect(launch.stdoutProtocol).toBe("violated");
    expect(launch.evidence).toBeUndefined();
  });

  it("promotes a provider-free uncertain launch after replacement", async () => {
    const { store, admitted } = await claimedFixture();
    let rejectStdout: (error: Error) => void = () => undefined;
    const stdoutExclusive = new Promise<void>((_resolve, reject) => {
      rejectStdout = reject;
    });
    stdoutExclusive.catch(() => undefined);
    await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => ({ processId: "uncertain-process", stdoutExclusive }),
      new Date(),
      2000,
    );
    rejectStdout(new Error("AcknowledgementRejected"));
    const started = Date.now();
    let state = "acknowledged";
    while (state !== "uncertain" && Date.now() - started < 2000) {
      state = (
        (await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`))?.launch as {
          state: string;
        }
      ).state;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(state).toBe("uncertain");
    const replaced = await replaceOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => ({ processId: "replacement-after-uncertain" }),
      new Date(),
      2000,
      async () => undefined,
    );
    expect(replaced.state).toBe("acknowledged");
    expect(replaced.stdoutProtocol).toBeUndefined();
    expect(replaced.processId).toBe("replacement-after-uncertain");
    const running = await submitProviderOnce(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => ({ providerId: "after-replacement" }),
    );
    expect(running.state).toBe("running");
    expect(running.providerId).toBe("after-replacement");
  });

  it("reports an uncertain launch with a submitted provider as still running", async () => {
    const { store, admitted } = await claimedFixture();
    let rejectStdout: (error: Error) => void = () => undefined;
    const stdoutExclusive = new Promise<void>((_resolve, reject) => {
      rejectStdout = reject;
    });
    stdoutExclusive.catch(() => undefined);
    await launchOwnedProcess(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => ({ processId: "paid-process", stdoutExclusive }),
      new Date(),
      2000,
    );
    await submitProviderOnce(
      store,
      address,
      admitted.job.id,
      0,
      admitted.job.mainnetRequestHash,
      async () => ({ providerId: "still-billed" }),
    );
    rejectStdout(new Error("AcknowledgementRejected"));
    const started = Date.now();
    let searchRunning = false;
    while (!searchRunning && Date.now() - started < 2000) {
      const job = (await store.get(`OWNER#${address}`, `JOB#${admitted.job.id}`))?.job as {
        status: string;
        runtime: { state: string; searchRunning: boolean };
      };
      searchRunning = job.runtime.searchRunning;
      if (searchRunning) expect(job.status).toBe("searching");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(searchRunning).toBe(true);
    const launch = (
      await store.get(`OWNER#${address}`, `LAUNCH#${admitted.job.id}#0`)
    )?.launch as Parameters<typeof isSearchRunning>[0];
    expect(launch.state).toBe("uncertain");
    expect(isSearchRunning(launch)).toBe(true);
  });
});
