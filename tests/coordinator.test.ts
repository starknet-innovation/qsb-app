import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  enabled: true,
  health: vi.fn(),
  run: vi.fn(),
  prepareRun: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  cpu: vi.fn(),
  // Webhook HTTP and DNS: synthetic, never the network.
  transport: vi.fn(async (): Promise<{ status: number }> => {
    throw Error("Unexpected webhook request");
  }),
  resolve: vi.fn(async () => [{ address: "93.184.215.14", family: 4 }]),
}));
vi.mock("../server/webhook-transport", () => ({
  httpsTransport: mocks.transport,
  systemResolver: mocks.resolve,
}));
vi.mock("../src/lib/releases/registry.generated", async () => {
  const { servedFixture, otherFixture } = await import("./solver-fixture");
  return {default:[servedFixture,otherFixture]};
});
vi.mock("../server/gpu-spend", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    // The single-GPU path; parallel search is covered by tests/parallel-search.test.ts.
    gpuSpendLimits: { ...actual.gpuSpendLimits, workersMax: 1, maxJobGpuSeconds: 36000 },
  };
});
vi.mock("../server/network", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, get transactionsEnabled() { return mocks.enabled; } };
});
vi.mock("../server/chain", async (importOriginal) => {
  const actual = await importOriginal<any>();
  const { NETWORK_CONFIG } = await import("../src/lib/network");
  // Answers only the network check, so no test reaches a public Esplora API.
  return {
    ...actual,
    chain: new actual.Esplora("https://chain.test", async (url: any) => {
      if (new URL(String(url)).pathname === "/block-height/0")
        return new Response(NETWORK_CONFIG.genesisHash);
      throw Error(`Unexpected chain lookup ${url}`);
    }),
  };
});
vi.mock("../server/providers",()=>({slipstream:{}}));
vi.mock("../server/compute-provider",()=>({
  computeConfigured:()=>Boolean(process.env.AWS_BATCH_JOB_QUEUE && process.env.AWS_BATCH_JOB_DEFINITION && process.env.AWS_BATCH_JOB_BUCKET),
  configuredCompute:async()=>({health:mocks.health,run:mocks.run,prepareRun:mocks.prepareRun,status:mocks.status,cancel:mocks.cancel}),
}));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    async send() {
      return { SecretString: '{"apiKey":"synthetic-test-key"}' };
    }
  },
  GetSecretValueCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    send = mocks.cpu;
  },
  InvokeCommand: class {
    constructor(public input: any) {}
  },
}));
import { createHash } from "node:crypto";
import { fixtureVault } from "./solver-fixture";
import { pinSolver } from "../src/lib/provenance";
import { handler } from "../server/coordinator";
import { store, MemoryStore } from "../server/store";
import { release, type Job } from "../src/lib/model";
import { workRange } from "../server/search-ranges";
import { EVENT_SETTLE_MS, listOwnerEvents } from "../server/owner-events";
import { registerWebhook } from "../server/webhooks";
import { decideAppRoleAccess } from "./app-role-records";
import {
  ACTIVE_JOBS_SK,
  GPU_SECONDS_SK,
  OWNER_GPU_BUDGET_REACHED,
  claimWithdrawalSlot,
} from "../server/owner-limits";
const event = { owner: "test", jobId: "test-job", revision: 0 };
const pk = "OWNER#test",
  sk = "JOB#test-job";
