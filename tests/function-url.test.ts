import { afterEach, expect, it, vi } from "vitest";
import { handler } from "../server/lambda";

afterEach(() => vi.restoreAllMocks());

// A Lambda function URL request as CloudFront's origin access control delivers it (payload format 2.0):
// CloudFront's own SigV4 signature in Authorization, the client's credential in X-Qsb-Authorization.
// CloudFront's viewer headers, as its AllViewerExceptHostHeader policy forwards them. The request ID is from the
// example log in CloudFront's standard logging reference.
const CF_ID = "SOX4xwn4XV6Q4rgb7XiVGOHms_BGlTAC4KyHmureZmBNrjGdRLiNIQ==";
const viewer = {
  "cloudfront-viewer-address": "198.51.100.10:46532",
  "cloudfront-viewer-country": "GB",
  "cloudfront-viewer-asn": "64496",
  "x-amz-cf-id": CF_ID,
};

const event = (method: string, path: string, headers: Record<string, string> = viewer) => ({
  version: "2.0",
  routeKey: "$default",
  rawPath: path,
  rawQueryString: "",
  headers: {
    host: "abcdefghijklmnopqrstuvwxyz234567.lambda-url.eu-west-2.on.aws",
    authorization: "AWS4-HMAC-SHA256 Credential=EXAMPLE/20261001/eu-west-2/lambda/aws4_request, Signature=0",
    ...headers,
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

it("serves the API from a function URL event and logs one access line with the caller CloudFront saw", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const health = await handler(event("GET", "/v1/health") as never);
  expect(health.statusCode).toBe(200);
  expect(JSON.parse(health.body)).toEqual({ ok: true, network: "mainnet" });
  // CloudFront's signature in Authorization is no credential: an authenticated route is refused.
  const vaults = await handler(event("GET", "/v1/vaults") as never);
  expect(vaults.statusCode).toBe(401);
  expect(JSON.parse(vaults.body)).toMatchObject({ code: "auth_required" });
  const lines = log.mock.calls.map(([line]) => String(line));
  const line = (path: string, status: number) =>
    JSON.stringify({
      access: {
        time: "2026-10-01T12:00:00.000Z",
        method: "GET",
        path,
        status,
        requestId: "req-1",
        cfId: CF_ID,
        caller: { address: "198.51.100.10:46532", country: "GB", asn: "64496" },
      },
    });
  expect(lines).toEqual([line("/v1/health", 200), line("/v1/vaults", 401)]);
  // The function URL's source address is CloudFront's, not the caller's.
  expect(lines.join("\n")).not.toContain("203.0.113.7");
  // Each line is one string, so it's a JSON record's string `message`, which the stray-payments filter's number
  // selector can't match whatever the path holds (terraform/workflow.tf).
  expect(log.mock.calls.every((args) => args.length === 1 && typeof args[0] === "string")).toBe(true);
});

it("logs each viewer header only in the form CloudFront gives it", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  // CloudFront writes an IPv6 caller as the address with ":port" appended, without brackets.
  await handler(event("GET", "/v1/health", { "cloudfront-viewer-address": "2001:db8::1:443" }) as never);
  await handler(
    event("GET", "/v1/health", {
      "cloudfront-viewer-address": "[evil.example]:1",
      "cloudfront-viewer-country": "gbr",
      "cloudfront-viewer-asn": "AS64496",
      "x-amz-cf-id": "not-an-id",
    }) as never,
  );
  // A caller's own header next to CloudFront's arrives joined with a comma: each is left out.
  await handler(
    event("GET", "/v1/health", {
      "cloudfront-viewer-address": "192.0.2.1:1,198.51.100.10:46532",
      "cloudfront-viewer-country": "ZZ,GB",
      "cloudfront-viewer-asn": "1,64496",
      "x-amz-cf-id": `${CF_ID},${CF_ID}`,
    }) as never,
  );
  const [ipv6, malformed, joined] = log.mock.calls.map(([line]) => JSON.parse(String(line)).access);
  expect(ipv6.caller).toEqual({ address: "2001:db8::1:443" });
  expect(malformed.caller).toEqual({});
  expect(malformed.cfId).toBeUndefined();
  expect(joined.caller).toEqual({});
  expect(joined.cfId).toBeUndefined();
});
