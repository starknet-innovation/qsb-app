import { beforeEach, expect, it, vi } from "vitest";
import { release, type Job } from "../src/lib/model";
import { MemoryStore } from "../server/store";
import { workRange } from "../server/search-ranges";
import {
  reconcileUnknownSubmission,
  reconcileSubmissionCli,
  type ReconciliationDecision,
  type SubmissionLookup,
} from "../server/reconcile-submission";
const owner = "owner-1",
  jobId = "job-1",
  pk = `OWNER#${owner}`,
  sk = `JOB#${jobId}`;
const now = "2026-09-25T01:00:00.000Z";
const decision: ReconciliationDecision = {
  kind: "provider-id",
  providerId: "provider-1",
  operator: "operator@example",
  evidence: "audit://incident/1",
};
const replacement = (
  reason:
    "rejected-before-acceptance" | "ttl-expired" = "rejected-before-acceptance",
): ReconciliationDecision => ({
  kind: "not-submitted",
  reason,
  operator: "operator@example",
  evidence: "audit://incident/1",
});
let store: MemoryStore;
let lookup: SubmissionLookup;
let resumePolling: ReturnType<
  typeof vi.fn<() => Promise<{ started: boolean; reason?: string }>>
>;
async function job() {
  return (await store.get(pk, sk))!.job as Job;
}
async function change(extra: Partial<Job>) {
  const row = (await store.get(pk, sk))!;
  await store.put(
    {
      ...row,
      version: row.version + 1,
      job: { ...(row.job as Job), ...extra },
    },
    row.version,
  );
}
const run = (d: ReconciliationDecision = decision) =>
  reconcileUnknownSubmission({
    store,
    owner,
    jobId,
    decision: d,
    lookup,
    now,
    log: () => {},
    resumePolling,
  });