async function seed(extra: Partial<Job> = {}) {
  const job = {
    computeProvider: "aws-batch",
    id: event.jobId,
    owner: event.owner,
    vaultId: "v",
    revision: 0,
    status: "queued",
    stage: "pinning",
    attempt: 0,
    computeSeconds: 0,
    gpuBudgetReservedSeconds: 0,
    manifestHash: "a".repeat(64),
    manifest: {},
    solver: pinSolver(fixtureVault, "served-test"),
    ...extra,
  } as Job;
  await store.put({ pk, sk, version: 0, job });
  await store.put({
    pk,
    sk: "VAULT#v",
    version: 0,
    vault: fixtureVault,
  });
}
beforeEach(() => {
  mocks.enabled = true;
  (store as MemoryStore).rows.clear();
  vi.clearAllMocks();
  process.env.SOLVER_RELEASE_ID = "served-test";
  process.env.AWS_BATCH_JOB_DEFINITION = "test-arn";
  process.env.AWS_BATCH_JOB_BUCKET = "test-bucket";
  process.env.AWS_BATCH_JOB_QUEUE = "test-queue";
  process.env.REFERENCE_FUNCTION = "test-reference";
  mocks.cpu.mockImplementation(async (command) => ({
    Payload: Buffer.from(
      JSON.stringify(
        JSON.parse(command.input.Payload.toString()).action === "export"
          ? { parameterBase64: "public", parameterSha256: "b".repeat(64) }
          : { valid: false },
      ),
    ),
  }));
  mocks.run.mockResolvedValue({ id: "compute-1" });
  mocks.prepareRun.mockImplementation(async (_image, input) => Object.assign(() => mocks.run(input), {identity: {jobName:"qsb-test",inputSha256:"a".repeat(64),inputKey:"inputs/test.json",queue:"queue",definition:"definition"}}));
});
it("does not submit a paused unknown job that already has one later submission allowed", async () => {
  await seed({
    status: "paused",
    error: "Submission outcome unknown. Reconcile compute provider before resuming.",
    oneSubmissionAllowed: true,
  });
  expect(await handler(event)).toMatchObject({ done: true });
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect((await store.get(pk, sk))?.job).toMatchObject({
    status: "paused",
    oneSubmissionAllowed: true,
  });
});
it("consumes a one-submission allowance before the paid call and does not replay it", async () => {
  await seed({
    oneSubmissionAllowed: true,
    batchReplacementFor: "prior-uncertain-request",
    gpuSubmissions: 7,
    gpuBudgetReservedSeconds: 6300,
  });
  mocks.run.mockRejectedValue(Error("timeout"));
  await expect(handler(event)).rejects.toThrow("timeout");
  expect((await store.get(pk, sk))?.job).toMatchObject({
    gpuSubmissions: 8,
    gpuBudgetReservedSeconds: 7200,
    submissionStartedAt: expect.any(String),
  });
  expect(
    ((await store.get(pk, sk))?.job as Job).oneSubmissionAllowed,
  ).toBeUndefined();
  expect(((await store.get(pk, sk))?.job as Job).batchReplacementFor).toBeUndefined();
  expect(await handler(event)).toMatchObject({ done: true });
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect((await store.get(pk, sk))?.job).toMatchObject({
    status: "paused",
    error: expect.stringContaining("outcome unknown"),
    gpuSubmissions: 8,
    gpuBudgetReservedSeconds: 7200,
  });
  expect(
    ((await store.get(pk, sk))?.job as Job).oneSubmissionAllowed,
  ).toBeUndefined();
});
it("rejects a vault that omits its network before any paid request", async () => {
  await seed();
  const row = await store.get(pk, "VAULT#v");
  await store.put(
    { ...row!, vault: { publicStateJson: "{}" }, version: row!.version + 1 },
    row!.version,
  );
  await expect(handler(event)).rejects.toThrow("VaultNetworkMismatch");
  expect(mocks.run).not.toHaveBeenCalled();
});
it("stops a stale workflow revision before any paid request", async () => {
  await seed({ revision: 1 });
  expect(await handler(event)).toMatchObject({ done: true });
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.status).not.toHaveBeenCalled();
});
it("records submission intent before an ambiguous timeout and does not replay it", async () => {
  await seed();
  mocks.run.mockRejectedValue(Error("timeout"));
  await expect(handler(event)).rejects.toThrow("timeout");
  expect((await store.get(pk, sk))?.job).toMatchObject({ status: "searching" });
  expect(await handler(event)).toMatchObject({ done: true });
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect((await store.get(pk, sk))?.job).toMatchObject({
    status: "paused",
    error: expect.stringContaining("outcome unknown"),
  });
});
it("advances only a fully checked completed range and requests immediate continuation", async () => {
  await seed({ status: "searching", runpodId: "compute-1" });
  mocks.status.mockResolvedValue({
    status: "COMPLETED",
    executionTime: 1000,
    output: {
      status: "completed",
      stage: "pinning",
      manifestHash: "a".repeat(64),
      attempt: 0,
      candidates: [],
      kernelCommit: release.kernelCommit,
      checkpoint: "range-complete",
      workRange: workRange("pinning", 0),
    },
  });
  expect(await handler(event)).toMatchObject({ done: false, waitSeconds: 0 });
  expect((await store.get(pk, sk))?.job).toMatchObject({
    attempt: 1,
    status: "queued",
    computeSeconds: 1,
  });
});
it("resumes an interrupted range without advancing or replaying a still-running request", async () => {
  await seed({ status: "queued", runpodId: "compute-1", retryRequested: true });
  mocks.status.mockResolvedValue({ status: "IN_PROGRESS" });
  await handler(event);
  expect(mocks.run).not.toHaveBeenCalled();
  mocks.status.mockResolvedValue({ status: "TIMED_OUT" });
  await handler(event);
  expect((await store.get(pk, sk))?.job).toMatchObject({
    attempt: 0,
    status: "queued",
  });
  await handler(event);
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(mocks.run.mock.calls[0][0].attempt).toBe(0);
});

it("checks provider credentials without starting work or requiring a funded vault", async () => {
  mocks.health.mockResolvedValue({
    jobs: { inQueue: 0 },
    workers: { running: 0 },
  });
  expect(await handler({ action: "providerHealth" })).toMatchObject({
    provider: "aws-batch", queue: "test-queue",
    health: { jobs: { inQueue: 0 } },
  });
  expect(mocks.run).not.toHaveBeenCalled();
  expect((store as MemoryStore).rows.size).toBe(0);
  await expect(
    handler({ action: "providerHealth", owner: "test" } as any),
  ).rejects.toThrow();
});

function completedOutput(attempt: number, candidates: string[]) {
  return {
    status: "COMPLETED",
    executionTime: 1000,
    output: {
      status: "completed",
      stage: "pinning",
      manifestHash: "a".repeat(64),
      attempt,
      candidates,
      kernelCommit: release.kernelCommit,
      checkpoint: "range-complete",
      workRange: workRange("pinning", attempt),
    },
  };
}

it("does not credit a 64-hit output as a finished range", async () => {
  await seed({ status: "searching", runpodId: "compute-1", attempt: 3 });
  mocks.status.mockResolvedValue(
    completedOutput(3, [
      "sequence=2147483648\nlocktime=500000000\n".repeat(64),
    ]),
  );
  expect(await handler(event)).toMatchObject({ done: true });
  expect(mocks.cpu).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
  expect((await store.get(pk, sk))?.job).toMatchObject({
    attempt: 3,
    stage: "pinning",
    status: "failed",
    computeSeconds: 1,
    error: expect.stringContaining("supported capacity"),
  });
});

it("keeps polling a paused provider request until cancellation is confirmed", async () => {
  await seed({ status: "paused", runpodId: "compute-1" });
  mocks.status.mockResolvedValue({ status: "IN_PROGRESS" });
  mocks.cancel.mockResolvedValue({ status: "CANCELLED" });
  expect(await handler(event)).toMatchObject({ done: false, waitSeconds: 5 });
  expect(mocks.cancel).toHaveBeenCalledWith("compute-1");
  expect(await handler(event)).toMatchObject({ done: false });
  mocks.status.mockResolvedValue({ status: "CANCELLED" });
  expect(await handler(event)).toMatchObject({ done: true });
  expect(mocks.run).not.toHaveBeenCalled();
});

