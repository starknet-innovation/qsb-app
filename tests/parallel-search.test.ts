import { beforeEach, expect, it, vi } from "vitest";
// Parallel search with four GPUs. Unsigned fixtures and synthetic provider IDs only.
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
  return { default: [servedFixture, otherFixture] };
});
vi.mock("../server/gpu-spend", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    gpuSpendLimits: { ...actual.gpuSpendLimits, workersMax: 4, maxJobGpuSeconds: 36000 },
  };
});
vi.mock("../server/network", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, get transactionsEnabled() { return mocks.enabled; } };
});
vi.mock("../server/providers", () => ({ slipstream: {} }));
vi.mock("../server/compute-provider", () => ({
  computeConfigured: () => true,
  configuredCompute: async () => ({
    health: mocks.health,
    prepareRun: mocks.prepareRun,
    status: mocks.status,
    cancel: mocks.cancel,
  }),
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: class {
    send = mocks.cpu;
  },
  InvokeCommand: class {
    constructor(public input: any) {}
  },
}));
import { fixtureVault } from "./solver-fixture";
import { pinSolver } from "../src/lib/provenance";
import { handler } from "../server/coordinator";
import { store, MemoryStore } from "../server/store";
import { release, type Job, type SearchSlot } from "../src/lib/model";
import { workRange } from "../server/search-ranges";

const event = { owner: "test", jobId: "test-job", revision: 0 };
const pk = "OWNER#test",
  sk = "JOB#test-job";
const identity = (n: number) => ({
  jobName: `qsb-${n}`,
  inputSha256: "a".repeat(64),
  inputKey: `inputs/${n}.json`,
  queue: "queue",
  definition: "definition",
});
const slot = (attempt: number, stage: SearchSlot["stage"] = "pinning", id: string | null = `c${attempt}`): SearchSlot => ({
  stage,
  attempt,
  batchSubmission: identity(100 + attempt),
  submissionStartedAt: "2026-09-29T00:00:00.000Z",
  ...(id ? { runpodId: id } : {}),
});
const output = (stage: SearchSlot["stage"], attempt: number, candidates: string[] = []) => ({
  status: "COMPLETED",
  executionTime: 72000,
  output: {
    status: "completed",
    stage,
    manifestHash: "a".repeat(64),
    attempt,
    candidates,
    kernelCommit: release.kernelCommit,
    checkpoint: "range-complete",
    workRange: workRange(stage, attempt),
  },
});
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
  await store.put({ pk, sk: "VAULT#v", version: 0, vault: fixtureVault });
}
const saved = async () => (await store.get(pk, sk))!.job as Job;
let states: Record<string, unknown>;
let submitted: number;
beforeEach(() => {
  mocks.enabled = true;
  (store as MemoryStore).rows.clear();
  vi.clearAllMocks();
  process.env.SOLVER_RELEASE_ID = "served-test";
  process.env.REFERENCE_FUNCTION = "test-reference";
  states = {};
  submitted = 0;
  mocks.status.mockImplementation(async (id: string) => states[id] ?? { id, status: "IN_PROGRESS" });
  mocks.cpu.mockImplementation(async (command) => ({
    Payload: Buffer.from(
      JSON.stringify(
        JSON.parse(command.input.Payload.toString()).action === "export"
          ? { parameterBase64: "public", parameterSha256: "b".repeat(64) }
          : { valid: false },
      ),
    ),
  }));
  mocks.run.mockImplementation(async () => ({ id: `compute-${submitted}` }));
  mocks.prepareRun.mockImplementation(async (_image, input) => {
    const n = ++submitted;
    return Object.assign(() => mocks.run(input), { identity: identity(n) });
  });
});

