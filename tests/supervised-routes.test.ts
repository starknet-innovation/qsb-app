// Off the mainnet path. The deployed mainnet Lambda does not mount these routes.
import { it, expect } from "vitest";
import { MemoryStore } from "../server/store";
import { createApp } from "../server/app";
import { createSupervisedCreationApp } from "../supervised/dispatch/routes";
import { CAPABILITY, CONTRACT } from "../supervised/archive/entry";
it("preserves ordinary application config and legacy gates when dispatch is off", async () => {
  const store = new MemoryStore();
  const a = await (await createApp(store).request("/api/config")).json();
  const b = await (
    await createSupervisedCreationApp(store).request("/api/config")
  ).json();
  expect(b).toEqual(a);
});
it("advertises supervised creation only with both constructor opt-in and capability", async () => {
  const store = new MemoryStore();
  const app = createSupervisedCreationApp(store, { enabled: true });
  expect(
    (await (await app.request("/api/config")).json()).supervisedSearch.enabled,
  ).toBe(false);
  await store.put({
    ...CAPABILITY,
    version: 1,
    enabled: true,
    contract: CONTRACT,
  });
  const config = await (await app.request("/api/config")).json();
  expect(config.supervisedSearch.enabled).toBe(true);
  expect(config.operationsEnabled).toBe(false);
});
it("supervised POST remains behind authentication", async () => {
  const response = await createSupervisedCreationApp(new MemoryStore(), {
    enabled: true,
  }).request("/api/jobs/supervised", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(401);
});
