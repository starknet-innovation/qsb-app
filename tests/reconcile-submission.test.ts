import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import "../scripts/reconcile-submission";
import { release, type Job } from "../src/lib/model";
import { Runpod } from "../server/providers";
import {
  pollingStartAllowed,
  reconcileUnknownSubmission,
  type SubmissionLookup,
} from "../server/reconcile-submission";
import { MemoryStore } from "../server/store";
import { searchVersion } from "../server/search-ranges";

const owner = "owner-1";
const jobId = "job-1";
const pk = `OWNER#${owner}`;
const sk = `JOB#${jobId}`;
const parameterSha256 = "b".repeat(64);

function identity(extra: Record<string, unknown> = {}) {
  return {
    protocol: "qsb-config-a-v1",
    kernelCommit: release.kernelCommit,
    manifestHash: "a".repeat(64),
    stage: "pinning",
    attempt: 0,
    searchVersion,
    parameterSha256,
    parameterBase64: "public-parameter",
    ...extra,
  };
}

function pausedJob(extra: Partial<Job> = {}): Job {
  return {
    id: jobId,
    owner,
    vaultId: "v",
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    status: "paused",
    stage: "pinning",
    manifest: {} as Job["manifest"],
    manifestHash: "a".repeat(64),
    attempt: 0,
    computeSeconds: 0,
    revision: 3,
    error: "Submission outcome unknown. Reconcile Runpod before resuming.",
    parameterHashes: { "pinning::": parameterSha256 },
    ...extra,
  };
}

function guarded(lookup: SubmissionLookup): SubmissionLookup {
  return new Proxy(lookup, {
    get(target, property, receiver) {
      if (property === "run" || property === "cancel")
        throw new Error("AutomaticResubmitRefused");
      return Reflect.get(target, property, receiver);
    },
  });
}

async function stored(store: MemoryStore): Promise<Job> {
  return (await store.get(pk, sk))?.job as Job;
}

async function seed(store: MemoryStore, job: Job = pausedJob()) {
  await store.put({ pk, sk, version: 0, job });
  await store.put({
    pk,
    sk: "VAULT#v",
    version: 0,
    vault: { publicStateJson: "{}" },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

it("records a matching provider id and does not submit", async () => {
  const store = new MemoryStore();
  await seed(store);
  const resumePolling = vi.fn(async () => ({
    started: false,
    reason: "transactions-disabled",
  }));
  const logs: unknown[] = [];
  const result = await reconcileUnknownSubmission({
    store,
    owner,
    jobId,
    now: "2026-09-24T01:00:00.000Z",
    lookup: guarded({
      async requests() {
        return [{ id: "other-job" }, { id: "provider-1" }];
      },
      async status(id) {
        return {
          id,
          input:
            id === "provider-1"
              ? identity()
              : identity({ manifestHash: "c".repeat(64) }),
        };
      },
    }),
    log: (entry) => logs.push(entry),
    resumePolling,
  });
  expect(result).toEqual({
    outcome: "provider-id",
    providerId: "provider-1",
    resubmitted: false,
    pollingStarted: false,
  });
  expect(resumePolling).toHaveBeenCalledTimes(1);
  expect(await stored(store)).toMatchObject({
    status: "searching",
    runpodId: "provider-1",
    revision: 4,
    updatedAt: "2026-09-24T01:00:00.000Z",
  });
  expect((await stored(store)).error).toBeUndefined();
  expect((await stored(store)).oneSubmissionAllowed).toBeUndefined();
  expect(logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: "load" }),
      expect.objectContaining({
        action: "check-runpod",
        inspected: ["other-job", "provider-1"],
      }),
      expect.objectContaining({
        action: "record-provider-id",
        providerId: "provider-1",
      }),
      expect.objectContaining({
        action: "resume-polling",
        started: false,
        reason: "transactions-disabled",
      }),
    ]),
  );
  expect(JSON.stringify(logs)).not.toContain("public-parameter");
  expect(pollingStartAllowed(owner)).toBe(false);
  expect(release.mainnetEnabled).toBe(false);
});