it.each([
  new Error("403"),
  new Error("ProviderLimitsUnconfirmed"),
  new Error("ProviderImageUnconfirmed"),
  new Error("AbortError"),
])(
  "pauses a failed limits preflight without a paid claim: %s",
  async (error) => {
    await seed({ gpuSubmissions: 7, gpuBudgetReservedSeconds: 6300 });
    mocks.prepareRun.mockRejectedValueOnce(error);
    expect(await handler(event)).toMatchObject({ done: true });
    expect(mocks.run).not.toHaveBeenCalled();
    const row = (await store.get(pk, sk))!;
    expect(row.job).toMatchObject({
      status: "paused",
      gpuSubmissions: 7,
      gpuBudgetReservedSeconds: 6300,
      attempt: 0,
      error: expect.stringContaining("nothing was submitted"),
    });
    expect((row.job as Job).runpodId).toBeUndefined();
    await store.put(
      {
        ...row,
        version: row.version + 1,
        job: { ...(row.job as Job), status: "queued" },
      },
      row.version,
    );
    expect(await handler(event)).toMatchObject({ done: false });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect((await store.get(pk, sk))!.job).toMatchObject({
      gpuSubmissions: 8,
      gpuBudgetReservedSeconds: 7200,
      runpodId: "compute-1",
    });
  },
);
it("retains the time budget across a stage transition", async () => {
  await seed({
    stage: "round2",
    attempt: 4828,
    gpuBudgetReservedSeconds: 36000,
  });
  expect(await handler(event)).toMatchObject({ done: true });
  expect(mocks.run).not.toHaveBeenCalled();
  expect((await store.get(pk, sk))!.job).toMatchObject({
    status: "paused",
    gpuBudgetReservedSeconds: 36000,
    error: expect.stringContaining("GPU-time budget reached"),
  });
});
it("counts a failed paid POST as uncertain and never resubmits it", async () => {
  await seed({ gpuSubmissions: 7, gpuBudgetReservedSeconds: 6300 });
  mocks.run.mockRejectedValueOnce(new Error("lost response"));
  await expect(handler(event)).rejects.toThrow("lost response");
  expect((await store.get(pk, sk))!.job).toMatchObject({
    status: "searching",
    gpuSubmissions: 8,
    gpuBudgetReservedSeconds: 7200,
  });
  await handler(event);
  expect(mocks.run).toHaveBeenCalledOnce();
  expect((await store.get(pk, sk))!.job).toMatchObject({
    status: "paused",
    error: expect.stringContaining("outcome unknown"),
  });
});

it.each(["FAILED", "CANCELLED", "TIMED_OUT"])(
  "exhausts repeated %s retries without refunding time",
  async (terminal) => {
    await seed({ gpuBudgetReservedSeconds: 34200 });
    for (let i = 0; i < 2; i++) {
      await handler(event);
      mocks.status.mockResolvedValue({ status: terminal, executionTime: 1 });
      await handler(event);
      const row = (await store.get(pk, sk))!;
      expect(row.job).toMatchObject({
        status: "paused",
        gpuBudgetReservedSeconds: 35100 + i * 900,
      });
      await store.put(
        {
          ...row,
          version: row.version + 1,
          job: { ...(row.job as Job), status: "queued", retryRequested: true },
        },
        row.version,
      );
      await handler(event); // Reconcile the terminal ID before any replacement.
    }
    await handler(event);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect((await store.get(pk, sk))!.job).toMatchObject({
      status: "paused",
      gpuBudgetReservedSeconds: 36000,
      error: expect.stringContaining("GPU-time budget reached"),
    });
  },
);
it("journals the final 900-second reservation before the paid POST", async () => {
  await seed({ gpuBudgetReservedSeconds: 35100 });
  mocks.run.mockImplementationOnce(async () => {
    expect((await store.get(pk, sk))!.job).toMatchObject({
      status: "searching",
      gpuBudgetReservedSeconds: 36000,
    });
    return { id: "last-job" };
  });
  await handler(event);
  expect(mocks.run).toHaveBeenCalledOnce();
});
it("rejects a submission with only 899 seconds remaining before preflight", async () => {
  await seed({ gpuBudgetReservedSeconds: 35101 });
  await handler(event);
  expect(mocks.prepareRun).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});
it("does not refund a short successful range", async () => {
  await seed({
    status: "searching",
    runpodId: "last-job",
    gpuBudgetReservedSeconds: 36000,
  });
  mocks.status.mockResolvedValue(completedOutput(0, []));
  await handler(event);
  await handler(event);
  expect(mocks.run).not.toHaveBeenCalled();
  expect((await store.get(pk, sk))!.job).toMatchObject({
    status: "paused",
    computeSeconds: 1,
    gpuBudgetReservedSeconds: 36000,
  });
});

