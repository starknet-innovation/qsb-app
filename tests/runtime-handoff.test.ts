import { createHash } from "node:crypto";
import { Signer } from "bip322-js";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { Conflict, MemoryStore } from "../server/store";
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
import { assertServiceChain } from "../server/runtime/capability";
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
  address,
  privateKey,
  publicKey,
  simulatedFacts,
  simulatedMainnetRequest,
} from "./supervised-fixture";

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
  it("keeps the default service closed and rejects the final composition guards", async () => {
    expect(release.mainnetEnabled).toBe(false);
    expect(contract.broadcastAuthorized).toBe(false);
    expect(() => assertServiceChain("testnet4")).toThrow(/not Bitcoin mainnet/);
    const store = new MemoryStore();
    const app = createApp(store);
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
    const app = createApp(store);
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
    await Promise.all(hanging.exits);
  });

  it("records one late provider id after an uncertain paid attempt", async () => {
    const store = new MemoryStore();
    const app = createApp(store);
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
    const app = createApp(store);
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
    );
    await claimAdmittedLaunch(store, address, admitted.job.id);
    const noisy = localAckStarter(
      process.execPath,
      ["-e", "process.stdout.write('package loaded', () => process.exit(0))"],
      2000,
      admitted.job.mainnetRequestHash,
    );
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
    await admitSupervisedJob(store, address, "mainnet", first.prepared.body);
    await expect(
      admitSupervisedJob(store, address, "mainnet", body),
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
});
