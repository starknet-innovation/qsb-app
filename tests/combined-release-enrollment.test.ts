import { afterEach, expect, it, vi } from "vitest";
import combinedV2 from "../src/lib/releases/qsb-solver-combined-aws-sm86-v0-2-0.json";
import combinedV3 from "../src/lib/releases/qsb-solver-combined-aws-sm86-v0-3-0.json";
import historicalAws from "../src/lib/releases/qsb-solver-aws-v0-1-0.json";
import archived from "../src/lib/releases/qsb-config-a-ranked-v2.json";
import { assertSolverPin, pinSolver, solverRelease, fingerprint, vaultConfiguration } from "../src/lib/provenance";
import { deployedSolver } from "../server/solver-deployment";
import { buildIdentities } from "../server/build-identities";
import { batchImageMatches } from "../server/aws-batch";
import { fixtureVault, publicScriptFixture } from "./solver-fixture";

const combined = [combinedV2, combinedV3];
const digest = (image: string) => image.split("@")[1];

afterEach(() => vi.unstubAllEnvs());
it("enrolls both combined sm86 releases beside aws-v0.1.0 with the same search contract", () => {
  expect(solverRelease(historicalAws.id)).toEqual(historicalAws);
  for (const release of combined) {
    expect(solverRelease(release.id)).toEqual(release);
    // Historical identities stay unchanged; new corrected work cannot select them.
    for (const key of ["protocol", "generatorCommit", "searchVersion", "searchContract"] as const)
      expect(release[key]).toBe(historicalAws[key]);
    expect(release.image).not.toBe(historicalAws.image);
  }
  expect(combinedV3.id).not.toBe(combinedV2.id);
  expect(combinedV3.image).not.toBe(combinedV2.image);
});
it("selects each combined release while earlier pins still verify", () => {
  for (const release of combined) {
    vi.stubEnv("SOLVER_RELEASE_ID", release.id);
    expect(() => deployedSolver()).toThrow("SolverDeploymentContractRequired");
  const fixtureVault = publicScriptFixture("qsb-config-a-legacy-v1");
  const selected = solverRelease(process.env.SOLVER_RELEASE_ID!);
    expect(selected).toEqual(release);
    for (const pinned of [...combined, historicalAws, archived])
      expect(assertSolverPin({descriptor:pinned,releaseHash:fingerprint(pinned),vaultConfigurationHash:fingerprint(vaultConfiguration(fixtureVault))}, fixtureVault)).toEqual(pinned);
  }
});
it("generates deployment identities and binds only a same-digest AWS mirror", () => {
  const queue = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu";
  const mirror = (image: string) => `123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@${digest(image)}`;
  for (const release of combined) {
    expect(() => buildIdentities(release.id, "e".repeat(40), "f".repeat(64))).toThrow("SolverDeploymentContractRequired");
    expect(batchImageMatches(release.image, mirror(release.image), queue)).toBe(true);
    for (const other of [...combined, historicalAws].filter((r) => r !== release))
      expect(batchImageMatches(release.image, mirror(other.image), queue)).toBe(false);
  }
});
