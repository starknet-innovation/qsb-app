import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), status: vi.fn(), cancel: vi.fn(), cpu: vi.fn(),
  limits: { workersMax: 1, executionTimeoutMs: 900000, maxJobGpuSeconds: 36000 } }));
vi.mock("../src/lib/releases/registry.generated", async () => {
  const { servedFixture, pqbFixture } = await import("./solver-fixture");
  return { default: [servedFixture, pqbFixture] };
});
vi.mock("../server/network", () => ({ transactionsEnabled: true }));
vi.mock("../server/chain", () => ({ chain: { assertNetwork: async () => {} } }));
vi.mock("../server/compute-provider", () => ({ computeConfigured: () => true,
  configuredCompute: async () => ({ prepareRun: mocks.prepare, status: mocks.status, cancel: mocks.cancel }) }));
vi.mock("../server/gpu-spend", async original => ({ ...await original<any>(), gpuSpendLimits: mocks.limits }));
import { servedFixture, pqbFixture } from "./solver-fixture";
import fixture from "./fixtures/pqb-reference.json";
import { adoptPqb } from "../src/lib/pqb";
import { publicVaultSchema, type Job, type PublicVault } from "../src/lib/model";
import { pinSolver, withVaultConfiguration, solverRegistry, fingerprint } from "../src/lib/provenance";
import { PQB_GENERATOR_COMMIT } from "../src/lib/pqb-identity";
import { deployedSolver } from "../server/solver-deployment";
import { MemoryStore } from "../server/store";
import { parallelTick } from "../server/parallel-search";
import { workRange } from "../server/search-ranges";
import { pqbWorkerStage } from "../server/pqb-search";
import { checkedOutput } from "../server/search-protocol";
import { pqbReference } from "../server/pqb-reference";
import { coordinatorPublicSolvedResult } from "../src/mainnet/coordinatorResult";
import { buildStoredSpendRecord } from "../server/job-spend-record";
import { solutionSchema } from "../src/lib/solution";

const event = { owner: fixture.manifest.destination, jobId: fixture.manifest.idempotencyKey, revision: 0 };
const pk = `OWNER#${event.owner}`, sk = `JOB#${event.jobId}`;
let vault: PublicVault, store: MemoryStore, serial: number;
beforeAll(() => {
  const g = adoptPqb(JSON.stringify({ config: "PQB", seed: fixture.seed }));
  vault = withVaultConfiguration({ id: fixture.manifest.vaultId, name: "Public synthetic PQB fixture",
    network: "mainnet", config: "PQB", createdAt: "2026-11-11T00:00:00.000Z", paymentAddress: event.owner,
    scriptHex: g.scriptHex, scriptHash: g.scriptHash, publicStateJson: g.publicStateJson,
    status: "confirmed", funding: fixture.manifest.funding });
});
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("SOLVER_RELEASE_ID", pqbFixture.id); vi.stubEnv("REFERENCE_FUNCTION", "synthetic");
  store = new MemoryStore(); serial = 0; mocks.limits.workersMax = 1;
  mocks.prepare.mockImplementation(async () => {
    const n = serial++, f = Object.assign(async () => ({ id: `test-${n}` }), { identity: {
      jobName: `test-${n}`, inputSha256: "a".repeat(64), inputKey: `inputs/${n}`, queue: "test", definition: "test",
    } });
    return f;
  });
  mocks.status.mockImplementation(async (id: string) => ({ id, status: "IN_PROGRESS" }));
  mocks.cpu.mockImplementation(async (e: unknown) => pqbReference(e));
});
afterEach(() => vi.unstubAllEnvs());
async function seed(extra: Partial<Job> = {}) {
  const manifest = { ...fixture.manifest, solverReleaseId: pqbFixture.id };
  const job = { id: event.jobId, owner: event.owner, vaultId: vault.id, createdAt: vault.createdAt,
    updatedAt: vault.createdAt, status: "queued", stage: "pinning", manifest, manifestHash: fingerprint(manifest),
    attempt: 0, revision: 0, computeSeconds: 0, gpuBudgetReservedSeconds: 0, solver: pinSolver(vault, pqbFixture.id), ...extra } as Job;
  // The production manifest hash uses schema-ordered JSON; adopt that for the solved-result check.
  const { canonicalManifest } = await import("../src/lib/model");
  const { sha256 } = await import("../src/pqb-core/primitives");
  const { hex } = await import("../src/pqb-core/primitives");
  job.manifestHash = hex(sha256(new TextEncoder().encode(JSON.stringify(canonicalManifest(manifest)))));
  await store.put({ pk, sk: `VAULT#${vault.id}`, version: 0, vault });
  await store.put({ pk, sk, version: 0, job });
  return job;
}
const job = async () => (await store.get(pk, sk))!.job as Job;
const tick = async () => parallelTick(event, (await store.get(pk, sk))!, store, mocks.cpu);
function output(j: Job, candidates: string[] = [], attempt = j.attempt) {
  const range = workRange(j.stage, attempt, "pqb-v1");
  return { status: "completed", stage: pqbWorkerStage(j.stage), manifestHash: j.manifestHash,
    attempt, candidates, kernelCommit: pqbFixture.kernelCommit, checkpoint: "range-complete",
    searchVersion: "pqb-ranked-v2", verified: false, workRange: range,
    trials: range.count * (j.stage === "pinning" ? 72 : j.stage === "round1" ? 192 : 64),
    gateHits: Math.max(candidates.length,
      Math.round(range.count * (j.stage === "pinning" ? 72 : j.stage === "round1" ? 192 : 64) / 2 ** 24)) };
}

