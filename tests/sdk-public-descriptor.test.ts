import { afterEach, expect, it, vi } from "vitest";
import { nodeQsb } from "./recovery-runtime";
import { publicRuntime } from "../sdk/public-runtime";
import { withVaultConfiguration } from "../src/lib/provenance";

it("validates Config A public state with exact integers before it can be registered or funded", async () => {
  const external = nodeQsb();
  const { stateJson: _secret, ...descriptor } = await external.generateQsb();
  external.lockQsb();
  const vault = withVaultConfiguration({ ...descriptor, id: crypto.randomUUID(), name: "public",
    createdAt: new Date().toISOString(), config: "A", network: "mainnet", status: "unfunded",
    paymentAddress: "bc1qxvenxvenxvenxvenxvenxvenxvenxven2ymjt8" });
  const runtime = publicRuntime();
  await expect(runtime.validate(vault)).resolves.toBeUndefined();
  const rounded = JSON.stringify(JSON.parse(vault.publicStateJson));
  expect(rounded).not.toBe(vault.publicStateJson);
  await expect(runtime.validate({ ...vault, publicStateJson: rounded })).rejects.toThrow("exactly match");
  await expect(runtime.validate({ ...vault, scriptHash: "00".repeat(32) })).rejects.toThrow("script hash");
}, 60000);

// Fault injection is limited to initialization; public-state validation remains the real interpreter.
const faults = vi.hoisted(() => ({ load: false, source: false, attempts: 0 }));
vi.mock("pyodide", async importOriginal => {
  const actual = await importOriginal<typeof import("pyodide")>();
  return { ...actual, loadPyodide: new Proxy(actual.loadPyodide, {
    apply(target, receiver, args) {
      faults.attempts++;
      if (faults.load) { faults.load = false; return Promise.reject(new Error("Transient runtime startup failure")); }
      return Reflect.apply(target, receiver, args);
    },
  }) };
});
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: new Proxy(actual.readFile, {
    apply(target, receiver, args) {
      if (faults.source && String(args[0]).endsWith("/qsb/manifest.json")) {
        faults.source = false; return Promise.reject(new Error("Transient source read failure"));
      }
      return Reflect.apply(target, receiver, args);
    },
  }) };
});
afterEach(() => { faults.load = false; faults.source = false; });

it.each(["load", "source"] as const)("retries the same public operation after a transient %s initialization failure", async failure => {
  const external = nodeQsb();
  const { stateJson: _secret, ...descriptor } = await external.generateQsb();
  external.lockQsb();
  const vault = withVaultConfiguration({ ...descriptor, id: crypto.randomUUID(), name: "retry",
    createdAt: new Date().toISOString(), config: "A", network: "mainnet", status: "unfunded",
    paymentAddress: "bc1qxvenxvenxvenxvenxvenxvenxvenxven2ymjt8" });
  const runtime = publicRuntime();
  const before = faults.attempts;
  faults[failure] = true;
  await expect(runtime.validate(vault)).rejects.toThrow("exactly match");
  await expect(runtime.validate(vault)).resolves.toBeUndefined();
  expect(faults.attempts - before).toBe(2);
  // Successful initialization remains cached, even when the operation's own validation fails.
  await expect(runtime.validate({ ...vault, publicStateJson: JSON.stringify(JSON.parse(vault.publicStateJson)) }))
    .rejects.toThrow("exactly match");
  await expect(runtime.validate(vault)).resolves.toBeUndefined();
  expect(faults.attempts - before).toBe(2);
}, 60000);
