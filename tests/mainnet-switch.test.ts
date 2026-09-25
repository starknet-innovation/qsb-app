import { afterEach, expect, it, vi } from "vitest";
import { Signer } from "bip322-js";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it.each([undefined, "false", "TRUE", "1", " true", "true"])("server and browser use exact deployed mainnet value %s", async (value) => {
  vi.stubEnv("QSB_MAINNET_ENABLED", value);
  vi.stubEnv("QSB_EXACT_SUBMIT_ENABLED", "false");
  vi.resetModules();
  const [{ transactionsEnabled }, { createApp }, { MemoryStore }, { operationsAllowed }] = await Promise.all([
    import("../server/network"), import("../server/app"), import("../server/store"), import("../src/lib/readiness"),
  ]);
  const enabled = value === "true";
  expect(transactionsEnabled).toBe(enabled);
  const app = createApp(new MemoryStore());
  const configResponse = await app.request("/api/config");
  expect(configResponse.headers.get("cache-control")).toBe("no-store");
  const config = await configResponse.json();
  expect(config).toMatchObject({ mainnetEnabled: enabled, operationsEnabled: enabled, exactSubmitEnabled: false });
  expect(operationsAllowed(config)).toBe(enabled);
  expect(operationsAllowed({ network: "mainnet", mainnetEnabled: true })).toBe(false);
  expect(operationsAllowed({ ...config, network: "testnet4" })).toBe(false);
  const key = new Uint8Array(32).fill(1), address = btc.p2wpkh(secp256k1.getPublicKey(key)).address!;
  const post = (path: string, body: unknown, token?: string) => app.request(path, {method: "POST", headers: {"Content-Type":"application/json", ...(token ? {Authorization:`Bearer ${token}`} : {})}, body: JSON.stringify(body)});
  const challenge = await (await post("/api/auth/challenge", {address})).json();
  const login = await (await post("/api/auth/verify", { id: challenge.id, signature: Signer.sign(btc.WIF().encode(key),address,challenge.message) })).json();
  // Funding reaches normal input validation; valid search reaches the vault lookup.
  expect((await post("/api/vaults/00000000-0000-4000-8000-000000000001/fund", {}, login.token)).status).toBe(enabled ? 400 : 503);
  const manifest = {vaultId:crypto.randomUUID(),funding:{txid:"11".repeat(32),vout:0,value:"1000"},helper:{txid:"22".repeat(32),vout:1,value:"500"},destination:address,outputScript:"0014"+"ab".repeat(20),outputValue:"1000",fee:"500",idempotencyKey:crypto.randomUUID(),costAccepted:true};
  expect((await post("/api/jobs", manifest, login.token)).status).toBe(enabled ? 404 : 503);
  expect((await post("/api/jobs/00000000-0000-4000-8000-000000000001/submit", {}, login.token)).status).toBe(503);
});
it.each([[false,false,false],[false,true,false],[true,false,false],[true,true,true]])("submit requires both switches (%s/%s)", async (mainnet, submit, expected) => {
  vi.stubEnv("QSB_MAINNET_ENABLED", String(mainnet));
  vi.stubEnv("QSB_EXACT_SUBMIT_ENABLED", String(submit));
  const { exactSubmitEnabled } = await import("../server/exact-submit-permit");
  expect(exactSubmitEnabled()).toBe(expected);
});
