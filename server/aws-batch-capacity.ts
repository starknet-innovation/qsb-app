import capacity from "./aws-batch-capacity.json";
import { gpuSpendLimits } from "./gpu-spend";

/** Same single-A10G worker on every size; reserve AWS's one-host overshoot allowance. */
export function productionCapacity() {
  const vcpuCeiling = capacity.vcpusPerWorkerBudget * gpuSpendLimits.workersMax;
  const hosts = Object.entries(capacity.instanceTypes);
  const fallback = hosts.filter(([, host]) => host.vcpus <= vcpuCeiling / 2);
  const allowed = fallback.length ? fallback : hosts.filter(([, host]) => host.vcpus <= vcpuCeiling);
  if (!allowed.length) throw new Error("ProviderCapacityInvalid");
  const largestHostVcpus = Math.max(...allowed.map(([, host]) => host.vcpus));
  const allocationStrategy = allowed.length > 1 ? "BEST_FIT_PROGRESSIVE" : "BEST_FIT";
  const maxVcpus = vcpuCeiling - (allowed.length > 1 ? largestHostVcpus : 0);
  const parallelismLimit = Math.min(gpuSpendLimits.workersMax, Math.floor(maxVcpus / largestHostVcpus));
  if (parallelismLimit < 1) throw new Error("ProviderCapacityInvalid");
  return { instanceTypes: allowed.map(([type]) => type), allocationStrategy, maxVcpus, vcpuCeiling, parallelismLimit };
}
