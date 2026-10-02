import { afterEach, expect, it, vi } from "vitest";
import { handler } from "../server/lambda";

afterEach(() => vi.restoreAllMocks());

// A Lambda function URL request as CloudFront's origin access control delivers it (payload format 2.0):
// CloudFront's own SigV4 signature in Authorization, the client's credential in X-Qsb-Authorization.
const event = (method: string, path: string) => ({
  version: "2.0",
  routeKey: "$default",
  rawPath: path,
  rawQueryString: "",
  headers: {
    host: "abcdefghijklmnopqrstuvwxyz234567.lambda-url.eu-west-2.on.aws",
    authorization: "AWS4-HMAC-SHA256 Credential=EXAMPLE/20261001/eu-west-2/lambda/aws4_request, Signature=0",
  },
  requestContext: {
    accountId: "anonymous",
    apiId: "abcdefghijklmnopqrstuvwxyz234567",
    domainName: "abcdefghijklmnopqrstuvwxyz234567.lambda-url.eu-west-2.on.aws",
    domainPrefix: "abcdefghijklmnopqrstuvwxyz234567",
    http: { method, path, protocol: "HTTP/1.1", sourceIp: "203.0.113.7", userAgent: "Amazon CloudFront" },
    requestId: "req-1",
    routeKey: "$default",
    stage: "$default",
    time: "01/Oct/2026:12:00:00 +0000",
    timeEpoch: 1790856000000,
  },
  isBase64Encoded: false,
});

it("serves the API from a function URL event and logs one access line without the caller", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const health = await handler(event("GET", "/v1/health") as never);
  expect(health.statusCode).toBe(200);
  expect(JSON.parse(health.body)).toEqual({ ok: true, network: "mainnet" });
  // CloudFront's signature in Authorization is no credential: an authenticated route is refused.
  const vaults = await handler(event("GET", "/v1/vaults") as never);
  expect(vaults.statusCode).toBe(401);
  expect(JSON.parse(vaults.body)).toMatchObject({ code: "auth_required" });
  const lines = log.mock.calls.map(([line]) => String(line));
  expect(lines).toEqual([
    JSON.stringify({ access: { requestId: "req-1", status: 200 } }),
    JSON.stringify({ access: { requestId: "req-1", status: 401 } }),
  ]);
  expect(lines.join("\n")).not.toContain("203.0.113.7");
});