it("fills every GPU with consecutive chunks, saving each intent and reservation before its POST", async () => {
  await seed();
  mocks.run.mockImplementation(async (input) => {
    const job = await saved();
    const mine = job.parallelSlots!.find((s) => s.attempt === input.attempt)!;
    // The slot and its 900-second reservation are durable before the paid call.
    expect(mine.runpodId).toBeUndefined();
    expect(job.status).toBe("searching");
    expect(job.gpuBudgetReservedSeconds).toBe(900 * (input.attempt + 1));
    return { id: `compute-${input.attempt}` };
  });
  expect(await handler(event)).toMatchObject({ done: false, waitSeconds: 5 });
  expect(mocks.run.mock.calls.map((c) => c[0].attempt)).toEqual([0, 1, 2, 3]);
  const job = await saved();
  expect(job.parallelSlots!.map((s) => [s.attempt, s.runpodId])).toEqual([
    [0, "compute-0"], [1, "compute-1"], [2, "compute-2"], [3, "compute-3"],
  ]);
  expect(job).toMatchObject({ gpuSubmissions: 4, gpuBudgetReservedSeconds: 3600, attempt: 0 });
  expect(job.runpodId).toBeUndefined();
  // Nothing new is sent while all four are running.
  await handler(event);
  expect(mocks.run).toHaveBeenCalledTimes(4);
});

it("credits chunks that finish out of order only up to the first unfinished one", async () => {
  await seed({ status: "searching", parallelSlots: [slot(0), slot(1), slot(2), slot(3)] });
  states.c2 = output("pinning", 2);
  await handler(event);
  let job = await saved();
  expect(job).toMatchObject({ attempt: 0, completedAttempts: [2], computeSeconds: 72 });
  // The free GPU takes the next unassigned chunk, never a finished or running one.
  expect(mocks.run.mock.calls.map((c) => c[0].attempt)).toEqual([4]);
  states.c0 = output("pinning", 0);
  states.c1 = output("pinning", 1);
  await handler(event);
  job = await saved();
  expect(job).toMatchObject({ attempt: 3, completedAttempts: [] });
  expect(job.parallelSlots!.map((s) => s.attempt).sort()).toEqual([3, 4, 5, 6]);
});

it("a verified hit moves to the next stage and stops the superseded chunks without crediting them", async () => {
  await seed({ status: "searching", parallelSlots: [slot(0), slot(1), slot(2), slot(3)] });
  const range = workRange("pinning", 2);
  states.c2 = output("pinning", 2, ["candidate"]);
  mocks.cpu.mockImplementation(async (command) => {
    const payload = JSON.parse(command.input.Payload.toString());
    return {
      Payload: Buffer.from(
        JSON.stringify(
          payload.action === "export"
            ? { parameterBase64: "public", parameterSha256: "b".repeat(64) }
            : { valid: true, sequence: range.sequence, locktime: range.locktime },
        ),
      ),
    };
  });
  await handler(event);
  let job = await saved();
  expect(job).toMatchObject({ stage: "round1", attempt: 0, solution: { sequence: range.sequence } });
  // Chunk 3 was polled after the hit and is stopped; 0 and 1 are stopped on the next tick.
  expect(mocks.cancel.mock.calls.map((c) => c[0])).toEqual(["c3"]);
  // Superseded chunks still hold a GPU, so only one round1 chunk starts now.
  expect(mocks.run.mock.calls.map((c) => [c[0].stage, c[0].attempt])).toEqual([["round1", 0]]);
  await handler(event);
  expect(mocks.cancel.mock.calls.map((c) => c[0]).sort()).toEqual(["c0", "c1", "c3", "c3"].sort());
  // Once stopped they're dropped, never credited or counted as an interruption.
  states.c0 = states.c1 = states.c3 = { status: "CANCELLED" };
  await handler(event);
  job = await saved();
  expect(job.status).toBe("searching");
  expect(job.parallelSlots!.every((s) => s.stage === "round1")).toBe(true);
  expect(job.parallelSlots!.map((s) => s.attempt).sort()).toEqual([0, 1, 2, 3]);
  expect(job.completedAttempts).toEqual([]);
});

it("an unknown POST outcome pauses the withdrawal without polling or sending anything", async () => {
  await seed({ status: "searching", parallelSlots: [slot(0), slot(1, "pinning", null)] });
  expect(await handler(event)).toMatchObject({ done: true });
  const job = await saved();
  expect(job).toMatchObject({ status: "paused", error: expect.stringContaining("Submission outcome unknown") });
  expect(job.parallelSlots).toHaveLength(2);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.status).not.toHaveBeenCalled();
});

