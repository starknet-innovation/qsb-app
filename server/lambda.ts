import { handle } from "hono/aws-lambda";
import { createApp } from "./app";
import { store, type Store } from "./store";

/**
 * Deployed API. Mainnet job creation is createApp's POST /api/jobs, then
 * startWorkflow, then the Step Functions coordinator. QSB deploys on mainnet
 * only; src/lib/network.ts refuses any other QSB_NETWORK when it loads.
 */
export function deployedApiApp(records: Store = store) {
  return createApp(records, { versionedAlias: true });
}

export const handler = handle(deployedApiApp());
