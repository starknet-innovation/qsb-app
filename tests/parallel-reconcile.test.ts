import { beforeEach, expect, it, vi } from "vitest";
// Reconciling one unknown chunk of a parallel search. Synthetic IDs only.
import { type Job, type SearchSlot } from "../src/lib/model";
import { MemoryStore } from "../server/store";
import {
  reconcileUnknownSubmission,
  type ReconciliationDecision,
  type SubmissionLookup,
} from "../server/reconcile-submission";
import { preservationFailures } from "../server/runtime/storage-authority";

const owner = "owner-1",
  jobId = "job-1",
  pk = `OWNER#${owner}`,
  sk = `JOB#${jobId}`;
const now = "2026-09-29T01:00:00.000Z";
const identity = (n: number) => ({
  jobName: `qsb-0000000${n}-0000-4000-8000-000000000000`,
  inputSha256: "a".repeat(64),
  inputKey: `inputs/${n}.json`,
  queue: "queue",
  definition: "definition",
});
const slot = (attempt: number, id?: string, startedAt = "2026-09-29T00:00:00.000Z"): SearchSlot => ({
  stage: "pinning",
  attempt,
  batchSubmission: identity(attempt),
  submissionStartedAt: startedAt,
  ...(id ? { runpodId: id } : {}),
});
let store: MemoryStore;
let lookup: SubmissionLookup & { findRequest: ReturnType<typeof vi.fn> };
const resumePolling = vi.fn(async () => ({ started: true }));
const job = async () => (await store.get(pk, sk))!.job as Job;
const run = (decision: ReconciliationDecision) =>
  reconcileUnknownSubmission({
    store, owner, jobId, decision, lookup, now,
    log: () => {}, resumePolling, pollingAllowed: () => true,
  });
async function seed(slots: SearchSlot[], extra: Partial<Job> = {}) {
  await store.put({
    pk, sk, version: 0,
    job: {
      id: jobId, owner, vaultId: "v", status: "paused", stage: "pinning", attempt: 0,
      revision: 3, computeSeconds: 0, manifestHash: "a".repeat(64), manifest: {},
      error: "Submission outcome unknown. Reconcile compute provider before resuming.",
      parallelSlots: slots, updatedAt: now, createdAt: now, ...extra,
    } as Job,
  });
  await store.put({ pk, sk: "VAULT#v", version: 0, vault: { network: "mainnet", publicStateJson: "{}" } });
}
beforeEach(() => {
  store = new MemoryStore();
  vi.clearAllMocks();
  lookup = {
    status: vi.fn(async (id) => ({ id, status: "IN_PROGRESS" })),
    health: vi.fn(async () => ({ jobs: { inQueue: 0, inProgress: 0 } })),
    findRequest: vi.fn(async () => null),
  };
});

it("attaches a discovered provider ID to the one unknown chunk, looked up by that chunk's identity", async () => {
  await seed([slot(0, "c0"), slot(1)]);
  lookup.findRequest.mockResolvedValue("found-1");
  expect(await run({ kind: "provider-id", providerId: "discover", operator: "op", evidence: "audit://1" }))
    .toMatchObject({ outcome: "provider-id", providerId: "found-1", resubmitted: false });
  expect(lookup.findRequest).toHaveBeenCalledWith(identity(1));
  expect(lookup.status).toHaveBeenCalledWith("found-1", identity(1));
  const saved = await job();
  expect(saved.status).toBe("searching");
  expect(saved.parallelSlots!.map((s) => [s.attempt, s.runpodId])).toEqual([[0, "c0"], [1, "found-1"]]);
  expect(saved.runpodId).toBeUndefined();
});

it("a not-submitted decision returns only that chunk to the pool, measured from its own start time", async () => {
  await seed([slot(0, "c0"), slot(1, undefined, "2026-09-29T00:20:00.000Z")]);
  const decision = { kind: "not-submitted", reason: "batch-window-elapsed", operator: "op", evidence: "audit://2" } as const;
  // The first chunk started 60 minutes ago and this one 40: the window is measured per chunk.
  await expect(run(decision)).resolves.toMatchObject({ outcome: "not-submitted" });
  const saved = await job();
  expect(saved.parallelSlots!.map((s) => s.attempt)).toEqual([0]);
  expect(saved).toMatchObject({ oneSubmissionAllowed: true, batchReplacementFor: identity(1).jobName });
  const request = await store.get(pk, `RECONCILIATION_REQUEST#${jobId}#${identity(1).jobName}`);
  expect(request).toMatchObject({ request: identity(1) });
});

it("refuses the window before 35 minutes have passed since that chunk started", async () => {
  await seed([slot(0, "c0"), slot(1, undefined, "2026-09-29T00:40:00.000Z")]);
  await expect(run({ kind: "not-submitted", reason: "batch-window-elapsed", operator: "op", evidence: "audit://3" }))
    .rejects.toThrow("BatchRecoveryWindowRequired");
});

it("refuses while other chunks still run, and when more than one chunk is unknown", async () => {
  await seed([slot(0, "c0"), slot(1)]);
  lookup.health = vi.fn(async () => ({ jobs: { inQueue: 0, inProgress: 1 } }));
  await expect(run({ kind: "not-submitted", reason: "batch-window-elapsed", operator: "op", evidence: "audit://4" }))
    .rejects.toThrow("EndpointNotDrained");
  store = new MemoryStore();
  await seed([slot(0), slot(1)]);
  await expect(run({ kind: "provider-id", providerId: "discover", operator: "op", evidence: "audit://5" }))
    .rejects.toThrow("SingleUnknownSubmissionRequired");
});

it("the storage inventory treats every chunk's provider ID as paid work a rollback must keep", () => {
  const row = (slots: SearchSlot[]) => ({ pk, sk, version: 0, job: { id: jobId, status: "searching", parallelSlots: slots } });
  expect(preservationFailures([row([slot(0, "c0"), slot(1, "c1")])], [row([slot(0, "c0")])]))
    .toContain("RollbackWouldDuplicatePaidWork");
  expect(preservationFailures([row([slot(0, "c0"), slot(1)])], [row([slot(0, "c0")])]))
    .toContain("RollbackWouldDuplicatePaidWork");
  expect(preservationFailures([row([slot(0, "c0")])], [row([slot(0, "c0")])]))
    .not.toContain("RollbackWouldDuplicatePaidWork");
});