it("preserves the exhausted reservation through the authenticated resume route", async () => {
  const { createApp } = await import("../server/app");
  const { Signer } = await import("bip322-js");
  const btc = await import("@scure/btc-signer");
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  const key = new Uint8Array(32).fill(1);
  const owner = btc.p2wpkh(secp256k1.getPublicKey(key)).address!;
  const ownerPk = `OWNER#${owner}`;
  const app = createApp(store, { enabled: true });
  const req = (path: string, body: unknown, token?: string) =>
    new Request(`http://localhost/api${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const challenge = await (
    await app.request(req("/auth/challenge", { address: owner }))
  ).json();
  const login = await app.request(
    req("/auth/verify", {
      id: challenge.id,
      signature: Signer.sign(btc.WIF().encode(key), owner, challenge.message),
    }),
  );
  expect(login.status).toBe(200);
  const { token } = await login.json();
  await seed({ status: "paused", gpuBudgetReservedSeconds: 36000 });
  const row = (await store.get(pk, sk))!;
  await store.put({ ...row, pk: ownerPk, job: { ...(row.job as Job), owner } });
  await store.put({ ...(await store.get(pk, "VAULT#v"))!, pk: ownerPk });
  const response = await app.request(
    req(`/jobs/${event.jobId}/resume`, {}, token),
  );
  expect(response.status).toBe(202);
  expect((await store.get(ownerPk, sk))!.job).toMatchObject({
    revision: 1,
    gpuBudgetReservedSeconds: 36000,
  });
  await handler({ ...event, owner, revision: 1 });
  expect(mocks.run).not.toHaveBeenCalled();
  expect((await store.get(ownerPk, sk))!.job).toMatchObject({
    status: "paused",
    gpuBudgetReservedSeconds: 36000,
  });
});
it("retains the reservation when a verified pin advances to round1", async () => {
  await seed({
    status: "searching",
    runpodId: "last-job",
    gpuBudgetReservedSeconds: 36000,
  });
  mocks.status.mockResolvedValue(completedOutput(0, []));
  const range = workRange("pinning", 0);
  mocks.cpu.mockResolvedValueOnce({
    Payload: Buffer.from(
      JSON.stringify({
        valid: true,
        sequence: range.sequence,
        locktime: range.locktime,
      }),
    ),
  });
  await handler(event);
  expect((await store.get(pk, sk))!.job).toMatchObject({
    stage: "round1",
    attempt: 0,
    gpuBudgetReservedSeconds: 36000,
  });
  await handler(event);
  expect(mocks.run).not.toHaveBeenCalled();
});

it("routes an external descriptor through submission and CPU verification without CUDA pins", async () => {
  process.env.SOLVER_RELEASE_ID = "external-test";
  const vault = {
    network: "mainnet",
    config: "A",
    scriptHex: "51",
    scriptHash: createHash("sha256")
      .update(Buffer.from("51", "hex"))
      .digest("hex"),
    publicStateJson: "{}",
  };
  const pin = pinSolver(vault, "external-test");
  expect(pin.descriptor).not.toHaveProperty("sourceHashes");
  await seed({ solver: pin });
  await store.put({ pk, sk: "VAULT#v", version: 1, vault }, 0);
  await handler(event);
  expect(mocks.prepareRun).toHaveBeenCalledWith(pin.descriptor.image, expect.any(Object));
  expect(mocks.run).toHaveBeenCalledWith(
    expect.objectContaining({
      kernelCommit: "b".repeat(40),
      searchVersion: "ranked-v2",
    }),
  );
  mocks.status.mockResolvedValue({
    status: "COMPLETED",
    executionTime: 1000,
    output: {
      status: "completed",
      stage: "pinning",
      manifestHash: "a".repeat(64),
      attempt: 0,
      candidates: ["public-hit"],
      kernelCommit: "b".repeat(40),
      checkpoint: "range-complete",
      workRange: workRange("pinning", 0),
    },
  });
  mocks.cpu.mockResolvedValue({
    Payload: Buffer.from(
      JSON.stringify({
        valid: true,
        sequence: 2147483648,
        locktime: 500000000,
      }),
    ),
  });
  await handler(event);
  expect(
    JSON.parse(mocks.cpu.mock.calls.at(-1)![0].input.Payload.toString()),
  ).toMatchObject({ action: "verify", candidates: ["public-hit"] });
  expect((await store.get(pk, sk))?.job).toMatchObject({
    stage: "round1",
    solution: { sequence: 2147483648, locktime: 500000000 },
  });
});
it("rejects worker identity mismatch before invoking the CPU verifier", async () => {
  await seed({ status: "searching", runpodId: "compute-1" });
  mocks.status.mockResolvedValue({
    status: "COMPLETED",
    output: {
      status: "completed",
      stage: "pinning",
      manifestHash: "a".repeat(64),
      attempt: 0,
      candidates: [],
      kernelCommit: "b".repeat(40),
      checkpoint: "range-complete",
      workRange: workRange("pinning", 0),
    },
  });
  await expect(handler(event)).rejects.toThrow("CandidateContextMismatch");
  expect(mocks.cpu).not.toHaveBeenCalled();
});

it("rejects a deployment release mismatch before reserving paid time", async () => {
  await seed();
  process.env.SOLVER_RELEASE_ID = "external-test";
  await handler(event);
  expect(mocks.prepareRun).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
  expect((await store.get(pk,sk))!.job).toMatchObject({status:"paused",gpuBudgetReservedSeconds:0});
});
it("still polls a paid job after the served release changes", async () => {
  await seed({status:"searching",runpodId:"paid-existing"});
  process.env.SOLVER_RELEASE_ID = "external-test";
  mocks.status.mockResolvedValue({status:"IN_PROGRESS"});
  await handler(event);
  expect(mocks.status).toHaveBeenCalledWith("paid-existing", undefined);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.prepareRun).not.toHaveBeenCalled();
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect((await store.get(pk,sk))!.job).toMatchObject({status:"searching",runpodId:"paid-existing"});
});

it.each(["queued", "searching"] as const)("deployment switch pauses %s without losing paid IDs or resubmitting after resume", async (status) => {
  const frozen = {
    status,
    runpodId: "already-paid",
    submissionStartedAt: "2026-09-25T00:00:00.000Z",
    gpuSubmissions: 7,
    gpuBudgetReservedSeconds: 6300,
    parameterHashes: { pinning: "c".repeat(64) },
    attempt: 3,
  };
  await seed(frozen);
  const reservation = {pk:"OUTPOINT#reserved",sk:"RESERVATION",version:0,jobId:event.jobId};
  await store.put(reservation);
  const before = (await store.get(pk, sk))!;
  mocks.enabled = false;
  expect(await handler(event)).toMatchObject({done:true});
  const paused = (await store.get(pk, sk))!;
  expect(paused.job).toEqual({...before.job as Job,status:"paused",error:"Mainnet disabled by deployment."});
  expect(await store.get(reservation.pk,reservation.sk)).toEqual(reservation);
  for (const fn of [mocks.prepareRun,mocks.run,mocks.status,mocks.cancel,mocks.cpu]) expect(fn).not.toHaveBeenCalled();
  // The existing resume route advances revision and changes paused to queued.
  const resumed = {...paused.job as Job,status:"queued",revision:1,retryRequested:true};
  delete resumed.error;
  await store.put({...paused,version:paused.version+1,job:resumed},paused.version);
  mocks.enabled = true;
  mocks.status.mockResolvedValue({status:"IN_PROGRESS"});
  expect(await handler({...event,revision:1})).toMatchObject({done:false,waitSeconds:5});
  expect(mocks.status).toHaveBeenCalledWith("already-paid", undefined);
  expect(mocks.prepareRun).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect((await store.get(pk,sk))!.job).toMatchObject({...frozen,status:"searching",revision:1});
  expect(await store.get(reservation.pk,reservation.sk)).toEqual(reservation);
});
it("deployment pause preserves unknown-submission blockers", async () => {
  await seed({status:"queued",submissionStartedAt:"2026-09-25T00:00:00.000Z",error:"Submission outcome unknown. Reconcile compute provider before resuming."});
  mocks.enabled = false;
  await handler(event);
  const paused = (await store.get(pk,sk))!;
  expect(paused.job).toMatchObject({status:"paused",submissionStartedAt:"2026-09-25T00:00:00.000Z",error:expect.stringContaining("Submission outcome unknown")});
  await handler(event);
  expect((await store.get(pk,sk))!.job).toEqual(paused.job);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.cancel).not.toHaveBeenCalled();
});

it("pauses an unstarted queued job and submits it only after an explicit enabled resume", async () => {
  await seed();
  mocks.enabled = false;
  await handler(event);
  const paused = (await store.get(pk,sk))!;
  expect(paused.job).toMatchObject({status:"paused",attempt:0,gpuBudgetReservedSeconds:0});
  expect(paused.job).not.toHaveProperty("submissionStartedAt");
  expect(paused.job).not.toHaveProperty("runpodId");
  expect(mocks.run).not.toHaveBeenCalled();
  mocks.enabled = true;
  // Re-enabling alone does not start an intentionally paused job.
  await handler(event);
  expect(mocks.run).not.toHaveBeenCalled();
  await store.put({...paused,version:paused.version+1,job:{...paused.job as Job,status:"queued",revision:1,retryRequested:true}},paused.version);
  await handler({...event,revision:1});
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect((await store.get(pk,sk))!.job).toMatchObject({runpodId:"compute-1",gpuSubmissions:1,gpuBudgetReservedSeconds:900});
});

it("marks a searching job with a lost POST response unknown before deployment pause", async () => {
  await seed({status:"searching",submissionStartedAt:"2026-09-25T00:00:00.000Z",gpuSubmissions:7,gpuBudgetReservedSeconds:6300,oneSubmissionAllowed:true});
  mocks.enabled = false;
  await handler(event);
  const paused = (await store.get(pk,sk))!;
  expect(paused.job).toMatchObject({status:"paused",submissionStartedAt:"2026-09-25T00:00:00.000Z",gpuSubmissions:7,gpuBudgetReservedSeconds:6300,error:expect.stringContaining("Submission outcome unknown")});
  expect(paused.job).not.toHaveProperty("oneSubmissionAllowed");
  expect(paused.job).not.toHaveProperty("runpodId");
  mocks.enabled = true;
  const { createApp } = await import("../server/app");
  const { createHash } = await import("node:crypto");
  const token = "a".repeat(43);
  await store.put({pk:`SESSION#${createHash("sha256").update(token).digest("hex")}`,sk:"AUTH",version:0,owner:event.owner,network:"mainnet"});
  const response = await createApp(store).request(`/api/jobs/${event.jobId}/resume`, {method:"POST",headers:{Authorization:`Bearer ${token}`}});
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({error:"Reconcile the unknown compute provider submission before retrying.",code:"reconcile_required"});
  await handler(event);
  expect(mocks.prepareRun).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});

it.each(["IN_QUEUE", "IN_PROGRESS"])("resumed paid job polls %s with a five-second wait", async (status) => {
  await seed({status:"queued",runpodId:"already-paid",retryRequested:true});
  mocks.status.mockResolvedValue({status});
  expect(await handler(event)).toMatchObject({done:false,waitSeconds:5});
  expect((await store.get(pk,sk))!.job).toMatchObject({status:"searching",runpodId:"already-paid"});
  expect(mocks.prepareRun).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});
it("persists resumed polling state before a transient provider failure", async () => {
  await seed({status:"queued",runpodId:"already-paid",retryRequested:true});
  mocks.status.mockRejectedValueOnce(new Error("HTTP 429"));
  await expect(handler(event)).rejects.toThrow("HTTP 429");
  expect((await store.get(pk,sk))!.job).toMatchObject({status:"searching",runpodId:"already-paid"});
  mocks.status.mockResolvedValue({status:"IN_PROGRESS"});
  expect(await handler(event)).toMatchObject({done:false,waitSeconds:5});
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.prepareRun).not.toHaveBeenCalled();
});

