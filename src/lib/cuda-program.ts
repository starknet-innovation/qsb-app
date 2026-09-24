export const HISTORICAL_CUDA_PROGRAM_ID = "qsb-config-a-ranked-v2-2791ed0";

/**
 * Program copied onto a deposit when it is created.
 * The record is informational. Withdrawal and job pin do not compare it.
 */
export const HISTORICAL_CUDA_PROGRAM = {
  id: HISTORICAL_CUDA_PROGRAM_ID,
  kernelCommit: "2791ed0588f5014ccd688d48ba5502df2879f2f1",
  releaseHash:
    "dd99c923c5079791fc7634460d5692c7f651ad3c27d32ae6f14080ec65ca13d0",
} as const;

/** Program copied onto deposits opened now. Recorded deposits are not rewritten. */
export const ENROLLED_CUDA_PROGRAM_ID = HISTORICAL_CUDA_PROGRAM_ID;

const enrolledForNewDeposits = new Set<string>([HISTORICAL_CUDA_PROGRAM_ID]);

export type CudaProgramRecord = {
  id: string;
  kernelCommit: string;
  releaseHash: string;
};

/**
 * Yukon subset candidate in this repository: research/optimized-subset and the
 * supervised profile qsb-supervised-pin-v4-subset-v5. Isolated GPU comparisons
 * measured higher subset throughput. That measurement is not an enrolled program.
 * The public build binary is a different HOLD artifact.
 */
export const WATCHED_YUKON_SUBSET = {
  source: "research/optimized-subset",
  supervisedProfileId: "qsb-supervised-pin-v4-subset-v5",
  status: "not-enrolled" as const,
  solverId: "qsb-subset-tailcache-exact-owned-cleanup-v5",
  kernelCommit: "1650caf53a32b0ea16aae9e490ebbf5a8686d632",
  solverReleaseHash:
    "966136928aca1b7546275599a0462a1870c92b2a8d184391967a250bb16d9291",
  publicBuildStatus: "HOLD" as const,
  publicBuildBinarySha256:
    "6d46cec4ddfebeb94993a9aad26a8506668b7b23b6d2d3f0214a6a77272586d6",
  publicBuildReleaseSha256:
    "cfa5e15772e1d6764d707d6c9bd7c1bcd9b8ec9cfbe5c800a00b384e39e35ac2",
} as const;

export function historicalCudaProgram(): CudaProgramRecord {
  return { ...HISTORICAL_CUDA_PROGRAM };
}

export function watchedYukonSubsetProgram(): CudaProgramRecord {
  return {
    id: WATCHED_YUKON_SUBSET.solverId,
    kernelCommit: WATCHED_YUKON_SUBSET.kernelCommit,
    releaseHash: WATCHED_YUKON_SUBSET.solverReleaseHash,
  };
}

function knownProgram(id: string): CudaProgramRecord | undefined {
  if (id === HISTORICAL_CUDA_PROGRAM_ID) return historicalCudaProgram();
  return undefined;
}

export function assertDepositCudaProgram(
  value: CudaProgramRecord,
): CudaProgramRecord {
  const known = knownProgram(value.id);
  if (
    !known ||
    value.kernelCommit !== known.kernelCommit ||
    value.releaseHash !== known.releaseHash
  )
    throw new Error("DepositCudaProgramMismatch");
  return { ...known };
}

export function requireEnrolledCudaProgram(id: string): CudaProgramRecord {
  if (!enrolledForNewDeposits.has(id)) throw new Error("CudaProgramNotEnrolled");
  const program = knownProgram(id);
  if (!program) throw new Error("CudaProgramNotEnrolled");
  return program;
}

/** Program copied onto deposits opened now. The watched Yukon subset is refused. */
export function programForNewDeposit(): CudaProgramRecord {
  return requireEnrolledCudaProgram(ENROLLED_CUDA_PROGRAM_ID);
}

export function openDeposit<T extends object>(
  vault: T,
): T & { cudaProgram: CudaProgramRecord } {
  const recorded = vault as T & { cudaProgram?: CudaProgramRecord };
  if (recorded.cudaProgram)
    return {
      ...recorded,
      cudaProgram: assertDepositCudaProgram(recorded.cudaProgram),
    };
  return { ...recorded, cudaProgram: programForNewDeposit() };
}
