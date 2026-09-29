import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app";
import {
  apiKeyScopes,
  maxActiveApiKeys,
  routeScopes,
} from "../server/scoped-keys";
import { MemoryStore, type Store } from "../server/store";
import type { Esplora } from "../server/chain";
import type { slipstream } from "../server/providers";
import { decideAppRoleAccess } from "../server/runtime/app-role-records";

const owner = "bc1qowner",
  other = "bc1qother";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
// No request leaves the process: chain and miner reads are stubbed.
const chain = { paymentUtxos: async () => [] } as unknown as Esplora;
const miner = { rates: async () => ({}) } as unknown as typeof slipstream;

async function setup(
  store: Store = new MemoryStore(),
  extra: Parameters<typeof createApp>[1] = {},
) {
  const app = createApp(store, { chain, miner, ...extra });
  const session = async (address = owner) => {
    const token = randomBytes(32).toString("base64url");
    await store.put({
      pk: `SESSION#${sha(token)}`,
      sk: "AUTH",
      version: 0,
      owner: address,
      network: "mainnet",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    return token;
  };
  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.request(`http://localhost${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
  const mint = async (token: string, body: Record<string, unknown> = {}) => {
    const r = await call("POST", "/api/api-keys", token, {
      name: "ci",
      scopes: [...apiKeyScopes],
      ...body,
    });
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  const revokeAll = async (token: string) => {
    const { apiKeys } = await (
      await call("GET", "/api/api-keys", token)
    ).json();
    for (const k of apiKeys)
      if (k.status === "active")
        await call("POST", `/api/api-keys/${k.id}/revoke`, token);
  };
  return { app, store, session, call, mint, revokeAll };
}
const concrete = (pattern: string) =>
  pattern
    .replace("/api/transactions/:id", `/api/transactions/${"ab".repeat(32)}`)
    .replace(":id", crypto.randomUUID());
const split = (route: string) => route.split(" ") as [string, string];
const passedAuth = (status: number) => status !== 401 && status !== 403;
/** After race(), the next atomicPut waits until another one has written. */
function racingStore() {
  const store = new MemoryStore();
  let waiting: Promise<void> | undefined,
    release = () => {};
  const gated = Object.create(store) as MemoryStore;
  gated.atomicPut = async (writes) => {
    const wait = waiting;
    waiting = undefined;
    if (wait) await wait;
    else release();
    return store.atomicPut(writes);
  };
  const race = () => {
    waiting = new Promise<void>((r) => (release = r));
  };
  return { store, gated, race };
}

describe("API key issuance", () => {
  it("returns the key once, stores only its hash and lists metadata", async () => {
    const log = vi.spyOn(console, "log"),
      error = vi.spyOn(console, "error");
    const { store, session, call, mint } = await setup();
    const token = await session();
    const before = Math.floor(Date.now() / 1000);
    const issued = await mint(token, {
      name: " deploy bot ",
      scopes: ["submit", "read", "read"],
    });
    expect(issued.status).toBe(201);
    expect(issued.headers.get("Cache-Control")).toBe("no-store");
    const key: string = issued.body.key;
    expect(key).toMatch(/^qsb_mainnet_[A-Za-z0-9_-]{43}$/);
    expect(issued.body.apiKey).toMatchObject({
      name: "deploy bot",
      scopes: ["read", "submit"],
      network: "mainnet",
      status: "active",
    });
    const expiry = Date.parse(issued.body.apiKey.expiresAt) / 1000;
    expect(expiry - before).toBeGreaterThanOrEqual(30 * 86400);
    expect(expiry - before).toBeLessThanOrEqual(30 * 86400 + 5);
    const lookup = await store.get(`APIKEY#${sha(key)}`, "AUTH");
    expect(lookup).toMatchObject({
      owner,
      id: issued.body.apiKey.id,
      revoked: false,
      network: "mainnet",
    });
    expect(
      await store.get(`OWNER#${owner}`, `APIKEY#${issued.body.apiKey.id}`),
    ).toBeDefined();
    const everything = JSON.stringify([
      ...(store as MemoryStore).rows.values(),
    ]);
    expect(everything).not.toContain(key);
    expect(everything).not.toContain(key.slice(12));
    const listed = await call("GET", "/api/api-keys", token);
    const text = await listed.text();
    expect(text).not.toContain(key.slice(12));
    expect(text).not.toContain(sha(key));
    expect(JSON.parse(text).apiKeys).toEqual([issued.body.apiKey]);
    expect((await call("GET", "/api/vaults", key)).status).toBe(200);
    for (const spy of [log, error])
      for (const args of spy.mock.calls)
        expect(JSON.stringify(args)).not.toContain(key.slice(12));
    log.mockRestore();
    error.mockRestore();
  });

  it("requires a bounded expiry and valid scopes", async () => {
    const { session, mint } = await setup();
    const token = await session();
    expect((await mint(token, { expiresInDays: 90 })).status).toBe(201);
    for (const body of [
      { expiresInDays: 91 },
      { expiresInDays: 0 },
      { expiresInDays: 1.5 },
      { expiresInDays: null },
      { scopes: [] },
      { scopes: ["admin"] },
      { name: "" },
      { owner: other },
    ])
      expect((await mint(token, body)).status).toBe(400);
  });

  it("caps active keys per owner; revoked and expired keys do not count", async () => {
    const { store, session, call, mint } = await setup();
    const token = await session(),
      ids: string[] = [];
    for (let i = 0; i < maxActiveApiKeys; i++)
      ids.push((await mint(token)).body.apiKey.id);
    const refused = await mint(token);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("api_key_limit_reached");
    expect((await mint(await session(other))).status).toBe(201);
    expect(
      (await call("POST", `/api/api-keys/${ids[0]}/revoke`, token)).status,
    ).toBe(200);
    expect((await mint(token)).status).toBe(201);
    for (const row of (store as MemoryStore).rows.values())
      if (row.pk === `OWNER#${owner}` && row.sk === `APIKEY#${ids[1]}`)
        row.expiresAt = 1;
    expect((await mint(token)).status).toBe(201);
    expect((await mint(token)).status).toBe(409);
  });

  it("holds the cap under concurrent issuance", async () => {
    const { store, gated, race } = racingStore();
    const { session, mint } = await setup(gated);
    const token = await session();
    for (let i = 0; i < maxActiveApiKeys - 1; i++) await mint(token);
    race();
    const results = await Promise.all([mint(token), mint(token)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    // The fence refused the loser; both read nine active keys.
    expect(results.find((r) => r.status === 409)!.body.code).not.toBe(
      "api_key_limit_reached",
    );
    const listed = [...store.rows.values()].filter(
      (r) => r.pk === `OWNER#${owner}` && r.sk.startsWith("APIKEY#"),
    );
    expect(listed).toHaveLength(maxActiveApiKeys);
  });
});

describe("API key authorization", () => {
  it("enforces the scope of every mapped route and leaves sessions unscoped", async () => {
    const { session, call, mint, revokeAll } = await setup();
    const token = await session();
    for (const [route, scope] of Object.entries(routeScopes)) {
      if (!scope) continue;
      const [method, pattern] = split(route);
      const others = apiKeyScopes.filter((s) => s !== scope);
      const without = (await mint(token, { scopes: others })).body.key;
      const refused = await call(method, concrete(pattern), without);
      expect(refused.status, route).toBe(403);
      expect((await refused.json()).code, route).toBe("api_key_scope_denied");
      const scoped = (await mint(token, { scopes: [scope] })).body.key;
      expect(
        passedAuth((await call(method, concrete(pattern), scoped)).status),
        route,
      ).toBe(true);
      expect(
        passedAuth((await call(method, concrete(pattern), token)).status),
        route,
      ).toBe(true);
      await revokeAll(token);
    }
  });

  it("never lets an API key mint, list or revoke keys", async () => {
    const { store, session, call, mint } = await setup();
    const token = await session();
    const issued = (await mint(token)).body;
    const rows = (store as MemoryStore).rows.size;
    for (const [method, path] of [
      ["POST", "/api/api-keys"],
      ["GET", "/api/api-keys"],
      ["POST", `/api/api-keys/${issued.apiKey.id}/revoke`],
    ] as const) {
      const r = await call(method, path, issued.key, {
        name: "x",
        scopes: ["read"],
      });
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe("api_key_not_allowed");
    }
    expect((store as MemoryStore).rows.size).toBe(rows);
    expect(
      (await store.get(`APIKEY#${sha(issued.key)}`, "AUTH"))?.revoked,
    ).toBe(false);
  });

  it("revokes at once, only for the owner", async () => {
    const { session, call, mint } = await setup();
    const token = await session();
    const { key, apiKey } = (await mint(token)).body;
    const stranger = await session(other);
    const foreign = await call(
      "POST",
      `/api/api-keys/${apiKey.id}/revoke`,
      stranger,
    );
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).code).toBe("api_key_not_found");
    expect((await call("GET", "/api/vaults", key)).status).toBe(200);
    const revoked = await call(
      "POST",
      `/api/api-keys/${apiKey.id}/revoke`,
      token,
    );
    expect(revoked.status).toBe(200);
    expect((await revoked.json()).apiKey).toMatchObject({
      id: apiKey.id,
      status: "revoked",
    });
    const refused = await call("GET", "/api/vaults", key);
    expect(refused.status).toBe(401);
    expect((await refused.json()).code).toBe("api_key_revoked");
    expect(
      (await call("POST", `/api/api-keys/${apiKey.id}/revoke`, token)).status,
    ).toBe(200);
    const listed = await (await call("GET", "/api/api-keys", token)).json();
    expect(listed.apiKeys[0]).toMatchObject({ status: "revoked" });
    expect(
      (await call("POST", `/api/api-keys/${crypto.randomUUID()}/revoke`, token))
        .status,
    ).toBe(404);
  });

  it("answers concurrent revocations of one key with the revoked key", async () => {
    const { store, gated, race } = racingStore();
    const { session, call, mint } = await setup(gated);
    const token = await session();
    const { key, apiKey } = (await mint(token)).body;
    race();
    const path = `/api/api-keys/${apiKey.id}/revoke`;
    const results = await Promise.all([
      call("POST", path, token),
      call("POST", path, token),
    ]);
    for (const r of results) {
      expect(r.status).toBe(200);
      expect((await r.json()).apiKey).toMatchObject({ status: "revoked" });
    }
    expect((await store.get(`APIKEY#${sha(key)}`, "AUTH"))?.revoked).toBe(true);
    expect(
      (await store.get(`OWNER#${owner}`, `APIKEY#${apiKey.id}`))?.revoked,
    ).toBe(true);
    expect((await call("GET", "/api/vaults", key)).status).toBe(401);
  });

  it("refuses expired, wrong-network, unknown and malformed keys", async () => {
    const { store, session, call, mint } = await setup();
    const token = await session();
    const { key } = (await mint(token)).body;
    const code = async (bearer: string) => {
      const r = await call("GET", "/api/vaults", bearer);
      return [r.status, (await r.json()).code];
    };
    const body = randomBytes(32).toString("base64url");
    expect(await code(`qsb_testnet4_${body}`)).toEqual([
      401,
      "network_mismatch",
    ]);
    expect(await code(`qsb_mainnet_${body}`)).toEqual([401, "api_key_invalid"]);
    for (const malformed of [
      `qsb_mainnet_${body.slice(1)}`,
      `qsb_regtest_${body}`,
      `qsb_mainnet_${body}=`,
      `QSB_mainnet_${body}`,
    ]) {
      const r = await call("GET", "/api/vaults", malformed);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({
        error: "Connect and sign in with Xverse.",
      });
    }
    const lookup = (await store.get(`APIKEY#${sha(key)}`, "AUTH"))!;
    await store.put({ ...lookup, network: "testnet4", version: 1 }, 0);
    expect(await code(key)).toEqual([401, "network_mismatch"]);
    await store.put({ ...lookup, expiresAt: 1, version: 2 }, 1);
    expect(await code(key)).toEqual([401, "api_key_invalid"]);
    const listed = await (await call("GET", "/api/api-keys", token)).json();
    expect(listed.apiKeys).toHaveLength(1);
  });

  it("keeps sessions unchanged", async () => {
    const { session, call } = await setup();
    const token = await session();
    expect((await call("GET", "/api/vaults", token)).status).toBe(200);
    expect((await call("GET", "/api/api-keys", token)).status).toBe(200);
    const r = await call("GET", "/api/vaults", "T".repeat(43));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({
      error: "Session expired. Please reconnect.",
    });
    expect(await (await call("GET", "/api/vaults")).json()).toEqual({
      error: "Connect and sign in with Xverse.",
    });
  });

  it("maps every authenticated route to a scope, and nothing else", async () => {
    const { app, call } = await setup();
    const guarded = new Set<string>();
    for (const route of app.routes) {
      if (route.method === "ALL") continue;
      const r = await call(route.method, concrete(route.path), "not-a-token");
      if (
        r.status === 401 &&
        (await r.json()).error === "Connect and sign in with Xverse."
      )
        guarded.add(`${route.method} ${route.path}`);
    }
    expect([...guarded].sort()).toEqual(Object.keys(routeScopes).sort());
  });

  it("refuses API keys on an authenticated route missing from the table", async () => {
    const { session, call, mint } = await setup(new MemoryStore(), {
      installAuthenticatedJobRoutes: (routes) =>
        routes.get("/api/jobs/:id/unmapped", (c) =>
          c.json({ owner: c.get("owner") }),
        ),
    });
    const token = await session();
    const { key } = (await mint(token)).body;
    const path = `/api/jobs/${crypto.randomUUID()}/unmapped`;
    const refused = await call("GET", path, key);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("api_key_not_allowed");
    expect(await (await call("GET", path, token)).json()).toEqual({ owner });
  });

  it("stays inside the API role's record policy", () => {
    expect(
      decideAppRoleAccess("dynamodb:PutItem", [`APIKEY#${"ab".repeat(32)}`]),
    ).toBe("allow");
    expect(
      decideAppRoleAccess("dynamodb:GetItem", [`APIKEY#${"ab".repeat(32)}`]),
    ).toBe("allow");
  });
});