it('pauses a legacy provider ID without contacting AWS or resubmitting', async () => {
  await seed({status:'searching',runpodId:'legacy-paid',computeProvider:undefined});
  await handler(event);
  expect((await store.get(pk,sk))!.job).toMatchObject({status:'paused',runpodId:'legacy-paid',error:'Legacy provider job requires reconciliation before AWS migration.'});
  expect(mocks.status).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});

it("persists the request identity in the same paid intent before calling SubmitJob", async () => {
  await seed();
  mocks.run.mockImplementationOnce(async () => {
    const job = (await store.get(pk, sk))!.job as Job;
    expect(job).toMatchObject({status:"searching",computeProvider:"aws-batch",batchSubmission:{jobName:"qsb-test",inputSha256:"a".repeat(64)},gpuSubmissions:1,gpuBudgetReservedSeconds:900});
    throw Error("lost response");
  });
  await expect(handler(event)).rejects.toThrow("lost response");
  expect((await store.get(pk,sk))!.job).toHaveProperty("batchSubmission.jobName", "qsb-test");
});

it.each(["AWS_BATCH_JOB_QUEUE", "REFERENCE_FUNCTION"])("preserves uncertain POST through missing %s and refuses resume", async (setting) => {
  await seed({status:"searching",submissionStartedAt:"2026-09-25T00:00:00.000Z",gpuSubmissions:7,gpuBudgetReservedSeconds:6300,oneSubmissionAllowed:true});
  const prior = process.env[setting];
  delete process.env[setting];
  await handler(event);
  const paused = (await store.get(pk,sk))!;
  expect(paused.job).toMatchObject({status:"paused",submissionStartedAt:"2026-09-25T00:00:00.000Z",gpuSubmissions:7,gpuBudgetReservedSeconds:6300,error:expect.stringContaining("Submission outcome unknown")});
  expect(paused.job).not.toHaveProperty("oneSubmissionAllowed");
  expect(paused.job).not.toHaveProperty("runpodId");
  process.env[setting] = prior;
  const { createApp } = await import("../server/app");
  const { createHash } = await import("node:crypto");
  const token = "a".repeat(43);
  await store.put({pk:`SESSION#${createHash("sha256").update(token).digest("hex")}`,sk:"AUTH",version:0,owner:event.owner,network:"mainnet"});
  const response = await createApp(store).request(`/api/jobs/${event.jobId}/resume`, {method:"POST",headers:{Authorization:`Bearer ${token}`}});
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({error:"Reconcile the unknown compute provider submission before retrying.",code:"reconcile_required"});
  await handler(event);
  expect(mocks.prepareRun).not.toHaveBeenCalled();
  expect(mocks.run).not.toHaveBeenCalled();
});