it("a POST that throws leaves its slot unknown and it is never resubmitted", async () => {
  await seed();
  mocks.run
    .mockImplementationOnce(async () => ({ id: "compute-0" }))
    .mockImplementationOnce(async () => { throw new Error("SubmissionOutcomeUnknown"); });
  await expect(handler(event)).rejects.toThrow();
  let job = await saved();
  expect(job.parallelSlots!.map((s) => [s.attempt, s.runpodId ?? null])).toEqual([[0, "compute-0"], [1, null]]);
  expect(job.gpuBudgetReservedSeconds).toBe(1800);
  await handler(event);
  job = await saved();
  expect(job.status).toBe("paused");
  expect(job.error).toContain("Submission outcome unknown");
  expect(mocks.run).toHaveBeenCalledTimes(2);
});

it("an interrupted chunk pauses the withdrawal; resume repeats that chunk once", async () => {
  await seed({ status: "searching", parallelSlots: [slot(0), slot(1), slot(2), slot(3)] });
  states.c1 = { status: "FAILED" };
  expect(await handler(event)).toMatchObject({ done: true });
  let job = await saved();
  expect(job).toMatchObject({ status: "paused", error: expect.stringContaining("Compute interrupted") });
  expect(job.parallelSlots!.map((s) => s.attempt)).toEqual([0, 2, 3]);
  expect(mocks.run).not.toHaveBeenCalled();
  // The resume route's effect: queued, retry requested, error cleared.
  const row = (await store.get(pk, sk))!;
  await store.put({ ...row, version: row.version + 1, job: { ...job, status: "queued", retryRequested: true, error: undefined } }, row.version);
  await handler(event);
  job = await saved();
  expect(mocks.run.mock.calls.map((c) => c[0].attempt)).toEqual([1]);
  expect(job.retryRequested).toBeUndefined();
  expect(job.status).toBe("searching");
});

it("stops adding chunks at the GPU-time budget and pauses only once nothing is running", async () => {
  await seed({ gpuBudgetReservedSeconds: 34200 });
  await handler(event);
  let job = await saved();
  // 34200 + 900 + 900 = 36000 is the cap; a third reservation would exceed it.
  expect(mocks.run).toHaveBeenCalledTimes(2);
  expect(job).toMatchObject({ status: "searching", gpuBudgetReservedSeconds: 36000 });
  states["compute-1"] = output("pinning", 0);
  states["compute-2"] = output("pinning", 1);
  await handler(event);
  job = await saved();
  expect(job).toMatchObject({ status: "paused", error: expect.stringContaining("GPU-time budget reached"), attempt: 2 });
  expect(mocks.run).toHaveBeenCalledTimes(2);
});

it("pausing stops every running chunk and keeps each provider ID for resume", async () => {
  await seed({ status: "paused", parallelSlots: [slot(0), slot(1)] });
  states.c1 = output("pinning", 1);
  expect(await handler(event)).toMatchObject({ done: false });
  expect(mocks.cancel.mock.calls.map((c) => c[0])).toEqual(["c0"]);
  states.c0 = { status: "CANCELLED" };
  expect(await handler(event)).toMatchObject({ done: true });
  expect((await saved()).parallelSlots!.map((s) => s.runpodId)).toEqual(["c0", "c1"]);
  expect(mocks.run).not.toHaveBeenCalled();
});

it("adopts a single-GPU job's running submission as a slot with its chunk and ID", async () => {
  await seed({
    status: "searching",
    attempt: 5,
    runpodId: "compute-legacy",
    batchSubmission: identity(1),
    submissionStartedAt: "2026-09-29T00:00:00.000Z",
  });
  await handler(event);
  const job = await saved();
  expect(job.runpodId).toBeUndefined();
  expect(job.batchSubmission).toBeUndefined();
  expect(job.parallelSlots![0]).toMatchObject({ attempt: 5, runpodId: "compute-legacy", batchSubmission: identity(1) });
  expect(mocks.status.mock.calls[0][0]).toBe("compute-legacy");
  expect(mocks.run.mock.calls.map((c) => c[0].attempt)).toEqual([6, 7, 8]);
});

it("pauses as exhausted only after the last chunk of a stage has finished", async () => {
  const last = 2 ** 31 / 16 - 1;
  await seed({ attempt: last });
  await handler(event);
  expect(mocks.run.mock.calls.map((c) => c[0].attempt)).toEqual([last]);
  expect((await saved()).status).toBe("searching");
  states["compute-1"] = output("pinning", last);
  await handler(event);
  expect(await saved()).toMatchObject({ status: "paused", error: expect.stringContaining("range exhausted") });
});
