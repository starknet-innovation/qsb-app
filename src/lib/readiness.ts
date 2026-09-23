import { NETWORK_ID } from "./network";

// An absent, stale or cross-network configuration must never enable spending.
export function operationsAllowed(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const value = config as Record<string, unknown>;
  return value.network === NETWORK_ID &&
    (NETWORK_ID === "testnet4" ? value.operationsEnabled : (value.operationsEnabled ?? value.mainnetEnabled)) === true;
}
