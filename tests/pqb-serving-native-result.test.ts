import { expect, it } from "vitest";
import { completedNativeReceipt, supersededCancellation } from "../ops/pqb-serving/native-result";

const canceled = { status: "FAILED", statusReason: "QSB operator/coordinator cancellation", stoppedAt: 200 };
it("retains partial cancellation without awarding completion or hits", () => {
  expect(completedNativeReceipt(canceled, "failed")).toBe(false);
  expect(completedNativeReceipt(canceled, "interrupted")).toBe(false);
  expect(completedNativeReceipt(canceled, "completed")).toBe(true);
  expect(() => completedNativeReceipt({ status: "SUCCEEDED" }, "failed")).toThrow();
  expect(() => completedNativeReceipt({ ...canceled, statusReason: "worker failure" }, "failed")).toThrow();
  expect(() => completedNativeReceipt({ status: "RUNNING" }, "failed")).toThrow();
});
it("requires an earlier independently validated winner for the same packet", () => {
  expect(() => supersededCancellation(canceled, [100])).not.toThrow();
  for (const winners of [[], [201], [NaN], [-1]])
    expect(() => supersededCancellation(canceled, winners)).toThrow();
  expect(() => supersededCancellation({ ...canceled, statusReason: "worker failure" }, [100])).toThrow();
  expect(() => supersededCancellation({ ...canceled, stoppedAt: undefined }, [100])).toThrow();
});