it("enrolls only the matching PQB contract/generator and never pins a QSB release to a PQB vault", () => {
  expect(publicVaultSchema.parse(vault)).toEqual(vault);
  expect(deployedSolver().id).toBe(pqbFixture.id);
  expect(() => pinSolver(vault, servedFixture.id)).toThrow("SolverVaultProtocolMismatch");
  for (const change of [{ searchContract: servedFixture.searchContract }, { generatorCommit: servedFixture.generatorCommit },
    { searchVersion: "ranked-v2" }, { image: "ghcr.io/starknet-innovation/qsb-solver:latest" }])
    expect(() => solverRegistry([{ ...pqbFixture, ...change }])).toThrow();
  expect(vault.configuration.generatorCommit).toBe(PQB_GENERATOR_COMMIT);
});

it("sends exactly the PQB worker request, with the CPU-derived problem and a durable reservation", async () => {
  await seed(); await tick();
  const j = await job(), request = mocks.prepare.mock.calls[0][1];
  expect(Object.keys(request).sort()).toEqual(["protocol", "stage", "attempt", "searchVersion", "problemBase64",
    "problemSha256", "manifestHash", "kernelCommit"].sort());
  expect(request.protocol).toBe("pqb-v1"); expect(request.stage).toBe("pinning");
  expect(request).not.toHaveProperty("sequence"); expect(request).not.toHaveProperty("parameterBase64");
  expect(j.parallelSlots?.[0].runpodId).toBe("test-0");
  expect(j.gpuBudgetReservedSeconds).toBe(900); expect(j.gpuSubmissions).toBe(1);
  expect(j.solver!.descriptor.id).toBe(pqbFixture.id);
});

it("never resubmits a paid request whose outcome is unknown", async () => {
  await seed(); mocks.prepare.mockImplementationOnce(async () => Object.assign(async () => { throw Error("lost response"); },
    { identity: { jobName: "lost", inputSha256: "a".repeat(64), inputKey: "inputs/lost", queue: "q", definition: "d" } }));
  await expect(tick()).rejects.toThrow("lost response");
  expect((await job()).pqbNextPinAttempt).toBe(1);
  await tick();
  expect((await job()).status).toBe("paused"); expect((await job()).error).toContain("Submission outcome unknown");
  expect(mocks.prepare).toHaveBeenCalledOnce();
});

it("advances all three worker stages using CPU verdicts and preserves the PQB hit records for local assembly", async () => {
  await seed(); await tick();
  const lines = ["2147483648 500000000 0 0 0 1", "0,1,2,3,4,5,6,7 0 0 0 1", "0,1,2,3,4,5,6,7,8 0 0 0 1"];
  // This coordinator test stubs CPU verdicts; the independent Python differential tests exercise the real verifier.
  for (const [s, line] of lines.entries()) {
    const j = await job(), currentId = j.parallelSlots![0].runpodId!;
    mocks.status.mockImplementation(async id => id === currentId
      ? { id, status: "COMPLETED", output: output(j, [line]) } : { id, status: "IN_PROGRESS" });
    mocks.cpu.mockImplementation(async e => e.action === "export" ? pqbReference(e) : ({ valid: true,
      sequence: 0x80000000, locktime: 500000000, candidate: line,
      ...(s ? { indices: Array.from({ length: s === 1 ? 8 : 9 }, (_, i) => i + (s === 1 ? 0 : 8)) } : {}) }));
    await tick();
  }
  const j = await job();
  expect(j.status).toBe("awaiting_authorization"); expect(j.stage).toBe("verification");
  expect(j.solution!.pqb).toEqual({ pinning: lines[0], round0: lines[1], round1: lines[2] });
  expect(coordinatorPublicSolvedResult(j).solution).toEqual(j.solution);
  expect(buildStoredSpendRecord(j).fee).toBe(fixture.manifest.fee);
  expect(solutionSchema.parse(j.solution)).toEqual(j.solution);
  expect(mocks.prepare.mock.calls.map(c => c[1].stage)).toEqual(["pinning", "round0", "round1"]);
});

