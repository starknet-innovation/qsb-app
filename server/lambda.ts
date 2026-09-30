import { handle } from "hono/aws-lambda";
import { NETWORK_ID, type NetworkId } from "../src/lib/network";
import { createApp } from "./app";
import { store, type Store } from "./store";

/**
 * Deployed API. Mainnet job creation is createApp's POST /api/jobs, then
 * startWorkflow, then the Step Functions coordinator. QSB deploys on mainnet only.
 */
export function deployedApiApp(
  network: NetworkId = NETWORK_ID,
  records: Store = store,
) {
  if (network !== "mainnet") throw new Error("The deployed API serves mainnet only.");
  return createApp(records, { versionedAlias: true });
}

export const handler = handle(deployedApiApp());
