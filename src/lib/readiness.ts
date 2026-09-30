import { NETWORK_ID } from "./network";

// An absent, stale or cross-network configuration must never enable spending.
export function operationsAllowed(config: unknown): boolean {
  if (!config || typeof config !== "object") return false;
  const value = config as Record<string, unknown>;
  return value.network === NETWORK_ID &&
    value.operationsEnabled === true;
}

/**
 * What the server's switches allow, for display: "on" when deposits and withdrawals can
 * be submitted, "search-only" when searches can start but nothing can be submitted to
 * MARA, "off" otherwise. Every status line in the app reads this, never a fixed string.
 */
export function serviceStatus(config: unknown): "on" | "search-only" | "off" {
  if (!operationsAllowed(config)) return "off";
  return (config as Record<string, unknown>).exactSubmitEnabled === true ? "on" : "search-only";
}
