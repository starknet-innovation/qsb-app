import { afterEach, expect, it, vi } from "vitest";
const workers = vi.hoisted(() => ({ value: 16 }));
vi.mock("../server/gpu-spend", () => ({ gpuSpendLimits: { get workersMax() { return workers.value; } } }));
import { productionCapacity } from "../server/aws-batch-capacity";
afterEach(() => { workers.value = 16; });
it("offers all reviewed A10G sizes with one-host overshoot headroom", () => {
  expect(productionCapacity()).toEqual({
    instanceTypes: ["g5.xlarge", "g5.2xlarge", "g5.4xlarge"],
    allocationStrategy: "BEST_FIT_PROGRESSIVE", maxVcpus: 240, vcpuCeiling: 256, parallelismLimit: 15,
  });
});
it.each(Array.from({ length: 16 }, (_, i) => i + 1))("keeps host and chunk bounds within a %i-worker budget", count => {
  workers.value = count;
  const c = productionCapacity();
  const sizes: Record<string, number> = { "g5.xlarge": 4, "g5.2xlarge": 8, "g5.4xlarge": 16 };
  const largest = Math.max(...c.instanceTypes.map(t => sizes[t]));
  const overshoot = c.allocationStrategy === "BEST_FIT_PROGRESSIVE" ? largest : 0;
  expect(c.maxVcpus + overshoot).toBeLessThanOrEqual(count * 16);
  expect(c.parallelismLimit).toBeGreaterThanOrEqual(1);
  expect(c.parallelismLimit).toBeLessThanOrEqual(count);
  expect(c.parallelismLimit * largest).toBeLessThanOrEqual(c.maxVcpus);
});
