import { afterEach, expect, it, vi } from "vitest";
import published from "../src/lib/releases/qsb-solver-aws-v0-1-0.json";
import archived from "../src/lib/releases/qsb-config-a-ranked-v2.json";
import { assertSolverPin, pinSolver, solverRelease } from "../src/lib/provenance";
import { deployedSolver } from "../server/solver-deployment";
import { buildIdentities } from "../server/build-identities";
import { batchImageMatches } from "../server/aws-batch";
import { fixtureVault } from "./solver-fixture";

afterEach(() => vi.unstubAllEnvs());
it("selects the enrolled AWS release while existing archived pins still verify", () => {
  vi.stubEnv("SOLVER_RELEASE_ID", published.id);
  const selected = deployedSolver();
  expect(selected).toEqual(published);
  expect(assertSolverPin(pinSolver(fixtureVault, selected.id), fixtureVault)).toEqual(published);
  expect(assertSolverPin(pinSolver(fixtureVault, archived.id), fixtureVault)).toEqual(archived);
  expect(solverRelease(archived.id)).toEqual(archived);
});
it("generates deployment identities from the enrolled producer asset", () => {
  const identities = buildIdentities(published.id, "e".repeat(40), "f".repeat(64));
  expect(identities.solver).toMatchObject({id: published.id, image: published.image, solverCommit: published.solverCommit});
  expect(identities.reference.appCommit).not.toBe(published.solverCommit);
});
it("binds the enrolled canonical manifest to a same-digest AWS mirror only", () => {
  const queue = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu";
  const digest = published.image.split("@")[1];
  expect(batchImageMatches(published.image, `123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@${digest}`, queue)).toBe(true);
  expect(batchImageMatches(published.image, `123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@sha256:${"0".repeat(64)}`, queue)).toBe(false);
});
