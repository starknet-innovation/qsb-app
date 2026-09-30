// The unit suite never reaches the network. Every test either injects a fake
// transport or talks to an in-process app, so a real request means a test (or a
// default such as `new Esplora()` against blockstream.info) escaped its stubs.
// Loopback stays open for the SDK fixture and any local server a test starts.
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

// The AWS SDK's default credential chain would otherwise probe the instance
// metadata endpoint when a test constructs a client without mocking `send`.
process.env.AWS_EC2_METADATA_DISABLED = "true";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function loopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK.has(host) || host.endsWith(".localhost");
}
function blocked(origin: string): Error {
  return new Error(
    `Network access is blocked in unit tests (${origin}). Inject a fake transport or a loopback server instead.`,
  );
}

const realFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  const target = input instanceof Request ? input.url : String(input);
  let url: URL;
  try {
    url = new URL(target, "http://127.0.0.1");
  } catch {
    return realFetch(input, init);
  }
  if (!loopback(url.hostname)) return Promise.reject(blocked(url.origin));
  return realFetch(input, init);
} as typeof fetch;

type RequestArgs = Parameters<typeof http.request>;
function hostOf(args: RequestArgs): string {
  const [first, second] = args;
  if (typeof first === "string" || first instanceof URL)
    return new URL(String(first)).hostname;
  const options = (first ?? second) as http.RequestOptions | undefined;
  return options?.hostname ?? options?.host ?? "localhost";
}
for (const mod of [http, https]) {
  const request = mod.request.bind(mod), get = mod.get.bind(mod);
  mod.request = ((...args: RequestArgs) => {
    const host = hostOf(args);
    if (!loopback(host)) throw blocked(host);
    return request(...args);
  }) as typeof mod.request;
  mod.get = ((...args: RequestArgs) => {
    const host = hostOf(args);
    if (!loopback(host)) throw blocked(host);
    return get(...args);
  }) as typeof mod.get;
}
// Named ESM imports of the builtins (`import { request } from "https"`) are
// updated only when asked.
syncBuiltinESMExports();
