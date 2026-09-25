import { expect, it } from "vitest";
import { gpuSpendLimits, gpuSpendSchema } from "../server/gpu-spend";
import { workRange } from "../server/search-ranges";
it("permits reviewed bounded values without four matching hard-coded constants", () => {
  expect(
    gpuSpendSchema.parse({ ...gpuSpendLimits, maxJobAttempts: 20000 })
      .maxJobAttempts,
  ).toBe(20000);
  for (const maxJobAttempts of [0, -1, 1.5, 1000001, Infinity, NaN])
    expect(() =>
      gpuSpendSchema.parse({ ...gpuSpendLimits, maxJobAttempts }),
    ).toThrow();
});
it("leaves room for both complete subset partitions and pinning", () => {
  expect(workRange("round1", 4828).count).toBeGreaterThan(0);
  expect(() => workRange("round1", 4829)).toThrow("exhausted");
  expect(gpuSpendLimits.maxJobAttempts - 2 * 4829).toBeGreaterThan(8192);
});
