import { beforeEach, expect, it, vi } from "vitest";
import { validationTick } from "../server/validation-search";
import { MemoryStore } from "../server/store";
import { release, type Job } from "../src/lib/model";
import { workRange } from "../server/search-ranges";
const event = { owner: "regtest:fixture", jobId: "proof", revision: 0 };
let store: MemoryStore;
let provider: any;
let cpu: any;
const pk = "OWNER#" + event.owner,
  sk = "JOB#proof";
async function tick() {
  return validationTick(
    event,
    (await store.get(pk, sk))!,
    store,
    provider,
    cpu,
  );
}
beforeEach(async () => {
  store = new MemoryStore();
  let count = 0;
  provider = {
    run: vi.fn(async () => ({ id: "gpu-" + count++ })),
    status: vi.fn(async () => ({ status: "IN_PROGRESS" })),
    cancel: vi.fn(async () => ({ status: "CANCELLED" })),
  };
  cpu = vi.fn(async (input: any) =>
    input.action === "export"
      ? { parameterBase64: "public", parameterSha256: "b".repeat(64) }
      : { valid: false },
  );
  await store.put({
    pk,
    sk,
    version: 0,
    job: {
      id: "proof",
      owner: event.owner,
      vaultId: "v",
      status: "queued",
      stage: "pinning",
      revision: 0,
      attempt: 0,
      computeSeconds: 0,
      manifestHash: "a".repeat(64),
      manifest: {},
    } as Job,
    validation: {
      network: "regtest",
      slots: 2,
      nextAttempt: 0,
      active: [],
      cancel: [],
      completed: 0,
      candidatesChecked: 0,
    },
  });
  await store.put({
    pk,
    sk: "VAULT#v",
    version: 0,
    validationNetwork: "regtest",
    vault: { publicStateJson: "{}" },
  });
});
function completed(attempt: number, candidates: string[] = []) {
  return {
    status: "COMPLETED",
    executionTime: 1000,
    output: {
      status: "completed",
      stage: "pinning",
      attempt,
      manifestHash: "a".repeat(64),
      kernelCommit: release.kernelCommit,
      checkpoint: "range-complete",
      candidates,
      workRange: workRange("pinning", attempt),
    },
  };
}
it("submits disjoint work slots, caches public exports and preserves uncompleted work", async () => {
  await tick();
  await tick();
  await tick();
  expect(provider.run.mock.calls.map((x: any) => x[0].attempt)).toEqual([0, 1]);
  expect(cpu).toHaveBeenCalledTimes(1);
  provider.status.mockImplementation(async (id: string) =>
    id === "gpu-0" ? completed(0) : { status: "IN_PROGRESS" },
  );
  await tick();
  expect(provider.run.mock.calls.map((x: any) => x[0].attempt)).toEqual([
    0, 1, 2,
  ]);
  expect((await store.get(pk, sk))?.validation).toMatchObject({
    completed: 1,
    nextAttempt: 3,
    active: [
      { attempt: 1, id: "gpu-1" },
      { attempt: 2, id: "gpu-2" },
    ],
  });
});
it("never duplicates an ambiguous paid submission", async () => {
  provider.run.mockRejectedValue(Error("timeout"));
  await expect(tick()).rejects.toThrow("timeout");
  await tick();
  await tick();
  expect(provider.run).toHaveBeenCalledTimes(1);
  expect((await store.get(pk, sk))?.job).toMatchObject({
    status: "paused",
    error: expect.stringContaining("outcome unknown"),
  });
  expect((await store.get(pk, sk))?.validation).toMatchObject({
    interrupted: [{ attempt: 0 }],
  });
});
it("rejects mainnet or unmarked vaults even when invoked directly", async () => {
  const row = (await store.get(pk, sk))!;
  await expect(
    validationTick(
      { ...event, owner: "bc1qexample" },
      row,
      store,
      provider,
      cpu,
    ),
  ).rejects.toThrow("InvalidValidationOwner");
  const v = (await store.get(pk, "VAULT#v"))!;
  await store.put({ ...v, version: 1, validationNetwork: "mainnet" }, 0);
  await expect(tick()).rejects.toThrow("InvalidValidationVault");
  expect(provider.run).not.toHaveBeenCalled();
});
it("retains a failed range for reconciliation instead of silently skipping it", async () => {
  await tick();
  provider.status.mockResolvedValue({ status: "TIMED_OUT" });
  await tick();
  await tick();
  expect((await store.get(pk, sk))?.validation).toMatchObject({
    interrupted: [{ attempt: 0, id: "gpu-0" }],
    completed: 0,
  });
  expect(provider.run).toHaveBeenCalledTimes(1);
});
it("only an independently checked pin starts round one, cancelling sibling work first", async () => {
  await tick();
  await tick();
  provider.status.mockImplementation(async (id: string) =>
    id === "gpu-0"
      ? completed(0, ["public candidate"])
      : { status: "IN_PROGRESS" },
  );
  cpu.mockImplementation(async (input: any) =>
    input.action === "verify"
      ? { valid: true, sequence: 2147483648, locktime: 500000000 }
      : { parameterBase64: "public", parameterSha256: "b".repeat(64) },
  );
  await tick();
  expect((await store.get(pk, sk))?.job).toMatchObject({
    stage: "round1",
    solution: { sequence: 2147483648, locktime: 500000000 },
  });
  expect((await store.get(pk, sk))?.validation).toMatchObject({
    cancel: ["gpu-1"],
    active: [],
  });
  await tick();
  expect(provider.cancel).toHaveBeenCalledWith("gpu-1");
  expect(provider.run).toHaveBeenCalledTimes(2);
});
it("pauses when a purported completed range has the wrong boundaries", async () => {
  await tick();
  const result = completed(0);
  result.output.workRange.count--;
  provider.status.mockResolvedValue(result);
  await expect(tick()).rejects.toThrow("ValidationRangeMismatch");
  expect(provider.run).toHaveBeenCalledTimes(1);
});

