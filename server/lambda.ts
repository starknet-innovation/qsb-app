import { handle } from "hono/aws-lambda";
import { NETWORK_ID, type NetworkId } from "../src/lib/network";
import { createSupervisedCreationApp } from "../supervised/dispatch/routes";
import { createApp } from "./app";
import { store, type Store } from "./store";

/**
 * Deployed API. Mainnet job creation is createApp's POST /api/jobs, then
 * startWorkflow, then the Step Functions coordinator. That entry does not
 * mount installSupervisedCreation.
 */
export function deployedApiApp(
  network: NetworkId = NETWORK_ID,
  records: Store = store,
) {
  if (network === "mainnet") return createApp(records);
  return createSupervisedCreationApp(records, {
    enabled: process.env.SUPERVISED_EXECUTION_ENABLED === "true",
  });
}

export const handler = handle(deployedApiApp());
