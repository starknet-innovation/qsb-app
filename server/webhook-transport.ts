import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import type { Resolver, WebhookTransport } from "./webhooks";

export const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family,
  }));

/**
 * One HTTPS POST to the checked address. The connection uses that address, never a fresh
 * lookup (no DNS rebinding), while TLS still verifies the certificate for the host name.
 * No redirects are followed, the response body is discarded, and the whole request is
 * aborted at its timeout.
 */
export const httpsTransport: WebhookTransport = (req) =>
  new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const pinned: LookupFunction = (_hostname, options, callback) =>
      options.all
        ? (callback as (e: null, a: { address: string; family: number }[]) => void)(null, [
            { address: req.address, family: req.family },
          ])
        : callback(null, req.address, req.family);
    const outgoing = request(
      {
        method: "POST",
        hostname: req.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        headers: { ...req.headers, "content-length": String(Buffer.byteLength(req.body)) },
        lookup: pinned,
        agent: false,
        signal: AbortSignal.timeout(req.timeoutMs),
      },
      (response) => {
        resolve({ status: response.statusCode ?? 0 });
        response.destroy();
      },
    );
    outgoing.on("error", reject);
    outgoing.end(req.body);
  });