it.each(["configuration", "prepare"])("retains pending request allowance during %s failure before paid intent", async (failure) => {
  await seed({ batchReplacementFor: "qsb-prior-request" });
  if (failure === "configuration") delete process.env.AWS_BATCH_JOB_QUEUE;
  else mocks.prepareRun.mockRejectedValue(new Error("preparation failed"));
  await handler(event);
  expect(((await store.get(pk, sk))!.job as Job).batchReplacementFor).toBe("qsb-prior-request");
  expect(mocks.run).not.toHaveBeenCalled();
});

describe("owner events and webhooks", () => {
  const events = async () =>
    (await listOwnerEvents(store, event.owner, { limit: 100 }, Date.now() + EVENT_SETTLE_MS + 1000)).events;
  async function tick(hooked: boolean, faults?: () => () => void) {
    (store as MemoryStore).rows.clear();
    mocks.run.mockClear();
    await seed();
    if (hooked) await registerWebhook(store, event.owner, { url: "https://hooks.example.com/" }, mocks.resolve);
    const restore = faults?.();
    const started = Date.now();
    const result = await handler(event).catch((error: Error) => ({ threw: error.message }));
    const elapsed = Date.now() - started;
    restore?.();
    const { updatedAt, submissionStartedAt, ...job } = (await store.get(pk, sk))!.job as Job;
    return { outcome: { result, job, runs: mocks.run.mock.calls.length }, elapsed };
  }
  /** The table failing under the webhook work: the WEBHOOKS row or an EVENT# write. */
  const fault = (target: string, mode: string) => () => {
    const memory = store as MemoryStore;
    const get = MemoryStore.prototype.get.bind(memory),
      put = MemoryStore.prototype.put.bind(memory);
    const fail = () =>
      mode === "hangs" ? new Promise<never>(() => {}) : Promise.reject(Error("AccessDeniedException"));
    const reads = vi.spyOn(memory, "get").mockImplementation((key, sort) =>
      target === "WEBHOOKS get" && sort === "WEBHOOKS" ? fail() : get(key, sort),
    );
    const writes = vi.spyOn(memory, "put").mockImplementation((row, expected, options) =>
      (target === "WEBHOOKS put" && row.sk === "WEBHOOKS") ||
      (target === "EVENT put" && row.sk.startsWith("EVENT#"))
        ? fail()
        : put(row, expected, options),
    );
    return () => {
      reads.mockRestore();
      writes.mockRestore();
    };
  };

  it("records the tick's status change once", async () => {
    await seed();
    await handler(event);
    mocks.status.mockResolvedValue({ status: "IN_PROGRESS" });
    await handler(event);
    expect((await events()).map((e) => [e.type, e.subjectId, e.stage])).toEqual([
      ["withdrawal.searching", event.jobId, "pinning"],
    ]);
  });

  it.each(["throws", "hangs"])("a webhook receiver that %s changes nothing in a tick", async (mode) => {
    mocks.transport.mockImplementation(
      mode === "hangs" ? () => new Promise(() => {}) : async () => { throw Error("ECONNRESET"); },
    );
    const plain = await tick(false);
    const hooked = await tick(true);
    // Coordinator delivery has a two-second budget, less than the API's.
    expect(hooked.elapsed).toBeLessThan(2500);
    expect(hooked.outcome).toEqual(plain.outcome);
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    expect((await events()).map((e) => e.type)).toEqual(["withdrawal.searching"]);
  }, 15_000);

  it("a tick that throws still throws the same error after recording", async () => {
    await seed();
    await registerWebhook(store, event.owner, { url: "https://hooks.example.com/" }, mocks.resolve);
    mocks.transport.mockResolvedValue({ status: 204 });
    mocks.run.mockRejectedValueOnce(Error("lost response"));
    await expect(handler(event)).rejects.toThrow("lost response");
    expect((await store.get(pk, sk))!.job).toMatchObject({ status: "searching" });
    expect(mocks.transport).toHaveBeenCalledTimes(1);
  });

  it("uses only GetItem and PutItem on the owner's OWNER# and WEBHOOK# rows, as the coordinator role allows", async () => {
    await seed();
    await registerWebhook(store, event.owner, { url: "https://hooks.example.com/" }, mocks.resolve);
    mocks.transport.mockResolvedValue({ status: 500 });
    const memory = store as MemoryStore;
    const puts = vi.spyOn(memory, "put"),
      gets = vi.spyOn(memory, "get");
    const other = [vi.spyOn(memory, "list"), vi.spyOn(memory, "atomicPut"), vi.spyOn(memory, "delete")];
    await handler(event);
    expect(mocks.transport).toHaveBeenCalledTimes(1);
    for (const spy of other) expect(spy).not.toHaveBeenCalled();
    const keys = [...puts.mock.calls.map(([row]) => row.pk), ...gets.mock.calls.map(([key]) => key)];
    const webhooks = `WEBHOOK#${event.owner}`;
    expect(new Set(keys)).toEqual(new Set([pk, webhooks]));
    for (const key of [pk, webhooks]) {
      expect(decideAppRoleAccess("dynamodb:PutItem", [key], "coordinator")).toBe("allow");
      expect(decideAppRoleAccess("dynamodb:GetItem", [key], "coordinator")).toBe("allow");
    }
    for (const spy of [puts, gets, ...other]) spy.mockRestore();
  });

  it.each(["WEBHOOKS get", "WEBHOOKS put", "EVENT put"])(
    "a failing or hanging %s changes nothing in a tick",
    async (target) => {
      mocks.transport.mockResolvedValue({ status: 204 });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const plain = await tick(false);
      for (const mode of ["throws", "hangs"]) {
        const faulted = await tick(true, fault(target, mode));
        expect(faulted.outcome).toEqual(plain.outcome);
        expect(faulted.elapsed).toBeLessThan(3500);
      }
      // A tick that fails still fails with its own error.
      mocks.run.mockRejectedValueOnce(Error("lost response"));
      const failing = await tick(true, fault(target, "throws"));
      expect(failing.outcome.result).toEqual({ threw: "lost response" });
    },
    20_000,
  );

  it("writes no event row between the paid intent and its POST", async () => {
    await seed();
    const order: string[] = [];
    const memory = store as MemoryStore;
    const put = MemoryStore.prototype.put.bind(memory);
    const puts = vi.spyOn(memory, "put").mockImplementation(async (row, expected, options) => {
      await put(row, expected, options);
      order.push(row.sk.startsWith("EVENT#") ? "event" : `${row.sk.split("#")[0]}:${(row.job as Job | undefined)?.status}`);
    });
    mocks.run.mockImplementationOnce(async () => {
      order.push("POST");
      return { id: "compute-1" };
    });
    await handler(event);
    puts.mockRestore();
    const post = order.indexOf("POST");
    expect(order[post - 1]).toBe("JOB:searching");
    expect(order.slice(0, post)).not.toContain("event");
    expect(order.slice(post)).toContain("event");
  });

  it("queues webhooks when there's no time to send them, and the next tick sends them", async () => {
    await seed();
    await registerWebhook(store, event.owner, { url: "https://hooks.example.com/" }, mocks.resolve);
    mocks.transport.mockResolvedValue({ status: 204 });
    expect(await handler(event, { getRemainingTimeInMillis: () => 20_000 })).toMatchObject({ done: false });
    expect(mocks.transport).not.toHaveBeenCalled();
    expect(((await store.get(`WEBHOOK#${event.owner}`, "WEBHOOKS"))!.pending as { event: { type: string } }[]).map((p) => p.event.type)).toEqual(["withdrawal.searching"]);
    mocks.status.mockResolvedValue({ status: "IN_PROGRESS" });
    await handler(event);
    expect(mocks.transport).toHaveBeenCalledOnce();
    expect((await store.get(`WEBHOOK#${event.owner}`, "WEBHOOKS"))!.pending).toEqual([]);
  });

  it("skips delivery unless the Lambda has ample time left, and still records", async () => {
    await seed();
    await registerWebhook(store, event.owner, { url: "https://hooks.example.com/" }, mocks.resolve);
    expect(await handler(event, { getRemainingTimeInMillis: () => 20_000 })).toMatchObject({ done: false });
    expect(mocks.transport).not.toHaveBeenCalled();
    expect((await events()).map((e) => e.type)).toEqual(["withdrawal.searching"]);
  });
});

