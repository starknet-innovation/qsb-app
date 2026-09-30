import { readFileSync } from "node:fs";
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
// AGENTS.md: turning a switch on, or changing an off default, needs the user's
// explicit approval. Keep that visible in CI rather than only in review tooling.
it("keeps the deployment switch defaults off in Terraform and never hard-codes them on", () => {
  const variables = readFileSync(new URL("../terraform/variables.tf", import.meta.url), "utf8");
  for (const name of ["mainnet_enabled", "exact_submit_enabled", "api_keys_enabled"]) {
    const block = new RegExp(`^variable "${name}" \\{\\n([\\s\\S]*?)\\n\\}`, "m").exec(variables)?.[1];
    expect(block, `variable "${name}" is declared`).toBeDefined();
    expect(block, `variable "${name}" defaults to false`).toMatch(/^\s*default\s*=\s*false\s*$/m);
    expect(block).not.toMatch(/^\s*default\s*=\s*true\s*$/m);
  }
  // The Lambda environments carry the variables, never a literal.
  const compute = readFileSync(new URL("../terraform/compute.tf", import.meta.url), "utf8");
  for (const name of ["QSB_MAINNET_ENABLED", "QSB_EXACT_SUBMIT_ENABLED"]) {
    const assignments = [...compute.matchAll(new RegExp(`${name}\\s*=\\s*([^,}]+)`, "g"))].map((m) => m[1].trim());
    expect(assignments.length, `${name} is wired`).toBeGreaterThan(0);
    for (const value of assignments) expect(value).toMatch(/^tostring\(var\.(?:mainnet|exact_submit)_enabled\)$/);
  }
  expect(compute).not.toMatch(/QSB_REHEARSAL_ENABLED\s*=\s*"true"/);
});
it.each([[false,false,false],[false,true,false],[true,false,false],[true,true,true]])("submit requires both switches (%s/%s)", async (mainnet, submit, expected) => {
  vi.stubEnv("QSB_MAINNET_ENABLED", String(mainnet));
  vi.stubEnv("QSB_EXACT_SUBMIT_ENABLED", String(submit));
  const { exactSubmitEnabled } = await import("../server/exact-submit-permit");
  expect(exactSubmitEnabled()).toBe(expected);
});
