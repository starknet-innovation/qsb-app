import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  assertSolverPin,
  assertVaultConfiguration,
  pinSolver,
  solverRelease,
  currentSolverId,
  vaultConfiguration,
} from "../src/lib/provenance";
const vault = () => ({
  network: "regtest",
  config: "A",
  scriptHex: "51",
  scriptHash: createHash("sha256")
    .update(Buffer.from("51", "hex"))
    .digest("hex"),
  publicStateJson: JSON.stringify({
    config: "A",
    full_script_hex: "51",
    n: 150,
  }),
});
describe("immutable vault and solver provenance", () => {
  it("pins exact parameters and preserves legacy vault readability", () => {
    const v = vault();
    const p = pinSolver(v);
    expect(assertSolverPin(p, v).id).toBe(currentSolverId);
    expect(
      assertVaultConfiguration({ ...v, configuration: vaultConfiguration(v) }),
    ).toEqual(vaultConfiguration(v));
  });
  it("rejects changed public parameters", () => {
    const v = vault();
    const p = pinSolver(v);
    v.publicStateJson = '{"n":151}';
    expect(() => assertSolverPin(p, v)).toThrow("SolverVaultMismatch");
  });
  it("rejects script changes", () => {
    const v = vault();
    const p = pinSolver(v);
    v.scriptHex = "52";
    expect(() => assertSolverPin(p, v)).toThrow("VaultScriptHashMismatch");
  });
  it("rejects changed network", () => {
    const v = vault();
    const p = pinSolver(v);
    v.network = "mainnet";
    expect(() => assertSolverPin(p, v)).toThrow("SolverVaultMismatch");
  });
  it("rejects modified flags even with retained release id", () => {
    const v = vault();
    const p = pinSolver(v);
    p.descriptor.flags.pinning.push("-DUNSAFE=1");
    expect(() => assertSolverPin(p, v)).toThrow("SolverReleaseMismatch");
  });
  it("rejects unknown release instead of choosing latest", () => {
    expect(() => solverRelease("future")).toThrow("UnsupportedSolverRelease");
  });
  it("returns isolated descriptors so callers cannot mutate registry", () => {
    const d = solverRelease(currentSolverId);
    d.kernelCommit = "changed";
    expect(solverRelease(currentSolverId).kernelCommit).not.toBe("changed");
  });
  it("rejects a forged configuration snapshot", () => {
    const v = vault();
    expect(() =>
      assertVaultConfiguration({
        ...v,
        configuration: { ...vaultConfiguration(v), generatorCommit: "changed" },
      }),
    ).toThrow("VaultConfigurationMismatch");
  });
  it("canonicalizes public object key order", () => {
    const v = vault();
    const p = pinSolver(v);
    v.publicStateJson = '{"n":150,"full_script_hex":"51","config":"A"}';
    expect(() => assertSolverPin(p, v)).not.toThrow();
  });
});

it("archives hashes for the exact local adapter, range implementation and kernel sources", async () => {
  const { readFileSync } = await import("node:fs");
  for (const [path, hash] of Object.entries(
    solverRelease(currentSolverId).sourceHashes,
  ))
    expect(
      createHash("sha256").update(readFileSync(path)).digest("hex"),
      path,
    ).toBe(hash);
});
