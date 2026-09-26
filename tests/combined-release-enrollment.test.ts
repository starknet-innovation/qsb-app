import { afterEach, expect, it, vi } from "vitest";
import combined from "../src/lib/releases/qsb-solver-combined-aws-sm86-v0-2-0.json";
import historicalAws from "../src/lib/releases/qsb-solver-aws-v0-1-0.json";
import archived from "../src/lib/releases/qsb-config-a-ranked-v2.json";
import { assertSolverPin, pinSolver, solverRelease } from "../src/lib/provenance";
import { deployedSolver } from "../server/solver-deployment";
import { buildIdentities } from "../server/build-identities";
import { batchImageMatches } from "../server/aws-batch";
import { fixtureVault } from "./solver-fixture";

afterEach(() => vi.unstubAllEnvs());
it("enrolls the combined sm86 release beside aws-v0.1.0 with the same search contract", () => {
  expect(solverRelease(combined.id)).toEqual(combined);
  expect(solverRelease(historicalAws.id)).toEqual(historicalAws);
  // Same vault configuration and ranked-v2 contract, so an existing vault can withdraw with either.
  for (const key of ["protocol", "generatorCommit", "searchVersion", "searchContract"] as const)
    expect(combined[key]).toBe(historicalAws[key]);
  expect(combined.image).not.toBe(historicalAws.image);
});
it("selects the combined release while earlier pins still verify", () => {
  vi.stubEnv("SOLVER_RELEASE_ID", combined.id);
  const selected = deployedSolver();
  expect(selected).toEqual(combined);
  expect(assertSolverPin(pinSolver(fixtureVault, selected.id), fixtureVault)).toEqual(combined);
  expect(assertSolverPin(pinSolver(fixtureVault, historicalAws.id), fixtureVault)).toEqual(historicalAws);
  expect(assertSolverPin(pinSolver(fixtureVault, archived.id), fixtureVault)).toEqual(archived);
});
it("generates deployment identities and binds only a same-digest AWS mirror", () => {
  const identities = buildIdentities(combined.id, "e".repeat(40), "f".repeat(64));
  expect(identities.solver).toMatchObject({id: combined.id, image: combined.image, solverCommit: combined.solverCommit});
  const queue = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu";
  const digest = combined.image.split("@")[1];
  expect(batchImageMatches(combined.image, `123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@${digest}`, queue)).toBe(true);
  expect(batchImageMatches(combined.image, `123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@${historicalAws.image.split("@")[1]}`, queue)).toBe(false);
});