it("re-pins after a whole round is empty, preserving paid accounting", async () => {
  const solution = { sequence: 0x80000000, locktime: 500000000, round1: [], round2: [],
    pqb: { pinning: "2147483648 500000000 0 0 0 1" } };
  await seed({ stage: "round1", attempt: 69, solution, pqbNextPinAttempt: 7 }); await tick();
  const j = await job();
  mocks.status.mockResolvedValue({ id: "test-0", status: "COMPLETED", output: output(j) });
  await tick(); const next = await job();
  expect(next.stage).toBe("pinning"); expect(next.attempt).toBe(7); expect(next.searchEpoch).toBe(1);
  expect(next.solution).toBeUndefined(); expect(next.gpuBudgetReservedSeconds).toBe(900);
  expect(next.completedAttempts).toEqual([]);
  await tick(); expect((await job()).gpuBudgetReservedSeconds).toBe(1800);
  expect(mocks.prepare.mock.calls.at(-1)![1]).toMatchObject({ stage: "pinning", attempt: 7 });
});

it("refuses wrong worker context, ranges, accounting and out-of-unit hits before CPU credit", async () => {
  const j = await seed(), o = output(j);
  for (const altered of [{ ...o, searchVersion: "ranked-v2" }, { ...o, stage: "round0" },
    { ...o, trials: o.trials - 1 }, { ...o, workRange: { ...o.workRange, prefixStart: "0" } },
    { ...o, candidates: ["2147483662 500000000 0 0 0 1"] }])
    expect(() => checkedOutput(altered, deployedSolver(), j, 0)).toThrow();
});

it("checks both sides of the producer's statistical gate-count bound for every PQB stage", async () => {
  const base = await seed();
  for (const stage of ["pinning", "round1", "round2"] as const) {
    const j = { ...base, stage }, o = output(j);
    const mean = o.trials / 2 ** 24, tolerance = 6 * Math.sqrt(mean) + 6;
    for (const gateHits of [Math.ceil(mean - tolerance), Math.floor(mean + tolerance)])
      expect(() => checkedOutput({ ...o, gateHits }, deployedSolver(), j, 0)).not.toThrow();
    for (const gateHits of [0, Math.ceil(mean - tolerance) - 1, Math.floor(mean + tolerance) + 1])
      expect(() => checkedOutput({ ...o, gateHits }, deployedSolver(), j, 0))
        .toThrow("CandidateGateCountMismatch");
    expect(() => checkedOutput({ ...o, status: "interrupted", trials: undefined, gateHits: undefined },
      deployedSolver(), j, 0)).not.toThrow();
  }
});


it("re-pins beyond every submitted parallel pinning range, including earlier completed ranges", async () => {
  mocks.limits.workersMax = 3;
  await seed(); await tick();
  expect((await job()).pqbNextPinAttempt).toBe(3);
  let j = await job();
  mocks.status.mockImplementation(async id => id === "test-1"
    ? { id, status: "COMPLETED", output: output(j, [], 1) } : { id, status: "IN_PROGRESS" });
  await tick();
  j = await job();
  expect(j.completedAttempts).toEqual([1]);
  expect(j.pqbNextPinAttempt).toBe(4);
  const line = "2147483648 500000000 0 0 0 1";
  mocks.status.mockImplementation(async id => id === "test-0"
    ? { id, status: "COMPLETED", output: output(j, [line], 0) } : { id, status: "COMPLETED" });
  mocks.cpu.mockImplementation(async e => e.action === "export" ? pqbReference(e)
    : { valid: true, candidate: line, sequence: 2147483648, locktime: 500000000 });
  await tick();
  j = await job();
  expect(j.stage).toBe("round1"); expect(j.pqbNextPinAttempt).toBe(4);
  // Simulate the complete round space already exhausted; no real provider is called.
  const row = (await store.get(pk, sk))!;
  await store.put({ ...row, version: row.version + 1, job: { ...j, attempt: 70,
    parallelSlots: [], completedAttempts: [] } }, row.version);
  await tick();
  expect((await job()).attempt).toBe(4);
  mocks.status.mockImplementation(async id => ({ id, status: "IN_PROGRESS" }));
  await tick();
  const pinAttempts = mocks.prepare.mock.calls.map(call => call[1])
    .filter(input => input.stage === "pinning").map(input => input.attempt);
  expect(pinAttempts).toEqual([0, 1, 2, 3, 4, 5, 6]);
});

it("recovers the pinning high-water mark from retained slots and completed attempts", async () => {
  const line = "2147483648 500000000 0 0 0 1";
  const j = await seed({ parallelSlots: [
    { stage: "pinning", attempt: 0, runpodId: "retained-0", submissionStartedAt: vault.createdAt },
    { stage: "pinning", attempt: 9, runpodId: "retained-9", submissionStartedAt: vault.createdAt },
  ], completedAttempts: [7], gpuBudgetReservedSeconds: 1800 });
  mocks.status.mockImplementation(async id => id === "retained-0"
    ? { id, status: "COMPLETED", output: output(j, [line], 0) } : { id, status: "COMPLETED" });
  mocks.cpu.mockImplementation(async e => e.action === "export" ? pqbReference(e)
    : { valid: true, candidate: line, sequence: 2147483648, locktime: 500000000 });
  await tick();
  expect((await job()).pqbNextPinAttempt).toBe(10);
  expect((await job()).stage).toBe("round1");
});