it("selects a fresh pin after an exhaustive digest round has no usable solution", async () => {
  const row = (await store.get(pk, sk))!;
  await store.put(
    {
      ...row,
      version: 1,
      job: {
        ...(row.job as Job),
        stage: "round2",
        solution: {
          sequence: 2147483648,
          locktime: 500000000,
          round1: [141, 142, 143, 144, 145, 146, 147, 148, 149],
          round2: [],
        },
      },
      validation: {
        ...(row.validation as any),
        nextAttempt: 4829,
        nextPinAttempt: 42,
      },
    },
    0,
  );
  await tick();
  const next = (await store.get(pk, sk))!;
  expect(next.job).toMatchObject({ stage: "pinning", status: "queued" });
  expect((next.job as Job).solution).toBeUndefined();
  expect(next.validation).toMatchObject({ nextAttempt: 42, pinRestarts: 1 });
  expect(provider.run).not.toHaveBeenCalled();
});

it("does not submit when the durable submit-intent write fails", async () => {
  const write = store.put.bind(store);
  vi.spyOn(store, "put").mockImplementation(async (row, expected) => {
    const active = (row.validation as any)?.active;
    if (active?.some((unit: any) => !unit.id))
      throw Error("Dynamo unavailable");
    return write(row, expected);
  });
  await expect(tick()).rejects.toThrow("Dynamo unavailable");
  expect(provider.run).not.toHaveBeenCalled();
  expect((await store.get(pk, sk))?.validation).toMatchObject({
    nextAttempt: 0,
    active: [],
  });
});
it("preserves an unknown submission after the provider accepted work but its id write failed", async () => {
  const write = store.put.bind(store);
  const fault = vi
    .spyOn(store, "put")
    .mockImplementation(async (row, expected) => {
      if ((row.validation as any)?.active.some((unit: any) => unit.id))
        throw Error("lost id persistence");
      return write(row, expected);
    });
  await expect(tick()).rejects.toThrow("lost id persistence");
  fault.mockRestore();
  await tick();
  await tick();
  expect(provider.run).toHaveBeenCalledTimes(1);
  expect((await store.get(pk, sk))?.validation).toMatchObject({
    interrupted: [{ attempt: 0 }],
  });
  expect((await store.get(pk, sk))?.job).toMatchObject({ status: "paused" });
});
it("duplicate coordinator invocations cannot both submit the same paid range", async () => {
  const row = (await store.get(pk, sk))!;
  const results = await Promise.allSettled([
    validationTick(event, structuredClone(row), store, provider, cpu),
    validationTick(event, structuredClone(row), store, provider, cpu),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(provider.run).toHaveBeenCalledTimes(1);
  expect(provider.run.mock.calls[0][0].attempt).toBe(0);
});
it("restarts from persisted ids after a transient provider read failure", async () => {
  await tick();
  provider.status.mockRejectedValueOnce(Error("network unavailable"));
  await expect(tick()).rejects.toThrow("network unavailable");
  provider.status.mockResolvedValue({ status: "IN_PROGRESS" });
  await tick();
  expect(provider.run.mock.calls.map((x: any) => x[0].attempt)).toEqual([0, 1]);
  expect((await store.get(pk, sk))?.validation).toMatchObject({ completed: 0 });
});
it("does not finish a pause until provider cancellation is terminal", async () => {
  await tick();
  const row = (await store.get(pk, sk))!;
  await store.put(
    {
      ...row,
      version: row.version + 1,
      job: { ...(row.job as Job), status: "paused" },
    },
    row.version,
  );
  expect(await tick()).toMatchObject({ done: false });
  expect(await tick()).toMatchObject({ done: false });
  expect((await store.get(pk, sk))?.validation).toMatchObject({
    cancel: ["gpu-0"],
  });
  provider.status.mockResolvedValue({
    status: "CANCELLED",
    executionTime: 2000,
  });
  await tick();
  expect(await tick()).toMatchObject({ done: true });
  expect((await store.get(pk, sk))?.job).toMatchObject({ computeSeconds: 2 });
  expect(provider.run).toHaveBeenCalledTimes(1);
});
it("does not double count a completed range if Dynamo fails before its checkpoint commits", async () => {
  await tick();
  provider.status.mockResolvedValue(completed(0));
  const fault = vi
    .spyOn(store, "put")
    .mockRejectedValueOnce(Error("checkpoint unavailable"));
  await expect(tick()).rejects.toThrow("checkpoint unavailable");
  fault.mockRestore();
  await tick();
  expect((await store.get(pk, sk))?.validation).toMatchObject({ completed: 1 });
  expect((await store.get(pk, sk))?.job).toMatchObject({ computeSeconds: 1 });
});

it("rejects an unsupported pinned release before any provider request", async () => {
  const row = (await store.get(pk, sk))!;
  (row.job as Job).solver = {
    descriptor: { id: "unknown-future-release" },
    releaseHash: "a".repeat(64),
    vaultConfigurationHash: "b".repeat(64),
  } as any;
  await store.put({ ...row, version: row.version + 1 }, row.version);
  await expect(tick()).rejects.toThrow("UnsupportedSolverRelease");
  expect(provider.run).not.toHaveBeenCalled();
  expect(provider.status).not.toHaveBeenCalled();
  expect(cpu).not.toHaveBeenCalled();
});
