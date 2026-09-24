import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HISTORICAL_CUDA_PROGRAM,
  HISTORICAL_CUDA_PROGRAM_ID,
  WATCHED_YUKON_SUBSET,
  assertDepositCudaProgram,
  assertSearchUsesDepositProgram,
  cudaProgramForDeposit,
  historicalCudaProgram,
  openDeposit,
  programForNewDeposit,
  requireEnrolledCudaProgram,
  watchedYukonSubsetProgram,
} from "../src/lib/cuda-program";
import { pinSolver, solverRelease } from "../src/lib/provenance";
import * as provenance from "../src/lib/provenance";
import { pinNewSupervisedJob } from "../supervised/archive/work/yukon-app-routing-20260923/routing";
import { pinNewSupervisedJob as pinRuntimeSupervisedJob } from "../supervised/runtime/source/work/yukon-app-routing-20260923/routing";

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
    ).toThrow("CudaProgramNotEnrolled");
    expect(() =>
      pinRuntimeSupervisedJob(
        { releaseId: WATCHED_YUKON_SUBSET.supervisedProfileId },
        "owner",
        historical,
        manifestFor(historical),
      ),
    ).toThrow("CudaProgramNotEnrolled");
    expect(() =>
      pinNewSupervisedJob(
        { releaseId: WATCHED_YUKON_SUBSET.supervisedProfileId },
        "owner",
        depositVault(),
        manifestFor(depositVault()),
      ),
    ).toThrow("DepositCudaProgramMissing");
    expect(() =>
      pinRuntimeSupervisedJob(
        { releaseId: WATCHED_YUKON_SUBSET.supervisedProfileId },
        "owner",
        depositVault(),
        manifestFor(depositVault()),
      ),
    ).toThrow("DepositCudaProgramMissing");
  });

  it("does not let a deposit select the unenrolled Yukon subset", () => {
    const program = watchedYukonSubsetProgram();
    expect(() => openDeposit(depositVault(program))).toThrow(
      "DepositCudaProgramMismatch",
    );
    const opened = depositVault(program);
    for (const pin of [pinNewSupervisedJob, pinRuntimeSupervisedJob]) {
      expect(() =>
        pin(
          { releaseId: WATCHED_YUKON_SUBSET.supervisedProfileId },
          "owner",
          opened,
          manifestFor(opened),
        ),
      ).toThrow("DepositCudaProgramMismatch");
    }
    expect(
      readFileSync("src/lib/cuda-program.ts", "utf8"),
    ).toBe(
      readFileSync(
        "supervised/runtime/source/outputs/qsb-vault/src/lib/cuda-program.ts",
        "utf8",
      ),
    );
  });

  it("keeps a missing record on the frozen historical release", () => {
    const frozen = historicalCudaProgram();
    expect(frozen).toEqual(HISTORICAL_CUDA_PROGRAM);
    expect(cudaProgramForDeposit(undefined)).toEqual(frozen);
    const current = solverRelease(HISTORICAL_CUDA_PROGRAM_ID);
    expect(assertSearchUsesDepositProgram(current, undefined)).toEqual(frozen);
    const cheaperBuild = { ...current, compiler: "cheaper-build" };
    expect(() =>
      assertSearchUsesDepositProgram(cheaperBuild, undefined),
    ).toThrow("DepositCudaProgramMismatch");
    vi.spyOn(provenance, "solverRelease").mockReturnValue({
      ...current,
      kernelCommit: "a".repeat(40),
      image: "replaced-under-the-same-id",
    });
    expect(cudaProgramForDeposit(undefined)).toEqual(frozen);
    expect(historicalCudaProgram()).toEqual(frozen);
    expect(programForNewDeposit()).toEqual(frozen);
    expect(() =>
      assertSearchUsesDepositProgram(
        provenance.solverRelease(HISTORICAL_CUDA_PROGRAM_ID),
        undefined,
      ),
    ).toThrow("DepositCudaProgramMismatch");
  });
});
