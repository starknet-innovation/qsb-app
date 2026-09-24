import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("throws when the network is unset", async () => {
  const { parseNetwork } = await import("../src/lib/network");
  expect(() => parseNetwork(undefined)).toThrow(
    "Unsupported QSB network configuration",
  );
  expect(() => parseNetwork("")).toThrow("Unsupported QSB network configuration");
  expect(() => parseNetwork("regtest")).toThrow(
    "Unsupported QSB network configuration",
  );
});

it("accepts only an explicit network", async () => {
  const { parseNetwork } = await import("../src/lib/network");
  expect(parseNetwork("mainnet")).toBe("mainnet");
  expect(parseNetwork("testnet4")).toBe("testnet4");
});

it("refuses to initialize when no network is configured", async () => {
  vi.resetModules();
  vi.stubEnv("QSB_NETWORK", undefined);
  vi.stubEnv("VITE_QSB_NETWORK", undefined);
  delete process.env.QSB_NETWORK;
  delete process.env.VITE_QSB_NETWORK;
  await expect(import("../src/lib/network")).rejects.toThrow(
    "Unsupported QSB network configuration",
  );
});

it("uses the explicit process network configured for unit tests", async () => {
  expect(process.env.QSB_NETWORK).toBe("mainnet");
  vi.resetModules();
  const network = await import("../src/lib/network");
  expect(network.NETWORK_ID).toBe("mainnet");
  vi.resetModules();
  vi.stubEnv("VITE_QSB_NETWORK", undefined);
  delete process.env.VITE_QSB_NETWORK;
  vi.stubEnv("QSB_NETWORK", "testnet4");
  const testnet = await import("../src/lib/network");
  expect(testnet.NETWORK_ID).toBe("testnet4");
});

it("deployment build requires --network", () => {
  for (const args of [[], ["--network=regtest"], ["--network="]]) {
    let stderr = "";
    expect(() => {
      try {
        execFileSync(process.execPath, ["terraform/scripts/build.mjs", ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        stderr = String((error as { stderr?: string }).stderr ?? "");
        throw error;
      }
    }).toThrow();
    expect(stderr).toContain("Set --network=mainnet or --network=testnet4");
  }
});

it("build, deploy, and test configurations name a network", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<
    string,
    string
  >;
  expect(scripts.dev).toContain('QSB_NETWORK="${QSB_NETWORK:-mainnet}"');
  expect(scripts.dev).toContain('VITE_QSB_NETWORK="${VITE_QSB_NETWORK:-mainnet}"');
  expect(scripts.build).toContain('QSB_NETWORK="${QSB_NETWORK:-mainnet}"');
  expect(scripts.build).toContain('VITE_QSB_NETWORK="${VITE_QSB_NETWORK:-mainnet}"');
  expect(scripts.test).toContain("QSB_NETWORK=mainnet");
  expect(scripts["test:e2e"]).toContain("QSB_NETWORK=mainnet");
  expect(scripts["test:e2e"]).toContain("VITE_QSB_NETWORK=mainnet");
  expect(readFileSync("vitest.config.ts", "utf8")).toContain('QSB_NETWORK: "mainnet"');
  expect(readFileSync("vite.config.ts", "utf8")).toContain(
    "Set VITE_QSB_NETWORK to mainnet or testnet4",
  );
  for (const path of ["playwright.config.ts", "playwright.costs.config.ts"]) {
    const source = readFileSync(path, "utf8");
    expect(source).toContain('QSB_NETWORK: "mainnet"');
    expect(source).toContain('VITE_QSB_NETWORK: "mainnet"');
  }
  const variables = readFileSync("terraform/variables.tf", "utf8");
  const networkVariable = variables.slice(
    variables.indexOf('variable "network"'),
    variables.indexOf('variable "runpod_endpoint_id"'),
  );
  expect(networkVariable).not.toMatch(/^\s*default\s*=/m);
  expect(readFileSync("terraform/terraform.tfvars.example", "utf8")).toContain(
    'network        = "mainnet"',
  );
  for (const path of ["terraform/compute.tf", "terraform/runtime-dispatch.tf"]) {
    expect(readFileSync(path, "utf8")).toContain("QSB_NETWORK = var.network");
  }
  expect(readFileSync("terraform/scripts/build.mjs", "utf8")).not.toContain(
    "?? 'mainnet'",
  );
  expect(readFileSync("supervised/install/credential-exec.py", "utf8")).toContain(
    "'QSB_NETWORK':'mainnet'",
  );
  expect(readFileSync("supervised/dispatch/qsb-dispatch.service", "utf8")).toContain(
    "Environment=QSB_NETWORK=mainnet",
  );
});
