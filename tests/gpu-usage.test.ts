import { describe, expect, it } from "vitest";
import { meterChunk } from "../server/gpu-usage";
import type { ComputeStatus } from "../server/aws-batch";
import type { Job, SearchSlot } from "../src/lib/model";

const meter = (status: ComputeStatus["status"], timing?: ComputeStatus["timing"]) => {
  const job = {} as Job;
  const slot = {} as SearchSlot;
  const changed = meterChunk(job, slot, { id: "c", status, ...(timing ? { timing } : {}) });
  return { changed, usage: job.usage, metered: slot.metered };
};

describe("meterChunk", () => {
  it("takes run and queue time independently, and flags a chunk missing either", () => {
    expect(meter("COMPLETED", { createdAt: 0, startedAt: 10, stoppedAt: 70 }).usage).toEqual({
      chunks: 1, failed: 0, runMs: 60, queueMs: 10, unmeasured: 0,
    });
    // Queue time is known even though the stop time is missing.
    expect(meter("FAILED", { createdAt: 0, startedAt: 10 }).usage).toEqual({
      chunks: 1, failed: 1, runMs: 0, queueMs: 10, unmeasured: 1,
    });
    // Run time is known even though the submission time is missing.
    expect(meter("FAILED", { startedAt: 10, stoppedAt: 70 }).usage).toEqual({
      chunks: 1, failed: 1, runMs: 60, queueMs: 0, unmeasured: 1,
    });
    // Out-of-order times count as missing.
    expect(meter("FAILED", { createdAt: 50, startedAt: 10, stoppedAt: 5 }).usage).toEqual({
      chunks: 1, failed: 1, runMs: 0, queueMs: 0, unmeasured: 1,
    });
    expect(meter("COMPLETED").usage).toMatchObject({ chunks: 1, unmeasured: 1 });
    // A completed chunk ran, so a missing start time leaves both intervals unknown.
    expect(meter("COMPLETED", { createdAt: 0, stoppedAt: 70 }).usage).toEqual({
      chunks: 1, failed: 0, runMs: 0, queueMs: 0, unmeasured: 1,
    });
  });

  it("measures a chunk that never started as queued until it stopped, with no run time", () => {
    expect(meter("CANCELLED", { createdAt: 0, stoppedAt: 30 }).usage).toEqual({
      chunks: 1, failed: 1, runMs: 0, queueMs: 30, unmeasured: 0,
    });
  });

  it("ignores running chunks and chunks already metered", () => {
    expect(meter("IN_PROGRESS", { createdAt: 0, startedAt: 10 })).toEqual({
      changed: false, usage: undefined, metered: undefined,
    });
    const job = {} as Job;
    const slot = { metered: true } as SearchSlot;
    expect(meterChunk(job, slot, { id: "c", status: "COMPLETED", timing: { createdAt: 0, startedAt: 1, stoppedAt: 2 } })).toBe(false);
    expect(job.usage).toBeUndefined();
  });
});
