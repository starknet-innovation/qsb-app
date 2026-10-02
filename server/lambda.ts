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

type FunctionUrlEvent = {
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string; timeEpoch?: number; http?: { method?: string; path?: string } };
};

// The viewer headers CloudFront adds to each request it forwards (its AllViewerExceptHostHeader origin request
// policy, terraform/web.tf), each logged only in the form CloudFront gives it: the caller's IP address and source
// port, its two-letter country, its network's AS number, and CloudFront's ID for the request.
const VIEWER = {
  address: ["cloudfront-viewer-address", /^[0-9A-Fa-f.:[\]]{3,64}$/],
  country: ["cloudfront-viewer-country", /^[A-Z]{2}$/],
  asn: ["cloudfront-viewer-asn", /^[0-9]{1,10}$/],
  cfId: ["x-amz-cf-id", /^[A-Za-z0-9_-]{54}==$/],
} as const;

function viewer(headers: FunctionUrlEvent["headers"], name: keyof typeof VIEWER) {
  const [header, shape] = VIEWER[name];
  const value = headers?.[header];
  return value !== undefined && shape.test(value) ? value : undefined;
}

/**
 * The function URL's handler, which CloudFront calls through origin access control. It writes one access log
 * line per request, in the API's log group: the time, method, path and status, this request's ID, the caller's
 * address, country and network as CloudFront saw them, and CloudFront's request ID (`cfId`).
 */
export async function handler(event: Parameters<typeof respond>[0], context?: Parameters<typeof respond>[1]) {
  const response = await respond(event, context);
  const { headers, requestContext } = event as FunctionUrlEvent;
  const time = requestContext?.timeEpoch;
  console.log(
    JSON.stringify({
      access: {
        time: typeof time === "number" ? new Date(time).toISOString() : undefined,
        method: requestContext?.http?.method,
        path: requestContext?.http?.path,
        status: response.statusCode,
        requestId: requestContext?.requestId,
        cfId: viewer(headers, "cfId"),
        caller: { address: viewer(headers, "address"), country: viewer(headers, "country"), asn: viewer(headers, "asn") },
      },
    }),
  );
  return response;
}
