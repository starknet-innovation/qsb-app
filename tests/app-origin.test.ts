import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as btc from "@scure/btc-signer";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { BITCOIN_NETWORK } from "../src/lib/network";

const owner = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
const deployed = "https://d111111abcdef8.cloudfront.net";
let previous: { origin?: string; lambda?: string };
beforeEach(() => {
  previous = { origin: process.env.APP_ORIGIN, lambda: process.env.AWS_LAMBDA_FUNCTION_NAME };
  delete process.env.APP_ORIGIN;
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
});
afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of [["APP_ORIGIN", previous.origin], ["AWS_LAMBDA_FUNCTION_NAME", previous.lambda]] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

const request = (app: ReturnType<typeof createApp>) =>
  app.request("/api/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json", origin: deployed },
    body: JSON.stringify({ address: owner }),
  });
const challenge = async (app: ReturnType<typeof createApp>) => {
  const r = await request(app);
  return { origin: (await r.json()).message.split("\n")[1], cors: r.headers.get("access-control-allow-origin") };
};

it("names the deployment's origin from its SYSTEM#DEPLOYMENT row, which Terraform writes", async () => {
  const store = new MemoryStore();
  await store.put({ pk: "SYSTEM#DEPLOYMENT", sk: "APP_ORIGIN", version: 0, origin: deployed });
  const app = createApp(store);
  expect(await challenge(app)).toEqual({ origin: `Origin: ${deployed}`, cors: deployed });
});

it("off Lambda, falls back to the local origin until the row exists, and looks again every 30 seconds", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-02T00:00:00.000Z"), toFake: ["Date"] });
  const store = new MemoryStore();
  const app = createApp(store);
  expect((await challenge(app)).origin).toBe("Origin: http://127.0.0.1:5173");
  await store.put({ pk: "SYSTEM#DEPLOYMENT", sk: "APP_ORIGIN", version: 0, origin: deployed });
  vi.setSystemTime(new Date("2026-10-02T00:00:30.000Z"));
  expect((await challenge(app)).origin).toBe(`Origin: ${deployed}`);
});

it("ignores a row that isn't an https origin, and prefers APP_ORIGIN where it's set", async () => {
  const store = new MemoryStore();
  await store.put({ pk: "SYSTEM#DEPLOYMENT", sk: "APP_ORIGIN", version: 0, origin: "javascript:alert(1)" });
  expect((await challenge(createApp(store))).origin).toBe("Origin: http://127.0.0.1:5173");
  process.env.APP_ORIGIN = "http://localhost:4000";
  const configured = createApp(store);
  delete process.env.APP_ORIGIN;
  expect((await challenge(configured)).origin).toBe("Origin: http://localhost:4000");
});

it("on Lambda, refuses sign-in until the row exists, with no CORS origin, instead of naming a local origin", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-02T00:00:00.000Z"), toFake: ["Date"] });
  process.env.AWS_LAMBDA_FUNCTION_NAME = "qsb-test-api";
  const store = new MemoryStore();
  const get = vi.spyOn(store, "get");
  const app = createApp(store);
  const refused = await request(app);
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ code: "app_origin_unavailable" });
  expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  expect([...store.rows.keys()].some((key) => key.startsWith("CHALLENGE#"))).toBe(false);
  // Other routes work meanwhile, and a missing row is looked up at most every 30 seconds.
  expect((await app.request("/api/health")).status).toBe(200);
  expect(get.mock.calls.filter(([pk]) => pk === "SYSTEM#DEPLOYMENT")).toHaveLength(1);
  await store.put({ pk: "SYSTEM#DEPLOYMENT", sk: "APP_ORIGIN", version: 0, origin: deployed });
  vi.setSystemTime(new Date("2026-10-02T00:00:30.000Z"));
  expect(await challenge(app)).toEqual({ origin: `Origin: ${deployed}`, cors: deployed });
});

it("keeps the origin it read, and keeps every route up, when the row can't be read", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-02T00:00:00.000Z"), toFake: ["Date"] });
  process.env.AWS_LAMBDA_FUNCTION_NAME = "qsb-test-api";
  const store = new MemoryStore();
  await store.put({ pk: "SYSTEM#DEPLOYMENT", sk: "APP_ORIGIN", version: 0, origin: deployed });
  const app = createApp(store);
  expect((await challenge(app)).origin).toBe(`Origin: ${deployed}`);
  const real = store.get.bind(store);
  vi.spyOn(store, "get").mockImplementation(async (pk, sk) => {
    if (pk === "SYSTEM#DEPLOYMENT") throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
    return real(pk, sk);
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.setSystemTime(new Date("2026-10-02T00:05:01.000Z"));
  expect((await challenge(app)).origin).toBe(`Origin: ${deployed}`);
  expect((await app.request("/api/health")).status).toBe(200);
  expect(log.mock.calls.map(([line]) => String(line))).toContain(
    JSON.stringify({ appOrigin: "read_failed", error: "ThrottlingException" }),
  );
  // With nothing read yet, a failed read refuses sign-in only.
  const fresh = createApp(store);
  expect((await request(fresh)).status).toBe(503);
  expect((await fresh.request("/api/health")).status).toBe(200);
});

it("reads the row again after five minutes, so a replaced distribution reaches a warm container", async () => {
  vi.useFakeTimers({ now: new Date("2026-10-02T00:00:00.000Z"), toFake: ["Date"] });
  const store = new MemoryStore();
  await store.put({ pk: "SYSTEM#DEPLOYMENT", sk: "APP_ORIGIN", version: 0, origin: deployed });
  const app = createApp(store);
  expect((await challenge(app)).origin).toBe(`Origin: ${deployed}`);
  const replaced = "https://d222222abcdef8.cloudfront.net";
  await store.put({ pk: "SYSTEM#DEPLOYMENT", sk: "APP_ORIGIN", version: 1, origin: replaced }, 0);
  vi.setSystemTime(new Date("2026-10-02T00:04:00.000Z"));
  expect((await challenge(app)).origin).toBe(`Origin: ${deployed}`);
  vi.setSystemTime(new Date("2026-10-02T00:05:01.000Z"));
  expect((await challenge(app)).origin).toBe(`Origin: ${replaced}`);
});
