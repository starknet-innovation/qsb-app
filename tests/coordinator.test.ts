import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  health: vi.fn(),
  run: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
  cpu: vi.fn(),
}));
vi.mock("../src/lib/model", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, release: { ...actual.release, mainnetEnabled: true } };
});
vi.mock("../server/providers", () => ({
  Runpod: class {
    health = mocks.health;
    run = mocks.run;
    status = mocks.status;
    cancel = mocks.cancel;
  },
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
import { handler } from "../server/coordinator";
import { store, MemoryStore } from "../server/store";
import { release, type Job } from "../src/lib/model";
import { workRange } from "../server/search-ranges";
const event = { owner: "test", jobId: "test-job", revision: 0 };
const pk = "OWNER#test",
  sk = "JOB#test-job";
async function seed(extra: Partial<Job> = {}) {
  const job = {
    id: event.jobId,
    owner: event.owner,
    vaultId: "v",
    revision: 0,
    status: "queued",
    stage: "pinning",
    attempt: 0,
    computeSeconds: 0,
    manifestHash: "a".repeat(64),
    manifest: {},
    ...extra,
  } as Job;
  await store.put({ pk, sk, version: 0, job });
  await store.put({
    pk,
    sk: "VAULT#v",
    version: 0,
    vault: { publicStateJson: "{}", network: "mainnet" },
  });
}
beforeEach(() => {
  (store as MemoryStore).rows.clear();
  vi.clearAllMocks();
  process.env.RUNPOD_SECRET_ARN = "test-arn";
  process.env.RUNPOD_ENDPOINT_ID = "test-endpoint";
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
    endpointId: "test-endpoint",
    health: { jobs: { inQueue: 0 } },
  });
  expect(mocks.run).not.toHaveBeenCalled();
  expect((store as MemoryStore).rows.size).toBe(0);
  await expect(
    handler({ action: "providerHealth", owner: "test" } as any),
  ).rejects.toThrow();
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