it("does not authorize another submission when the request list misses this job", async () => {
  const store = new MemoryStore();
  await seed(store, pausedJob({ oneSubmissionAllowed: true }));
  const resumePolling = vi.fn(async () => ({ started: true }));
  const seen: string[] = [];
  const logs: unknown[] = [];
  const result = await reconcileUnknownSubmission({
    store,
    owner,
    jobId,
    lookup: guarded({
      async requests() {
        return [{ id: "unrelated" }, { id: "extra-key" }];
      },
      async status(id) {
        seen.push(id);
        if (id === "extra-key") return { id, input: { ...identity(), note: "extra" } };
        return { id, input: identity({ stage: "round1", attempt: 4 }) };
      },
    }),
    log: (entry) => logs.push(entry),
    resumePolling,
    now: "2026-09-24T01:00:00.000Z",
  });
  expect(result).toEqual({ outcome: "unresolved", resubmitted: false });
  expect(seen).toEqual(["unrelated", "extra-key"]);
  expect(resumePolling).not.toHaveBeenCalled();
  expect(await stored(store)).toMatchObject({
    status: "paused",
    revision: 3,
    error: expect.stringContaining("outcome unknown"),
  });
  expect((await stored(store)).oneSubmissionAllowed).toBeUndefined();
  expect((await stored(store)).runpodId).toBeUndefined();
  expect(logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "check-runpod",
        inspected: ["unrelated", "extra-key"],
        unreadable: ["extra-key"],
      }),
      expect.objectContaining({
        action: "refuse",
        providerId: "extra-key",
        inspected: ["unrelated", "extra-key"],
      }),
    ]),
  );
  expect(JSON.stringify(logs)).not.toContain("submissionsAllowed");
});

it("does not authorize another submission when every listed request is a different job", async () => {
  const store = new MemoryStore();
  await seed(store, pausedJob({ oneSubmissionAllowed: true }));
  const resumePolling = vi.fn(async () => ({ started: true }));
  const logs: unknown[] = [];
  const result = await reconcileUnknownSubmission({
    store,
    owner,
    jobId,
    lookup: guarded({
      async requests() {
        return [{ id: "unrelated" }];
      },
      async status(id) {
        return { id, input: identity({ stage: "round1", attempt: 4 }) };
      },
    }),
    log: (entry) => logs.push(entry),
    resumePolling,
    now: "2026-09-24T01:00:00.000Z",
  });
  expect(result).toEqual({ outcome: "unresolved", resubmitted: false });
  expect(resumePolling).not.toHaveBeenCalled();
  expect(await stored(store)).toMatchObject({
    status: "paused",
    revision: 3,
    error: expect.stringContaining("outcome unknown"),
  });
  expect((await stored(store)).oneSubmissionAllowed).toBeUndefined();
  expect((await stored(store)).runpodId).toBeUndefined();
  expect((await store.get(pk, sk))?.version).toBe(1);
  expect(logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "check-runpod",
        inspected: ["unrelated"],
      }),
      expect.objectContaining({
        action: "refuse",
        reason: "list-is-not-submission-history",
      }),
    ]),
  );
  expect(JSON.stringify(logs)).not.toContain("unreadable");
});

it("leaves an empty request list unresolved and does not grant a submission", async () => {
  const store = new MemoryStore();
  await seed(store);
  const resumePolling = vi.fn(async () => ({ started: true }));
  const result = await reconcileUnknownSubmission({
    store,
    owner,
    jobId,
    lookup: guarded({
      async requests() {
        return [];
      },
      async status() {
        throw new Error("status");
      },
    }),
    log: () => {},
    resumePolling,
  });
  expect(result).toEqual({ outcome: "unresolved", resubmitted: false });
  expect(resumePolling).not.toHaveBeenCalled();
  expect((await store.get(pk, sk))?.version).toBe(0);
  expect((await stored(store)).oneSubmissionAllowed).toBeUndefined();
  expect((await stored(store)).status).toBe("paused");
});

it("replaces a not-submitted allowance when a provider id appears later", async () => {
  const store = new MemoryStore();
  await seed(store, pausedJob({ oneSubmissionAllowed: true }));
  const resumePolling = vi.fn(async () => ({ started: false }));
  const result = await reconcileUnknownSubmission({
    store,
    owner,
    jobId,
    lookup: guarded({
      async requests() {
        return [{ id: "provider-2" }];
      },
      async status(id) {
        return {
          id,
          input: identity({ parameterBase64: "different-public-parameter" }),
        };
      },
    }),
    log: () => {},
    resumePolling,
  });
  expect(result).toMatchObject({
    outcome: "provider-id",
    providerId: "provider-2",
    resubmitted: false,
  });
  expect(await stored(store)).toMatchObject({
    status: "searching",
    runpodId: "provider-2",
  });
  expect((await stored(store)).oneSubmissionAllowed).toBeUndefined();
});

