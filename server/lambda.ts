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

const respond = handle(deployedApiApp());

/**
 * The function URL's handler, which CloudFront calls through origin access control. It writes one access log
 * line per request, the request ID and status. Nothing about the caller.
 */
export async function handler(event: Parameters<typeof respond>[0], context?: Parameters<typeof respond>[1]) {
  const response = await respond(event, context);
  const requestId = (event as { requestContext?: { requestId?: unknown } }).requestContext?.requestId;
  console.log(JSON.stringify({ access: { requestId, status: response.statusCode } }));
  return response;
}
