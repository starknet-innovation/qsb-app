import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// The base path is fixed when the modules load, so load a fresh copy per network.
async function load(network: "mainnet" | "testnet4") {
  vi.resetModules();
  vi.stubEnv("VITE_QSB_NETWORK", undefined);
  delete process.env.VITE_QSB_NETWORK;
  vi.stubEnv("QSB_NETWORK", network);
  return {
    network: await import("../src/lib/network"),
    session: await import("../src/lib/session"),
    admission: await import("../src/mainnet/admissionClient"),
  };
}

// Mainnet's API serves /v1; a testnet4 build keeps /api (QSB deploys on mainnet only).
it.each([
  ["mainnet", "/v1"],
  ["testnet4", "/api"],
] as const)("the %s webapp calls the API under %s", async (network, base) => {
  const m = await load(network);
  expect(m.network.NETWORK_ID).toBe(network);
  expect(m.network.apiBasePath(network)).toBe(base);
  expect(m.network.API_BASE_PATH).toBe(base);
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ network }));
  }) as unknown as typeof fetch;
  await m.session.createSessionClient(fetcher).api("/config");
  const jobId = crypto.randomUUID(), requestId = crypto.randomUUID();
  // The reply isn't an admission; only the URL matters here.
  await expect(
    m.admission.currentAdmissionClient(jobId, requestId, () => "T".repeat(43), fetcher)(requestId),
  ).rejects.toThrow("Invalid admission response");
  expect(urls).toEqual([`${base}/config`, `${base}/jobs/${jobId}/mainnet-solved-state`]);
});

// A quoted string that starts with the whole /api or /v1 segment: `"/api-keys"` is a route, not a prefix.
const prefixLiteral = /["'`]\/(api|v1)(?=[/"'`?$])/;
it("flags a hard-coded prefix, not a route that starts with the same letters", () => {
  for (const flagged of [`"/api/jobs"`, `'/api'+path`, "`/api${path}`", `"/v1"`, `"/api?x=1"`])
    expect(prefixLiteral.test(flagged), flagged).toBe(true);
  for (const allowed of [`api("/api-keys")`, `api("/v10")`, `"/apis"`, "see /api/rates"])
    expect(prefixLiteral.test(allowed), allowed).toBe(false);
});
it("builds every webapp API URL from API_BASE_PATH", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const sources = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));
  const literals = sources.filter((f) => prefixLiteral.test(readFileSync(path.join(root, f), "utf8")));
  expect(literals).toEqual([path.join("lib", "network.ts")]);
});
