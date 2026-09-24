import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HISTORICAL_CUDA_PROGRAM_ID,
  WATCHED_YUKON_SUBSET,
  assertDepositCudaProgram,
  cudaProgramForDeposit,
  historicalCudaProgram,
  openDeposit,
  programForNewDeposit,
  requireEnrolledCudaProgram,
  watchedYukonSubsetProgram,
} from "../src/lib/cuda-program";
import { pinSolver } from "../src/lib/provenance";
import { pinNewSupervisedJob } from "../supervised/archive/work/yukon-app-routing-20260923/routing";

const scriptHex = "51";
const vaultId = "10000000-0000-4000-8000-000000000001";
const jobId = "10000000-0000-4000-8000-000000000002";

function depositVault(cudaProgram?: ReturnType<typeof historicalCudaProgram>) {
  const funding = { txid: "11".repeat(32), vout: 0, value: "10000" };
  return {
    id: vaultId,
    config: "A",
    network: "mainnet",
    scriptHex,
    scriptHash: createHash("sha256")
      .update(Buffer.from(scriptHex, "hex"))
      .digest("hex"),
    publicStateJson: JSON.stringify({
      config: "A",
      full_script_hex: scriptHex,
      n: 150,
    }),
    funding,
    ...(cudaProgram ? { cudaProgram } : {}),
  };
}

function manifestFor(vault: ReturnType<typeof depositVault>) {
  return {
    vaultId: vault.id,
    funding: vault.funding,
    helper: { txid: "22".repeat(32), vout: 0, value: "1000" },
    destination: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    outputScript: "51",
    outputValue: "9000",
    fee: "1000",
    idempotencyKey: jobId,
    costAccepted: true as const,
  };
}

describe("deposit CUDA program binding", () => {
  it("opens a new deposit on the enrolled historical program", () => {
    const opened = openDeposit({ id: "new" });
    expect(opened.cudaProgram).toEqual(programForNewDeposit());
    expect(opened.cudaProgram.id).toBe(HISTORICAL_CUDA_PROGRAM_ID);
    expect(opened.cudaProgram.releaseHash).toBe(
      pinSolver({
        config: "A",
        scriptHex,
        scriptHash: depositVault().scriptHash,
        publicStateJson: depositVault().publicStateJson,
        network: "mainnet",
      }).releaseHash,
    );
  });

  it("keeps a recorded program when a later candidate exists", () => {
    const opened = openDeposit({});
    const again = openDeposit(opened);
    expect(again.cudaProgram).toEqual(opened.cudaProgram);
    expect(again.cudaProgram.id).not.toBe(WATCHED_YUKON_SUBSET.solverId);
    expect(cudaProgramForDeposit(opened.cudaProgram)).toEqual(opened.cudaProgram);
    expect(cudaProgramForDeposit(undefined)).toEqual(historicalCudaProgram());
    expect(() =>
      requireEnrolledCudaProgram(WATCHED_YUKON_SUBSET.solverId),
    ).toThrow("CudaProgramNotEnrolled");
  });

  it("does not accept the HOLD public build as a deposit program", () => {
    expect(() =>
      assertDepositCudaProgram({
        id: WATCHED_YUKON_SUBSET.solverId,
        kernelCommit: WATCHED_YUKON_SUBSET.kernelCommit,
        releaseHash: WATCHED_YUKON_SUBSET.publicBuildReleaseSha256,
      }),
    ).toThrow("DepositCudaProgramMismatch");
    expect(() =>
      assertDepositCudaProgram({
        id: WATCHED_YUKON_SUBSET.solverId,
        kernelCommit: WATCHED_YUKON_SUBSET.kernelCommit,
        releaseHash: WATCHED_YUKON_SUBSET.publicBuildBinarySha256,
      }),
    ).toThrow("DepositCudaProgramMismatch");
  });

  it("refuses to retarget a historical deposit onto the supervised subset", () => {
    const historical = openDeposit(depositVault());
    expect(() =>
      pinNewSupervisedJob(
        { releaseId: WATCHED_YUKON_SUBSET.supervisedProfileId },
        "owner",
        historical,
        manifestFor(historical),
      ),
    ).toThrow("DepositCudaProgramMismatch");
    expect(() =>
      pinNewSupervisedJob(
        { releaseId: WATCHED_YUKON_SUBSET.supervisedProfileId },
        "owner",
        depositVault(),
        manifestFor(depositVault()),
      ),
    ).toThrow("DepositCudaProgramMissing");
  });

  it("allows the supervised subset only for a deposit opened under that program", () => {
    const program = watchedYukonSubsetProgram();
    const opened = depositVault(program);
    const execution = pinNewSupervisedJob(
      { releaseId: WATCHED_YUKON_SUBSET.supervisedProfileId },
      "owner",
      opened,
      manifestFor(opened),
    );
    expect(execution.profile.subset.solverId).toBe(program.id);
    expect(execution.profile.subset.solverReleaseHash).toBe(program.releaseHash);
  });
});
