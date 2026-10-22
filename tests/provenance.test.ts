import { describe, it, expect, vi } from "vitest";
import { fixtureVault, servedFixture } from "./solver-fixture";
vi.mock("../src/lib/releases/registry.generated", async () => ({default:[(await import("./solver-fixture")).servedFixture]}));
import { createHash } from "node:crypto";
import {
  fingerprint,
  assertPaidSolverContract,
  assertSolverPin,
  assertVaultConfiguration,
  pinSolver,
  solverRelease,
  currentSolverId,
  vaultConfiguration,
  externalSolverDescriptorSchema,
  solverRegistry,
  solverReleases,
} from "../src/lib/provenance";
const vault = () => ({...fixtureVault});
const pinned = (v: ReturnType<typeof vault>) => pinSolver(v, servedFixture.id);
describe("immutable vault and solver provenance", () => {
  it("pins exact parameters and preserves legacy vault readability", () => {
    const v = vault();
    const p = pinned(v);
    expect(assertSolverPin(p, v).id).toBe(servedFixture.id);
    expect(
      assertVaultConfiguration({ ...v, configuration: vaultConfiguration(v) }),
    ).toEqual(vaultConfiguration(v));
  });
  it("rejects changed public parameters", () => {
    const v = vault();
    const p = pinned(v);
    v.publicStateJson = '{"n":151}';
    expect(() => assertSolverPin(p, v)).toThrow();
  });
  it("rejects script changes", () => {
    const v = vault();
    const p = pinned(v);
    v.scriptHex = "52";
    expect(() => assertSolverPin(p, v)).toThrow();
  });
  it("rejects a vault that omits its network", () => {
    const { network: _network, ...v } = vault();
    expect(() => vaultConfiguration(v)).toThrow(
      "Unsupported QSB network configuration",
    );
  });
  it("rejects changed network", () => {
    const v = vault();
    const p = pinned(v);
    v.network = "testnet4";
    expect(() => assertSolverPin(p, v)).toThrow();
  });
  it("rejects modified flags even with retained release id", () => {
    const v = vault();
    const p = pinned(v);
    p.descriptor.kernelCommit = "b".repeat(40);
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
    const p = pinned(v);
    v.publicStateJson = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(v.publicStateJson)).reverse()));
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
import publishedV2 from "../src/lib/releases/qsb-solver-v0-1-0.json";
import rankedContract from "../contracts/ranked-v2.json";
const external = () => ({
  schemaVersion: 3,
  searchContract: fingerprint(rankedContract),
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
  { searchContract: "d".repeat(64) },
  { searchContract: undefined },
  { schemaVersion: 2 },
  { solverCommit: "main" },
  { image: "ghcr.io/starknet-innovation/qsb-solver:latest" },
  { image: "123456789012.dkr.ecr.eu-west-2.amazonaws.com/qsb-solver@sha256:" + "c".repeat(64) },
  { image: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@sha256:" + "c".repeat(64) },
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

it("pins the published external release while retaining the archived default", () => {
  const releases = solverReleases().filter((release) => "schemaVersion" in release);
  expect(releases.length).toBeGreaterThan(0);
  for (const release of releases) {
    const v = vault();
    const pin = pinSolver(v, release.id);
    expect(assertSolverPin(pin, v)).toEqual(release);
    expect(pin.descriptor).not.toHaveProperty("sourceHashes");
    expect(pinned(v).descriptor.id).toBe(servedFixture.id);
  }
});

it("retains published v2 verbatim but refuses new paid work without a tested contract", () => {
  const old = publishedV2;
  expect(() => assertPaidSolverContract(old)).toThrow("SolverSearchContractRequired");
  expect(() => assertPaidSolverContract(externalSolverDescriptorSchema.parse(external()))).not.toThrow();
});
