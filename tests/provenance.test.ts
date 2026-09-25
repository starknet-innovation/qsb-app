import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  assertSolverPin,
  assertVaultConfiguration,
  pinSolver,
  solverRelease,
  currentSolverId,
  vaultConfiguration,
  externalSolverDescriptorSchema,
  solverRegistry,
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
  it("rejects a vault that omits its network", () => {
    const { network: _network, ...v } = vault();
    expect(() => vaultConfiguration(v)).toThrow(
      "Unsupported QSB network configuration",
    );
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
    if (!("flags" in p.descriptor)) throw new Error("Expected archive");
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

it("preserves the archived descriptor byte-for-byte without requiring CUDA sources", async () => {
  const { readFileSync } = await import("node:fs");
  expect(
    createHash("sha256")
      .update(readFileSync("src/lib/releases/qsb-config-a-ranked-v2.json"))
      .digest("hex"),
  ).toBe("76cec4ab084e3c40501ecb8245a7b2968dadc7d587840a82adc5382544255c59");
});
const external = () => ({
  schemaVersion: 2,
  id: "qsb-external-test",
  protocol: "qsb-config-a-v1",
  generatorCommit: "2c9172051d5c150ef0a994ca6b988a08a3ef9e85",
  searchVersion: "ranked-v2",
  solverRepository: "https://github.com/starknet-innovation/qsb-solver",
  solverCommit: "a".repeat(40),
  kernelCommit: "b".repeat(40),
  image: "ghcr.io/starknet-innovation/qsb-solver@sha256:" + "c".repeat(64),
});
it("registers a source-independent immutable external release", () => {
  const descriptor = externalSolverDescriptorSchema.parse(external());
  expect(descriptor).not.toHaveProperty("sourceHashes");
  const registered = solverRegistry([descriptor]);
  expect(JSON.parse(registered.get(descriptor.id)!)).toEqual(descriptor);
  expect(registered.has(currentSolverId)).toBe(true);
});
it.each([
  { searchVersion: "ranked-v3" },
  { solverCommit: "main" },
  { image: "ghcr.io/starknet-innovation/qsb-solver:latest" },
  { solverRepository: "https://example.com/solver" },
  { sourceHashes: {} },
  { protocol: "other" },
])("rejects incompatible or unpinned external descriptors %j", (change) => {
  expect(() => solverRegistry([{ ...external(), ...change }])).toThrow();
});
it("refuses duplicate releases and archived ID replacement", () => {
  expect(() => solverRegistry([external(), external()])).toThrow(
    "DuplicateSolverRelease",
  );
  expect(() =>
    solverRegistry([{ ...external(), id: currentSolverId }]),
  ).toThrow("DuplicateSolverRelease");
});
