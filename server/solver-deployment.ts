import { assertPaidSolverContract, solverRelease, type SolverDescriptor } from "../src/lib/provenance";

/** Resolve only an enrolled, contract-bound deployment release. No historical fallback. */
export function deployedSolver(requestedId?: string): SolverDescriptor {
  const id = process.env.SOLVER_RELEASE_ID;
  if (!id) throw new Error("SolverDeploymentRequired");
  const descriptor = solverRelease(id);
  if (!("schemaVersion" in descriptor) || descriptor.schemaVersion !== 3)
    throw new Error("SolverDeploymentContractRequired");
  assertPaidSolverContract(descriptor);
  if (requestedId !== undefined && requestedId !== id)
    throw new Error("SolverDeploymentMismatch");
  return descriptor;
}
export function deployedSolverId(): string | null {
  try { return deployedSolver().id; } catch { return null; }
}