it("resumes polling for a stored provider id that the request list no longer shows", async () => {
  const store = new MemoryStore();
  await seed(
    store,
    pausedJob({
      status: "searching",
      runpodId: "provider-kept",
      error: undefined,
      revision: 4,
    }),
  );
  const resumePolling = vi.fn(async () => ({ started: false }));
  const result = await reconcileUnknownSubmission({
    store,
    owner,
    jobId,
    lookup: guarded({
      async requests() {
        return [];
      },
      async status(id) {
        expect(id).toBe("provider-kept");
        return { id, input: identity() };
      },
    }),
    log: () => {},
    resumePolling,
  });
  expect(result).toMatchObject({
    outcome: "provider-id",
    providerId: "provider-kept",
    resubmitted: false,
  });
  expect(resumePolling).toHaveBeenCalledTimes(1);
  expect((await stored(store)).revision).toBe(4);
  expect((await stored(store)).oneSubmissionAllowed).toBeUndefined();
});

it("records neither outcome when the provider check is ambiguous or incomplete", async () => {
  const store = new MemoryStore();
  await seed(store);
  const resumePolling = vi.fn(async () => ({ started: true }));
  await expect(
    reconcileUnknownSubmission({
      store,
      owner,
      jobId,
      lookup: guarded({
        async requests() {
          return [{ id: "provider-a" }, { id: "provider-b" }];
        },
        async status(id) {
          return { id, input: identity() };
        },
      }),
      log: () => {},
      resumePolling,
    }),
  ).rejects.toThrow("AmbiguousProviderMatch");
  expect((await store.get(pk, sk))?.version).toBe(0);
  expect(resumePolling).not.toHaveBeenCalled();
  const seen: string[] = [];
  const logs: unknown[] = [];
  const unresolved = await reconcileUnknownSubmission({
    store,
    owner,
    jobId,
    lookup: guarded({
      async requests() {
        return [{ id: "provider-a" }, { id: "provider-1" }];
      },
      async status(id) {
        seen.push(id);
        if (id === "provider-a") return { id, status: "COMPLETED" };
        return { id, input: identity() };
      },
    }),
    log: (entry) => logs.push(entry),
    resumePolling,
  });
  expect(unresolved).toEqual({ outcome: "unresolved", resubmitted: false });
  expect(seen).toEqual(["provider-a", "provider-1"]);
  expect(resumePolling).not.toHaveBeenCalled();
  expect(logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "check-runpod",
        inspected: ["provider-a", "provider-1"],
        unreadable: ["provider-a"],
      }),
    ]),
  );
  expect(await stored(store)).toMatchObject({
    status: "paused",
    revision: 3,
  });
  expect((await stored(store)).oneSubmissionAllowed).toBeUndefined();
  expect((await stored(store)).runpodId).toBeUndefined();
});

it("does not reconcile a paused job that is not an unknown submission", async () => {
  const store = new MemoryStore();
  await seed(
    store,
    pausedJob({
      error: "Search range exhausted; a reviewed new range is required.",
    }),
  );
  await expect(
    reconcileUnknownSubmission({
      store,
      owner,
      jobId,
      lookup: guarded({
        async requests() {
          return [];
        },
        async status() {
          throw new Error("status");
        },
      }),
      log: () => {},
      resumePolling: async () => ({ started: true }),
    }),
  ).rejects.toThrow("UnknownSubmissionRequired");
  expect((await store.get(pk, sk))?.version).toBe(0);
});

it("lists Runpod requests with GET and keeps status input", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    if (String(url).endsWith("/requests"))
      return new Response(
        JSON.stringify({ requests: [{ id: "provider-9" }] }),
        {
          status: 200,
        },
      );
    return new Response(
      JSON.stringify({
        id: "provider-9",
        status: "IN_PROGRESS",
        input: identity(),
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const endpoint = new Runpod("endpoint", "synthetic-test-key");
  await expect(endpoint.requests()).resolves.toEqual([{ id: "provider-9" }]);
  await expect(endpoint.status("provider-9")).resolves.toMatchObject({
    id: "provider-9",
    status: "IN_PROGRESS",
    input: expect.objectContaining({ manifestHash: "a".repeat(64) }),
  });
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
    "https://api.runpod.ai/v2/endpoint/requests",
    "https://api.runpod.ai/v2/endpoint/status/provider-9",
  ]);
  expect(
    fetchMock.mock.calls.every(
      ([, init]) => (init as RequestInit).method === "GET",
    ),
  ).toBe(true);
});

it("keeps the operator step from submitting", () => {
  for (const path of [
    "server/reconcile-submission.ts",
    "scripts/reconcile-submission.ts",
  ]) {
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain(".run(");
    expect(source).not.toContain("cancel(");
    expect(source).not.toContain("oneSubmissionAllowed = true");
  }
  expect(release.mainnetEnabled).toBe(false);
  expect("broadcastAuthorized" in release).toBe(false);
});