beforeEach(async () => {
  store = new MemoryStore();
  const paused = {
    id: jobId,
    owner,
    vaultId: "v",
    status: "paused",
    stage: "pinning",
    attempt: 0,
    revision: 3,
    computeSeconds: 0,
    manifestHash: "a".repeat(64),
    manifest: {},
    error: "Submission outcome unknown. Reconcile Runpod before resuming.",
    submissionStartedAt: "2026-09-24T00:00:00.000Z",
    updatedAt: now,
    createdAt: now,
  } as Job;
  await store.put({ pk, sk, version: 0, job: paused });
  await store.put({
    pk,
    sk: "VAULT#v",
    version: 0,
    vault: { network: "mainnet", publicStateJson: "{}" },
  });
  lookup = {
    status: vi.fn(async (id) => ({ id, status: "IN_PROGRESS" })),
    health: vi.fn(async () => ({ jobs: { inQueue: 0, inProgress: 0 } })),
  };
  resumePolling = vi.fn(async () => ({
    started: false,
    reason: "transactions-disabled",
  }));
});
it("attaches an operator-identified live request without requiring echoed input or a list", async () => {
  expect(await run()).toMatchObject({
    outcome: "provider-id",
    providerId: "provider-1",
    resubmitted: false,
  });
  expect(await job()).toMatchObject({
    runpodId: "provider-1",
    status: "searching",
    revision: 4,
    submissionReconciliation: {
      operator: decision.operator,
      evidence: decision.evidence,
    },
  });
  expect((await store.list(pk, "RECONCILIATION#")).length).toBe(1);
  expect(lookup.health).not.toHaveBeenCalled();
});
it("restarts polling idempotently after attachment without granting another submission", async () => {
  resumePolling.mockRejectedValueOnce(Error("workflow unavailable"));
  await expect(run()).rejects.toThrow("workflow unavailable");
  await run();
  expect((await store.list(pk, "RECONCILIATION#")).length).toBe(1);
  expect((await job()).revision).toBe(4);
});
it.each(["IN_QUEUE", "FAILED", "CANCELLED", "TIMED_OUT"])(
  "records an attested %s provider id without submitting",
  async (status) => {
    lookup.status = vi.fn(async (id) => ({ id, status }));
    await run();
    expect((await job()).runpodId).toBe("provider-1");
  },
);
const output = () => ({
  manifestHash: "a".repeat(64),
  stage: "pinning",
  attempt: 0,
  kernelCommit: release.kernelCommit,
  workRange: workRange("pinning", 0),
});
it("binds completed output to the exact assigned range", async () => {
  lookup.status = vi.fn(async (id) => ({
    id,
    status: "COMPLETED",
    output: output(),
  }));
  await run();
  expect((await job()).status).toBe("searching");
});
it.each(["manifestHash", "stage", "attempt", "kernelCommit", "workRange"])(
  "rejects mismatched completed %s",
  async (field) => {
    lookup.status = vi.fn(async (id) => ({
      id,
      status: "COMPLETED",
      output: {
        ...output(),
        [field]:
          field === "attempt"
            ? 9
            : field === "workRange"
              ? { ...workRange("pinning", 0), count: 1 }
              : "wrong",
      },
    }));
    await expect(run()).rejects.toThrow();
    expect((await job()).runpodId).toBeUndefined();
    expect(resumePolling).not.toHaveBeenCalled();
  },
);
it.each(["missing", "wrong-id", "read-failure"])(
  "rejects incomplete provider evidence: %s",
  async (mode) => {
    lookup.status = vi.fn(async () => {
      if (mode === "read-failure") throw Error("read unavailable");
      return {
        id: mode === "wrong-id" ? "wrong" : "provider-1",
        status: "COMPLETED",
      };
    });
    await expect(run()).rejects.toThrow();
    expect((await job()).status).toBe("paused");
  },
);
it("records an attested non-acceptance once with immutable audit evidence", async () => {
  expect(await run(replacement())).toMatchObject({
    outcome: "not-submitted",
    resubmitted: false,
    pollingStarted: false,
  });
  expect(await job()).toMatchObject({
    oneSubmissionAllowed: true,
    status: "paused",
    revision: 4,
  });
  await expect(run(replacement())).rejects.toThrow("DecisionAlreadyRecorded");
  expect((await store.list(pk, "RECONCILIATION#")).length).toBe(1);
  expect(resumePolling).not.toHaveBeenCalled();
});
it("accepts a drained expired submission with durable start time", async () => {
  await run(replacement("ttl-expired"));
  expect((await job()).oneSubmissionAllowed).toBe(true);
});
it.each([
  undefined,
  "invalid",
  "2026-09-25T00:00:00.000Z",
  "2026-09-26T00:00:00.000Z",
])(
  "refuses ambiguous replacement without elapsed durable TTL: %s",
  async (submissionStartedAt) => {
    await change({ submissionStartedAt });
    await expect(run(replacement("ttl-expired"))).rejects.toThrow(
      "SubmissionTtlNotExpired",
    );
    expect((await job()).oneSubmissionAllowed).toBeUndefined();
  },
);
it.each([
  { inQueue: 1, inProgress: 0 },
  { inQueue: 0, inProgress: 1 },
])("refuses replacement until actual queue drain %j", async (jobs) => {
  lookup.health = vi.fn(async () => ({ jobs }));
  await expect(run(replacement())).rejects.toThrow("EndpointNotDrained");
});
it("never infers permission from an empty health response without an operator decision", async () => {
  await expect(run({} as ReconciliationDecision)).rejects.toThrow();
  expect((await job()).oneSubmissionAllowed).toBeUndefined();
});
it("rejects decisions lacking evidence", async () => {
  await expect(run({ ...replacement(), evidence: "" })).rejects.toThrow();
  expect(lookup.health).not.toHaveBeenCalled();
});
it("atomically permits only one competing reconciliation", async () => {
  const results = await Promise.allSettled([
    run(replacement()),
    run(replacement()),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect((await store.list(pk, "RECONCILIATION#")).length).toBe(1);
});
it("does not overwrite a concurrent pause/revision change", async () => {
  lookup.health = vi.fn(async () => {
    await change({ revision: 99 });
    return { jobs: { inQueue: 0, inProgress: 0 } };
  });
  await expect(run(replacement())).rejects.toThrow();
  expect((await job()).revision).toBe(99);
  expect((await store.list(pk, "RECONCILIATION#")).length).toBe(0);
});
it("requires a durable table before opening credentials in the CLI", async () => {
  const old = process.env.TABLE_NAME;
  delete process.env.TABLE_NAME;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await reconcileSubmissionCli([owner, jobId]);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("TableNameRequired"),
    );
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = 0;
    stderr.mockRestore();
    if (old === undefined) delete process.env.TABLE_NAME;
    else process.env.TABLE_NAME = old;
  }
});
