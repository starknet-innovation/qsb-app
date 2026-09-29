import { Resolver as DnsResolver } from "node:dns/promises";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { within, type Resolver, type WebhookTransport } from "./webhooks";

/** Answers that mean "no such records", not a failed lookup. */
const NO_RECORDS = new Set(["ENODATA", "ENOTFOUND"]);

/**
 * A and AAAA through c-ares, which runs off the libuv threadpool, so a slow name server
 * can't hold threads other work needs. Cancelled at the timeout. A family whose lookup
 * fails is left out; the caller connects only to an address it has checked.
 */
export const systemResolver: Resolver = async (hostname, timeoutMs) => {
  const resolver = new DnsResolver({ timeout: Math.max(1, Math.min(timeoutMs, 1000)), tries: 1 });
  const family = (query: Promise<string[]>, family: 4 | 6) =>
    query.then(
      (addresses) => addresses.map((address) => ({ address, family })),
      (error: NodeJS.ErrnoException) => {
        if (NO_RECORDS.has(error.code ?? "")) return [];
        throw error;
      },
    );
  try {
    const answers = await within(
      Promise.allSettled([family(resolver.resolve4(hostname), 4), family(resolver.resolve6(hostname), 6)]),
      timeoutMs,
    );
    const found = answers.flatMap((a) => (a.status === "fulfilled" ? a.value : []));
    if (!found.length && answers.some((a) => a.status === "rejected"))
      throw new Error("Lookup failed");
    return found;
  } finally {
    resolver.cancel();
  }
};

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
