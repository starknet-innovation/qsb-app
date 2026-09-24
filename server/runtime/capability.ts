import { fingerprint } from "../../src/lib/provenance";
import contract from "../mainnet-capability.json";
import type { Row, Store } from "../store";

export class GateError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  constructor(status: 400 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = "GateError";
    this.status = status;
  }
}

export function assertServiceChain(network: string): void {
  if (network !== "mainnet")
    throw new GateError(409, "This service chain is not Bitcoin mainnet.");
}

export async function assertSearchCapability(store: Store): Promise<Row> {
  const row = await store.get("SYSTEM#QSB_MAINNET_SERVICE", "CAPABILITY");
  if (
    !row ||
    row.enabled !== true ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    fingerprint(row.contract) !== fingerprint(contract) ||
    contract.broadcastAuthorized !== false
  )
    throw new GateError(503, "Supervised search capability is not active.");
  return row;
}
