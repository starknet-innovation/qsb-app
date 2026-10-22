import { afterEach, expect, it, vi } from "vitest";
import published from "../src/lib/releases/qsb-solver-aws-v0-1-0.json";
import archived from "../src/lib/releases/qsb-config-a-ranked-v2.json";
import { assertSolverPin, pinSolver, solverRelease, fingerprint, vaultConfiguration } from "../src/lib/provenance";
import { deployedSolver } from "../server/solver-deployment";
import { buildIdentities } from "../server/build-identities";
import { batchImageMatches } from "../server/aws-batch";
import { fixtureVault, publicScriptFixture } from "./solver-fixture";

afterEach(() => vi.unstubAllEnvs());
it("selects the enrolled AWS release while existing archived pins still verify", () => {
  vi.stubEnv("SOLVER_RELEASE_ID", published.id);
  expect(() => deployedSolver()).toThrow("SolverDeploymentContractRequired");
  const fixtureVault = publicScriptFixture("qsb-config-a-legacy-v1");
  const selected = solverRelease(process.env.SOLVER_RELEASE_ID!);
  expect(selected).toEqual(published);
  expect(assertSolverPin({descriptor:selected,releaseHash:fingerprint(selected),vaultConfigurationHash:fingerprint(vaultConfiguration(fixtureVault))}, fixtureVault)).toEqual(published);
  expect(assertSolverPin({descriptor:archived,releaseHash:fingerprint(archived),vaultConfigurationHash:fingerprint(vaultConfiguration(fixtureVault))}, fixtureVault)).toEqual(archived);
  expect(solverRelease(archived.id)).toEqual(archived);
});
it("generates deployment identities from the enrolled producer asset", () => {
  expect(() => buildIdentities(published.id, "e".repeat(40), "f".repeat(64))).toThrow("SolverDeploymentContractRequired");
});
it("binds the enrolled canonical manifest to a same-digest AWS mirror only", () => {
  const queue = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu";
  const digest = published.image.split("@")[1];
  expect(batchImageMatches(published.image, `123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@${digest}`, queue)).toBe(true);
  expect(batchImageMatches(published.image, `123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@sha256:${"0".repeat(64)}`, queue)).toBe(false);
});
