import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  enabled: true,
  health: vi.fn(),
  run: vi.fn(),
  prepareRun: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  cpu: vi.fn(),
}));
vi.mock("../src/lib/releases/registry.generated", async () => {
  const { servedFixture, otherFixture } = await import("./solver-fixture");
  return {default:[servedFixture,otherFixture]};
});
vi.mock("../server/gpu-spend", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    gpuSpendLimits: { ...actual.gpuSpendLimits, maxJobGpuSeconds: 36000 },
  };
});
vi.mock("../server/network", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, get transactionsEnabled() { return mocks.enabled; } };
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
  expect(await response.json()).toEqual({error:"Reconcile the unknown compute provider submission before retrying."});
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
