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

it("off Lambda, falls back to the local origin until the row exists, without caching the fallback", async () => {
  const store = new MemoryStore();
  const app = createApp(store);
  expect((await challenge(app)).origin).toBe("Origin: http://127.0.0.1:5173");
  await store.put({ pk: "SYSTEM#DEPLOYMENT", sk: "APP_ORIGIN", version: 0, origin: deployed });
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
  process.env.AWS_LAMBDA_FUNCTION_NAME = "qsb-test-api";
  const store = new MemoryStore();
  const app = createApp(store);
  const refused = await request(app);
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ code: "app_origin_unavailable" });
  expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  expect(await store.list("CHALLENGE#", "")).toEqual([]);
  await store.put({ pk: "SYSTEM#DEPLOYMENT", sk: "APP_ORIGIN", version: 0, origin: deployed });
  expect(await challenge(app)).toEqual({ origin: `Origin: ${deployed}`, cors: deployed });
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
