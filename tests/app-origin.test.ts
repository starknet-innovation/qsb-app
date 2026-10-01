import { afterEach, beforeEach, expect, it } from "vitest";
import * as btc from "@scure/btc-signer";
import { createApp } from "../server/app";
import { MemoryStore } from "../server/store";
import { BITCOIN_NETWORK } from "../src/lib/network";

const owner = btc.Address(BITCOIN_NETWORK).encode({ type: "wpkh", hash: new Uint8Array(20) });
const deployed = "https://d111111abcdef8.cloudfront.net";
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.APP_ORIGIN;
  delete process.env.APP_ORIGIN;
});
afterEach(() => {
  if (previous === undefined) delete process.env.APP_ORIGIN;
  else process.env.APP_ORIGIN = previous;
});

const challenge = async (app: ReturnType<typeof createApp>) => {
  const r = await app.request("/api/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json", origin: deployed },
    body: JSON.stringify({ address: owner }),
  });
  return { origin: (await r.json()).message.split("\n")[1], cors: r.headers.get("access-control-allow-origin") };
};

it("names the deployment's origin from its SYSTEM#DEPLOYMENT row, which Terraform writes", async () => {
  const store = new MemoryStore();
  await store.put({ pk: "SYSTEM#DEPLOYMENT", sk: "APP_ORIGIN", version: 0, origin: deployed });
  const app = createApp(store);
  expect(await challenge(app)).toEqual({ origin: `Origin: ${deployed}`, cors: deployed });
});

it("falls back to the local origin until the row exists, without caching the fallback", async () => {
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
