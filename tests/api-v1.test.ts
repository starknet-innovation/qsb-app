import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { createApp } from "../server/app";
import { deployedApiApp } from "../server/lambda";
import { MemoryStore } from "../server/store";
import { chain as defaultChain, Esplora } from "../server/chain";
import { Slipstream, slipstream as defaultMiner } from "../server/providers";
import { BITCOIN_NETWORK } from "../src/lib/network";

const owner = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
const token = "A".repeat(43);
const origin = "http://127.0.0.1:5173";
const id = "11111111-1111-4111-8111-111111111111";

// Every request stays in process: chain APIs answer 500 and any other fetch fails.
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network is not available in tests"); }));
  // The process-wide chain client captured the real fetch at import.
  vi.spyOn(defaultChain as unknown as { request: typeof fetch }, "request").mockImplementation(
    async () => new Response("", { status: 500 }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function seeded() {
  const store = new MemoryStore();
  await store.put({
    pk: `SESSION#${createHash("sha256").update(token).digest("hex")}`,
    sk: "AUTH",
    version: 0,
    owner,
    network: "mainnet",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  return store;
}

/** The deployed mainnet API, as server/lambda.ts builds it. Its switches keep their off defaults. */
async function deployed() {
  const app = deployedApiApp(await seeded());
  return { app, submit: vi.spyOn(defaultMiner, "submit"), submitFunding: vi.spyOn(defaultMiner, "submitFunding") };
}

/** The same API with injected fakes and the switches on, so requests reach deeper into the handlers. */
async function injected() {
  const chain = new Esplora("https://chain.test", async () => new Response("", { status: 500 }));
  const miner = new Slipstream("https://slipstream.mara.com", async () => undefined);
  const submit = vi.spyOn(miner, "submit");
  const submitFunding = vi.spyOn(miner, "submitFunding");
  const app = createApp(await seeded(), {
    chain,
    miner,
    enabled: true,
    exactSubmit: true,
    consensus: { verify: vi.fn(async () => {}) },
    versionedAlias: true,
  });
  return { app, submit, submitFunding };
}

function routes() {
  const { routes } = createApp(new MemoryStore());
  const seen = new Set<string>();
  return routes
    .filter((r) => (r.method === "GET" || r.method === "POST") && r.path.startsWith("/api/"))
    .map((r) => ({ method: r.method, path: r.path.replaceAll(":id", id) }))
    .filter((r) => !seen.has(`${r.method} ${r.path}`) && Boolean(seen.add(`${r.method} ${r.path}`)));
}

async function snapshot(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    body: await response.text(),
  };
}

type Server = typeof injected;
/** A fresh app and store per request, so the /api and /v1 calls see the same state. */
async function both(server: Server, init: (path: string) => Request, path: string) {
  const api = await server(),
    v1 = await server();
  const a = await snapshot(await api.app.request(init(path)));
  const b = await snapshot(await v1.app.request(init(path.replace(/^\/api/, "/v1"))));
  // Nothing in these checks reaches the miner.
  for (const s of [api, v1]) {
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.submitFunding).not.toHaveBeenCalled();
  }
  return [a, b] as const;
}

describe.each([
  ["deployed", deployed],
  ["injected", injected],
] as const)("/v1 alias on the %s API", (_name, server) => {
  const all = routes();

  it("covers every /api route, including the submit routes", () => {
    expect(all.length).toBeGreaterThan(15);
    for (const path of ["/api/vaults/:id/fund/submit", "/api/jobs/:id/submit", "/api/auth/verify", "/api/health"])
      expect(all.map((r) => r.path)).toContain(path.replaceAll(":id", id));
  });

  it.each(all)("$method $path answers the same unauthenticated", async ({ method, path }) => {
    const [a, b] = await both(
      server,
      (p) =>
        new Request(`http://localhost${p}`, {
          method,
          headers: { "content-type": "application/json", origin },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
      path,
    );
    expect(b).toEqual(a);
  });

  it.each(all)("$method $path answers the same with a session", async ({ method, path }) => {
    const [a, b] = await both(
      server,
      (p) =>
        new Request(`http://localhost${p}`, {
          method,
          headers: { "content-type": "application/json", authorization: `Bearer ${token}`, origin },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
      path,
    );
    expect(b).toEqual(a);
  });

  it.each(all)("$method $path answers the same with a bad token", async ({ method, path }) => {
    const [a, b] = await both(
      server,
      (p) =>
        new Request(`http://localhost${p}`, {
          method,
          headers: { "content-type": "application/json", authorization: `Bearer ${"B".repeat(43)}` },
          ...(method === "POST" ? { body: "{}" } : {}),
        }),
      path,
    );
    expect(b).toEqual(a);
  });

  it.each(all)("$method $path answers a CORS preflight the same", async ({ method, path }) => {
    const [a, b] = await both(
      server,
      (p) =>
        new Request(`http://localhost${p}`, {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": method,
            "access-control-request-headers": "authorization, content-type, idempotency-key",
          },
        }),
      path,
    );
    expect(b).toEqual(a);
    expect(a.status).toBe(204);
    expect(new Map(a.headers).get("access-control-allow-headers")).toBe(
      "Content-Type,Authorization,Idempotency-Key",
    );
  });

  it("rewrites only the /v1 segment and keeps /api", async () => {
    const { app } = await server();
    for (const path of ["/api/health", "/v1/health"])
      expect(await (await app.request(path)).json()).toEqual({ ok: true, network: "mainnet" });
    for (const path of ["/v1x/health", "/v2/health", "/v1/api/health", "/x/v1/health"])
      expect((await app.request(path)).status).toBe(404);
  });

  it("applies the body limit under /v1", async () => {
    const { app } = await server();
    const response = await app.request("/v1/vaults", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ padding: "x".repeat(160001) }),
    });
    expect(response.status).toBe(413);
  });
});

describe("/v1 is opt-in", () => {
  it("is off on a plain createApp", async () => {
    const app = createApp(await seeded());
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/v1/health")).status).toBe(404);
  });
});
