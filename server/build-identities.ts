import { execFileSync } from "node:child_process";
import { assertPaidSolverContract, fingerprint, solverRelease } from "../src/lib/provenance";

/** Build output identities; source selection is explicit, never the historical default. */
export function buildIdentities(solverId: string, appCommit: string, referenceSha256: string) {
  if (!/^[a-f0-9]{40}$/.test(appCommit) || !/^[a-f0-9]{64}$/.test(referenceSha256))
    throw new Error("InvalidBuildIdentity");
  const descriptor = solverId ? solverRelease(solverId) : null;
  if (descriptor && (!("schemaVersion" in descriptor) || descriptor.schemaVersion !== 3))
    throw new Error("SolverDeploymentContractRequired");
  if (descriptor) assertPaidSolverContract(descriptor);
  return {
    solver: descriptor && "solverCommit" in descriptor ? {
      id: descriptor.id,
      image: descriptor.image,
      solverCommit: descriptor.solverCommit,
      descriptorHash: fingerprint(descriptor),
    } : null,
    reference: { appCommit, artifact: "reference.zip", sha256: referenceSha256 },
  };
}

/** Only the committed CPU source closure belongs in the Lambda archive. */
export function referenceFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "--", "worker/cpu"], { cwd: root, encoding: "utf8" })
    .trim().split("\n")
    .filter((name) => /^worker\/cpu\/(?:[^/]+\.py|LICENSE)$/.test(name));
}
