import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HISTORICAL_CUDA_PROGRAM_ID,
  WATCHED_YUKON_SUBSET,
  historicalCudaProgram,
  openDeposit,
  programForNewDeposit,
  watchedYukonSubsetProgram,
} from "../src/lib/cuda-program";
import { pinSolver } from "../src/lib/provenance";
import {
  pinNewSupervisedJob,
  routeStoredJob,
} from "../supervised/archive/work/yukon-app-routing-20260923/routing";
import {
  pinNewSupervisedJob as pinRuntimeSupervisedJob,
  routeStoredJob as routeRuntimeStoredJob,
} from "../supervised/runtime/source/work/yukon-app-routing-20260923/routing";

const scriptHex = "51";
const vaultId = "10000000-0000-4000-8000-000000000001";
const jobId = "10000000-0000-4000-8000-000000000002";

function depositVault(cudaProgram?: ReturnType<typeof historicalCudaProgram>) {
  const funding = { txid: "11".repeat(32), vout: 0, value: "10000" };
  return {
    id: vaultId,
    config: "A" as const,
    network: "mainnet" as const,
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

describe("deposit CUDA program record", () => {
  it("records the program that was current when the deposit was created", () => {
    const opened = openDeposit(depositVault());
    expect(opened.cudaProgram).toEqual(programForNewDeposit());
    expect(opened.cudaProgram).toEqual(historicalCudaProgram());
    expect(opened.cudaProgram.id).toBe(HISTORICAL_CUDA_PROGRAM_ID);
    const again = openDeposit(opened);
    expect(again.cudaProgram).toEqual(opened.cudaProgram);
    expect(() => openDeposit(depositVault(watchedYukonSubsetProgram()))).toThrow(
      "DepositCudaProgramMismatch",
    );
  });

  it("does not refuse a job for a different compatible solver", () => {
    const opened = openDeposit(depositVault());
    const recorded = opened.cudaProgram;
    const pinned = pinSolver(opened);
    expect(pinned.descriptor.kernelCommit).toBe(recorded.kernelCommit);
    const choice = { releaseId: WATCHED_YUKON_SUBSET.supervisedProfileId };
    const manifest = manifestFor(opened);
    for (const pin of [pinNewSupervisedJob, pinRuntimeSupervisedJob]) {
      const execution = pin(choice, "owner", opened, manifest);
      expect(execution.profile.id).toBe(WATCHED_YUKON_SUBSET.supervisedProfileId);
      expect(execution.profile.subset.solverId).toBe(WATCHED_YUKON_SUBSET.solverId);
      expect(execution.profile.subset.solverId).not.toBe(recorded.id);
    }
    const execution = pinNewSupervisedJob(choice, "owner", opened, manifest);
    const routed = routeStoredJob(
      {
        id: jobId,
        owner: "owner",
        vaultId,
        manifest,
        execution,
      },
      opened,
    );
    expect(routed.target).toBe("supervised-service");
    expect(
      routeRuntimeStoredJob(
        {
          id: jobId,
          owner: "owner",
          vaultId,
          manifest,
          execution: pinRuntimeSupervisedJob(choice, "owner", opened, manifest),
        },
        opened,
      ).target,
    ).toBe("supervised-service");
    const unrecorded = depositVault();
    expect(() =>
      pinNewSupervisedJob(choice, "owner", unrecorded, manifestFor(unrecorded)),
    ).not.toThrow();
  });
});