describe("owner limits", () => {
  const budgetRow = () => store.get(pk, GPU_SECONDS_SK);
  const job = async () => (await store.get(pk, sk))!.job as Job;
  const withBudget = async (reservedSeconds: number) =>
    store.put({ pk, sk: GPU_SECONDS_SK, version: 0, reservedSeconds });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("writes no owner row and changes nothing when the switches are unset", async () => {
    await seed();
    await handler(event);
    expect(mocks.run).toHaveBeenCalledOnce();
    expect([...(store as MemoryStore).rows.keys()].filter((k) => k.includes("LIMIT#"))).toEqual([]);
    expect(await job()).not.toHaveProperty("ownerGpuChargedSeconds");
  });

  it("charges the owner in the same conditional write as the per-job reservation, before the POST", async () => {
    vi.stubEnv("QSB_OWNER_MAX_GPU_SECONDS", "36000");
    await seed();
    const atomicPut = vi.spyOn(store, "atomicPut");
    mocks.run.mockImplementationOnce(async () => {
      expect(await job()).toMatchObject({ status: "searching", gpuBudgetReservedSeconds: 900, ownerGpuChargedSeconds: 900 });
      expect(await budgetRow()).toMatchObject({ version: 0, reservedSeconds: 900 });
      return { id: "compute-1" };
    });
    await handler(event);
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(atomicPut).toHaveBeenCalledOnce();
    const [writes] = atomicPut.mock.calls[0];
    expect(writes.filter((w) => !w.row.sk.startsWith("EVENT#")).map((w) => [w.row.sk, w.expected])).toEqual([
      [sk, 0],
      [GPU_SECONDS_SK, undefined],
    ]);
    // The paid intent's owner event rides in that transaction: no separate write before the POST.
    expect(writes.filter((w) => w.row.sk.startsWith("EVENT#")).map((w) => (w.row.event as { type: string }).type)).toEqual(["withdrawal.searching"]);
    expect(atomicPut.mock.invocationCallOrder[0]).toBeLessThan(mocks.run.mock.invocationCallOrder[0]);
    expect(await job()).toMatchObject({ runpodId: "compute-1", gpuSubmissions: 1, ownerGpuChargedSeconds: 900 });
  });

  it.each(["allowlist", "budget"])("records the pause when the owner %s stops a withdrawal", async (limit) => {
    if (limit === "allowlist") vi.stubEnv("QSB_OWNER_ALLOWLIST", "someone-else");
    else vi.stubEnv("QSB_OWNER_MAX_GPU_SECONDS", "36000");
    await seed();
    if (limit === "budget") await withBudget(35101);
    expect(await handler(event)).toMatchObject({ done: true });
    expect(await job()).toMatchObject({ status: "paused" });
    const { events } = await listOwnerEvents(store, event.owner, { limit: 10 }, Date.now() + EVENT_SETTLE_MS + 1000);
    expect(events.map((e) => [e.type, e.subjectId])).toEqual([["withdrawal.paused", event.jobId]]);
  });

  it("pauses before preparing when the owner budget is used, like the per-job cap", async () => {
    vi.stubEnv("QSB_OWNER_MAX_GPU_SECONDS", "36000");
    await seed();
    await withBudget(35101);
    expect(await handler(event)).toMatchObject({ done: true });
    expect(mocks.prepareRun).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({ status: "paused", error: OWNER_GPU_BUDGET_REACHED, gpuBudgetReservedSeconds: 0 });
    expect(await budgetRow()).toMatchObject({ version: 0, reservedSeconds: 35101 });
  });

  it("never loosens the per-job cap", async () => {
    vi.stubEnv("QSB_OWNER_MAX_GPU_SECONDS", "1000000000");
    await seed({ gpuBudgetReservedSeconds: 35101 });
    await handler(event);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({ status: "paused", error: expect.stringMatching(/^GPU-time budget reached/) });
    expect(await budgetRow()).toBeUndefined();
  });

  it("charges a job started before the limit its earlier reservations", async () => {
    vi.stubEnv("QSB_OWNER_MAX_GPU_SECONDS", "36000");
    await seed({ gpuSubmissions: 7, gpuBudgetReservedSeconds: 6300 });
    await handler(event);
    expect(await job()).toMatchObject({ gpuBudgetReservedSeconds: 7200, ownerGpuChargedSeconds: 7200 });
    expect(await budgetRow()).toMatchObject({ reservedSeconds: 7200 });
  });

  it.each([
    [1000, 1900, true],
    [35500, 35500, false],
  ])("re-reads the budget when another withdrawal of the owner reserves first (%s)", async (other, total, submits) => {
    vi.stubEnv("QSB_OWNER_MAX_GPU_SECONDS", "36000");
    await seed();
    const real = store.atomicPut.bind(store);
    vi.spyOn(store, "atomicPut").mockImplementationOnce(async (writes) => {
      await withBudget(other);
      return real(writes);
    });
    await handler(event);
    expect(mocks.run).toHaveBeenCalledTimes(submits ? 1 : 0);
    expect(await budgetRow()).toMatchObject({ reservedSeconds: total });
    expect(await job()).toMatchObject(
      submits
        ? { status: "searching", runpodId: "compute-1", ownerGpuChargedSeconds: 900 }
        : { status: "paused", error: OWNER_GPU_BUDGET_REACHED, gpuBudgetReservedSeconds: 0 },
    );
  });

  it("writes neither row when the transaction fails, and sends nothing", async () => {
    vi.stubEnv("QSB_OWNER_MAX_GPU_SECONDS", "36000");
    await seed();
    vi.spyOn(store, "atomicPut").mockRejectedValueOnce(new Error("AccessDenied"));
    await expect(handler(event)).rejects.toThrow("AccessDenied");
    expect(mocks.run).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({ status: "queued", gpuBudgetReservedSeconds: 0 });
    expect(await budgetRow()).toBeUndefined();
  });

  it("still polls and credits in-flight work with the budget used, and never resubmits it", async () => {
    vi.stubEnv("QSB_OWNER_MAX_GPU_SECONDS", "900");
    await seed({ status: "searching", runpodId: "compute-1", gpuBudgetReservedSeconds: 900, ownerGpuChargedSeconds: 900 });
    await withBudget(900);
    mocks.status.mockResolvedValue({ status: "IN_PROGRESS" });
    expect(await handler(event)).toMatchObject({ done: false });
    mocks.status.mockResolvedValue(completedOutput(0, []));
    await handler(event);
    expect(await job()).toMatchObject({ status: "queued", attempt: 1, computeSeconds: 1 });
    await handler(event);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.prepareRun).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({ status: "paused", error: OWNER_GPU_BUDGET_REACHED });
    expect(await budgetRow()).toMatchObject({ version: 0, reservedSeconds: 900 });
  });

  it("keeps the owner's charge for a POST whose outcome is unknown, and never replays it", async () => {
    vi.stubEnv("QSB_OWNER_MAX_GPU_SECONDS", "36000");
    await seed();
    mocks.run.mockRejectedValueOnce(Error("timeout"));
    await expect(handler(event)).rejects.toThrow("timeout");
    await handler(event);
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(await job()).toMatchObject({ status: "paused", error: expect.stringContaining("outcome unknown"), ownerGpuChargedSeconds: 900 });
    expect(await budgetRow()).toMatchObject({ version: 0, reservedSeconds: 900 });
  });

  it.each([
    ["36000s", "positive integer"],
    ["899", "at least 900"],
  ])("pauses before any paid request when the owner budget setting is %s", async (value, reason) => {
    vi.stubEnv("QSB_OWNER_MAX_GPU_SECONDS", value);
    await seed();
    await handler(event);
    expect(mocks.prepareRun).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(await job()).toMatchObject({
      status: "paused",
      error: expect.stringMatching(new RegExp(`QSB_OWNER_MAX_GPU_SECONDS must be .*${reason}.* Nothing was submitted\\.`)),
    });
  });

  it.each([
    ["listed", "someone-else,test", true],
    ["not listed", "someone-else", false],
  ])("submits for an owner %s on the allowlist only", async (_, list, submits) => {
    vi.stubEnv("QSB_OWNER_ALLOWLIST", list);
    await seed({ status: "searching", runpodId: "compute-1" });
    mocks.status.mockResolvedValue(completedOutput(0, []));
    await handler(event);
    if (!submits) {
      expect(mocks.status).not.toHaveBeenCalled();
      expect(await job()).toMatchObject({ status: "paused", runpodId: "compute-1", error: "Wallet is not allowed by deployment configuration." });
      return;
    }
    await handler(event);
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it("releases the owner's withdrawal slot when the search fails", async () => {
    await seed({ status: "searching", runpodId: "compute-1" });
    expect(await claimWithdrawalSlot(store, "test", "next", 1, 0)).toBeUndefined();
    mocks.status.mockResolvedValue(completedOutput(0, ["sequence=2147483648\nlocktime=500000000\n".repeat(64)]));
    await handler(event);
    expect(await job()).toMatchObject({ status: "failed" });
    expect(await claimWithdrawalSlot(store, "test", "next", 1, 0)).toMatchObject({ row: { sk: ACTIVE_JOBS_SK } });
  });

  it("releases the owner's withdrawal slot when the search finishes", async () => {
    const indices = [149, 148, 147, 146, 145, 144, 143, 142, 141];
    await seed({
      status: "searching",
      runpodId: "compute-1",
      stage: "round2",
      solution: { sequence: 2147483648, locktime: 500000000, round1: indices, round2: [] },
    });
    expect(await claimWithdrawalSlot(store, "test", "next", 1, 0)).toBeUndefined();
    const done = completedOutput(0, ["public-hit"]);
    mocks.status.mockResolvedValue({ ...done, output: { ...done.output, stage: "round2", workRange: workRange("round2", 0) } });
    mocks.cpu.mockResolvedValue({ Payload: Buffer.from(JSON.stringify({ valid: true, indices })) });
    await handler(event);
    expect(await job()).toMatchObject({ status: "awaiting_authorization", stage: "verification" });
    expect(await claimWithdrawalSlot(store, "test", "next", 1, 0)).toMatchObject({ row: { sk: ACTIVE_JOBS_SK } });
  });
});
