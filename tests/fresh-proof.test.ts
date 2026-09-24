import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../src/lib/provenance";
import { release } from "../src/lib/model";
import {
  HISTORICAL_XVERSE_REGTEST_WITHDRAWAL,
  NOT_A_FRESH_SEARCH,
  admitCoreHarnessResult,
  assessBoundedCompute,
  assessProofFreshness,
  classifySearchEvidence,
  enrolledReleaseIdentity,
  loadCoreBinaryEnrollment,
  exportDisposableSigningBundle,
  judgeCoreReport,
  parseDisposableSigningBundle,
  reconcileSiblingDrain,
  scaffoldDisposableProofRequest,
  selectProofRunner,
  type EnrolledRelease,
  type SiblingJob,
} from "../server/runtime/fresh-proof";
import { requiredReleasePaths } from "../server/runtime/closure";
import { createSourceManifest } from "../server/runtime/package-release";
import { SUPERVISED_PROFILE_ID } from "../server/runtime/types";
import type { Row } from "../server/store";

const requestId = "11111111-1111-4111-8111-111111111111";
const vaultId = "22222222-2222-4222-8222-222222222222";
const spentRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const spentVaultId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const commitment = "ab".repeat(32);
const spentCommitment = "11".repeat(32);
const txid = "22".repeat(32);
const otherTxid = "33".repeat(32);

const manifest = createSourceManifest(process.cwd());

function enrolled(): EnrolledRelease {
  return enrolledReleaseIdentity(manifest);
}

function service(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: "qsb-proof-service-config-v1",
    serviceId: "regtest-proof",
    configuredChain: "regtest",
    mainnetOnly: false,
    releaseProfileId: SUPERVISED_PROFILE_ID,
    sourceManifestSha256: enrolled().sourceManifestSha256,
    nativeBinariesEnrolled: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
    ...overrides,
  };
}

function unrelatedRow(): Row {
  return { pk: "OWNER#other", sk: "NOTE#1", version: 1, note: "unrelated" };
}

function spentRow(): Row {
  return {
    pk: "OWNER#historical",
    sk: "JOB#spent",
    version: 1,
    historicalCompletedFixture: true,
    fixtureLabel: HISTORICAL_XVERSE_REGTEST_WITHDRAWAL.label,
    requestId: spentRequestId,
    vaultId: spentVaultId,
    publicCommitmentHash: spentCommitment,
    txid,
    vout: 0,
  };
}

function requestInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    vaultId,
    publicCommitmentHash: commitment,
    amountSats: "90000",
    feeSats: "10000",
    outpoints: [{ txid: otherTxid, vout: 1 }],
    rows: [unrelatedRow()],
    ...overrides,
  };
}

const inputs = [{ txid: otherTxid, vout: 1, valueSats: "100000" }];
const outputs = [
  {
    role: "withdrawal" as const,
    scriptHex: "0014",
    valueSats: "90000",
  },
];

function drainedSibling(overrides: Partial<SiblingJob> = {}): SiblingJob {
  return {
    jobId: "sibling",
    slot: 1,
    state: "terminal",
    outcome: "drained",
    providerOutcome: "submitted",
    queueStatus: "CANCELLED",
    cpuVerification: "not-run",
    ...overrides,
  };
}

describe("proof runner selection", () => {
  it("refuses a mainnet-only service advertised as regtest", () => {
    expect(() =>
      selectProofRunner({
        requestedChain: "regtest",
        advertisedChain: "regtest",
        service: service({
          configuredChain: "mainnet",
          mainnetOnly: true,
        }),
        enrolled: enrolled(),
      }),
    ).toThrow(/MainnetConfigRelabeledAsRegtest/);
    expect(() =>
      selectProofRunner({
        requestedChain: "regtest",
        advertisedChain: "regtest",
        service: service({ mainnetOnly: true }),
        enrolled: enrolled(),
      }),
    ).toThrow(/MainnetConfigRelabeledAsRegtest/);
  });

  it("refuses a chain or release that is not the enrolled regtest proof", () => {
    expect(() =>
      selectProofRunner({
        requestedChain: "testnet4",
        advertisedChain: "testnet4",
        service: service({ configuredChain: "testnet4" }),
        enrolled: enrolled(),
      }),
    ).toThrow(/ControlledProofChainMustBeRegtest/);
    expect(() =>
      selectProofRunner({
        requestedChain: "mainnet",
        advertisedChain: "mainnet",
        service: service({ configuredChain: "mainnet", mainnetOnly: true }),
        enrolled: enrolled(),
      }),
    ).toThrow(/MainnetProofNotAuthorized/);
    expect(() =>
      selectProofRunner({
        requestedChain: "regtest",
        advertisedChain: "testnet4",
        service: service(),
        enrolled: enrolled(),
      }),
    ).toThrow(/ChainLabelMismatch/);
    expect(() =>
      selectProofRunner({
        requestedChain: "regtest",
        advertisedChain: "regtest",
        service: service({ sourceManifestSha256: "cd".repeat(32) }),
        enrolled: enrolled(),
      }),
    ).toThrow(/ReleaseEnrollmentMismatch/);
    expect(() =>
      selectProofRunner({
        requestedChain: "regtest",
        advertisedChain: "regtest",
        service: service({ nativeBinariesEnrolled: true }),
        enrolled: enrolled(),
      }),
    ).toThrow(/NativeBinaryEnrollmentNotInThisCheckout/);
    expect(() =>
      selectProofRunner({
        requestedChain: "regtest",
        advertisedChain: "regtest",
        service: service({ mainnetEnabled: true }),
        enrolled: enrolled(),
      }),
    ).toThrow(/ActivationRefused/);
    expect(() =>
      enrolledReleaseIdentity({ ...manifest, broadcastAuthorized: true }),
    ).toThrow(/ActivationRefused/);
    expect(() =>
      enrolledReleaseIdentity({
        ...manifest,
        identities: {
          ...manifest.identities,
          nativeBinaries: {
            ...manifest.identities.nativeBinaries,
            pinning: {
              ...manifest.identities.nativeBinaries.pinning,
              value: "ab".repeat(32),
            },
          },
        },
      }),
    ).toThrow(/NativeBinaryEnrollmentNotInThisCheckout/);
    expect(() =>
      enrolledReleaseIdentity({
        format: "qsb-source-release-manifest-v1",
        mainnetEnabled: false,
        broadcastAuthorized: false,
      }),
    ).toThrow(/ReleaseManifestRejected/);
    expect(() =>
      enrolledReleaseIdentity({
        format: "not-a-release-manifest",
        mainnetEnabled: false,
        broadcastAuthorized: false,
      }),
    ).toThrow(/ReleaseManifestRejected/);
    const forged = structuredClone(manifest);
    forged.identities.sourceFiles["server/runtime/fresh-proof.ts"] =
      "ab".repeat(32);
    expect(() => enrolledReleaseIdentity(forged)).toThrow(
      /ReleaseEnrollmentMismatch/,
    );
    const forgedHash = "cd".repeat(32);
    expect(() =>
      selectProofRunner({
        requestedChain: "regtest",
        advertisedChain: "regtest",
        service: service({ sourceManifestSha256: forgedHash }),
        enrolled: { ...enrolled(), sourceManifestSha256: forgedHash },
      }),
    ).toThrow(/ReleaseEnrollmentMismatch/);
  });

  it("records a regtest selection without contacting a runner or certifying a fresh search", () => {
    const selected = selectProofRunner({
      requestedChain: "regtest",
      advertisedChain: "regtest",
      service: service(),
      enrolled: enrolled(),
    });
    expect(selected.chain).toBe("regtest");
    expect(selected.liveRunnerContacted).toBe(false);
    expect(selected.certifiesFreshOptimizedWithdrawal).toBe(false);
    expect(selected.freshSearch).toBe(false);
    expect(selected.nativeBinariesEnrolled).toBe(false);
    expect(selected.mainnetEnabled).toBe(false);
    expect(selected.broadcastAuthorized).toBe(false);
    expect(selected.sourceManifestSha256).toBe(fingerprint(manifest));
    expect(selected.limits.join(" ")).toContain("not substitutes");
    expect(release.mainnetEnabled).toBe(false);
  });
});

describe("freshness and disposable requests", () => {
  it("keeps an empty inventory from proving freshness", () => {
    const report = assessProofFreshness({
      requestId,
      vaultId,
      publicCommitmentHash: commitment,
      outpoints: [],
      rows: [],
    });
    expect(report.globalFreshness).toBe(false);
    expect(report.inventoryHasExclusionPower).toBe(false);
    expect(report.freshSearch).toBe(false);
    expect(report.historicalFixturePresentInCheckout).toBe(false);
    expect(report.omissions.join(" ")).toContain("not global freshness");
    expect(() =>
      scaffoldDisposableProofRequest(requestInput({ rows: [] })),
    ).toThrow(/InventoryHasNoExclusionPower/);
  });

  it("refuses the historical fixture label, a spent outpoint, and a reused request", () => {
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({
          fixtureLabel: HISTORICAL_XVERSE_REGTEST_WITHDRAWAL.label,
        }),
      ),
    ).toThrow(
      /HistoricalFixtureRestartRefused:fixture-label:historical-xverse-regtest-withdrawal/,
    );
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({
          rows: [spentRow(), unrelatedRow()],
          outpoints: [{ txid, vout: 0 }],
        }),
      ),
    ).toThrow(/HistoricalFixtureRestartRefused:outpoint:/);
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({ requestId: spentRequestId, rows: [spentRow()] }),
      ),
    ).toThrow(/HistoricalFixtureRestartRefused:request:/);
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({
          rows: [unrelatedRow()],
          spentFixtures: [{ outpoint: { txid: otherTxid, vout: 1 } }],
        }),
      ),
    ).toThrow(/Spent|HistoricalFixtureRestartRefused:outpoint:/);
  });

  it("admits a new public request when the supplied inventory does not contain it", () => {
    const request = scaffoldDisposableProofRequest(requestInput());
    expect(request.chain).toBe("regtest");
    expect(request.browserGenerated).toBe(false);
    expect(request.awaitingBrowserRequest).toBe(true);
    expect(request.freshSearchPerformed).toBe(false);
    expect(request.restartsHistoricalFixture).toBe(false);
    expect(request.globalFreshness).toBe(false);
    expect(request.mainnetEnabled).toBe(false);
    expect(request.broadcastAuthorized).toBe(false);
    const sameVaultDifferentRequest = scaffoldDisposableProofRequest(
      requestInput({
        rows: [spentRow()],
        requestId: "33333333-3333-4333-8333-333333333333",
        vaultId: "44444444-4444-4444-8444-444444444444",
      }),
    );
    expect(sameVaultDifferentRequest.restartsHistoricalFixture).toBe(false);
    const fundingTxid = "44".repeat(32);
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({
          outpoints: [{ txid: fundingTxid, vout: 0 }],
          rows: [
            unrelatedRow(),
            {
              pk: "OWNER#spent-vault",
              sk: "VAULT#spent",
              version: 1,
              vault: {
                id: "66666666-6666-4666-8666-666666666666",
                status: "spent",
                funding: { txid: fundingTxid, vout: 0, value: "100000" },
              },
            },
          ],
        }),
      ),
    ).toThrow(/HistoricalFixtureRestartRefused:outpoint:/);
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({
          outpoints: [
            { txid: otherTxid, vout: 1 },
            { txid: otherTxid, vout: 1 },
          ],
        }),
      ),
    ).toThrow(/DuplicateOutpoint/);
  });
});

describe("signing bundle binding", () => {
  it("binds vault, request, inputs, outputs, amount, and fee", () => {
    const request = scaffoldDisposableProofRequest(requestInput());
    const bundle = exportDisposableSigningBundle({
      request,
      inputs,
      outputs,
      searchEvidence: "not-run",
    });
    expect(bundle.requestHash).toBe(fingerprint(request));
    expect(bundle.vaultId).toBe(vaultId);
    expect(bundle.amountSats).toBe("90000");
    expect(bundle.feeSats).toBe("10000");
    expect(bundle.freshSearch).toBe(false);
    expect(bundle.substitutesForFreshSearch).toBe(false);
    expect(bundle.xverseSigned).toBe(false);
    expect(bundle.cpuVerified).toBe(false);
    expect(bundle.coreValidated).toBe(false);
    expect(bundle.broadcastAuthorized).toBe(false);
    expect(parseDisposableSigningBundle(bundle, request).requestId).toBe(
      requestId,
    );
    expect(() =>
      parseDisposableSigningBundle({ ...bundle, amountSats: "1" }, request),
    ).toThrow(/BindingMismatch/);
    expect(() =>
      parseDisposableSigningBundle(
        {
          ...bundle,
          outputs: [{ ...bundle.outputs[0]!, scriptHex: "001411" }],
        },
        request,
      ),
    ).toThrow(/BindingMismatch/);
    expect(() =>
      parseDisposableSigningBundle({ ...bundle, feeSats: "1" }, request),
    ).toThrow(/BindingMismatch/);
    expect(() =>
      parseDisposableSigningBundle(
        { ...bundle, vaultId: "55555555-5555-4555-8555-555555555555" },
        request,
      ),
    ).toThrow(/BindingMismatch/);
    expect(() =>
      exportDisposableSigningBundle({
        request,
        inputs: [{ txid, vout: 0, valueSats: "100000" }],
        outputs,
        searchEvidence: "not-run",
      }),
    ).toThrow(/BindingMismatch/);
    expect(() =>
      exportDisposableSigningBundle({
        request,
        inputs,
        outputs: [
          { role: "withdrawal", scriptHex: "0014", valueSats: "80000" },
        ],
        searchEvidence: "not-run",
      }),
    ).toThrow(/BindingMismatch/);
    const duplicated = {
      ...request,
      outpoints: [request.outpoints[0]!, request.outpoints[0]!],
    };
    expect(() =>
      exportDisposableSigningBundle({
        request: duplicated,
        inputs: [inputs[0]!, { txid, vout: 0, valueSats: "1" }],
        outputs,
        searchEvidence: "not-run",
      }),
    ).toThrow(/DuplicateOutpoint/);
    expect(() =>
      exportDisposableSigningBundle({
        request: duplicated,
        inputs: [inputs[0]!, inputs[0]!],
        outputs,
        searchEvidence: "not-run",
      }),
    ).toThrow(/DuplicateOutpoint/);
  });

  it("labels replay, synthetic no-hit, and mocked success as not a fresh search", () => {
    const request = scaffoldDisposableProofRequest(requestInput());
    for (const kind of [
      "known-solution-replay",
      "synthetic-no-hit",
      "mocked-success",
    ] as const) {
      const classified = classifySearchEvidence(kind);
      expect(classified.substitutesForFreshSearch).toBe(false);
      expect(classified.freshOptimizedWithdrawal).toBe(false);
      const bundle = exportDisposableSigningBundle({
        request,
        inputs,
        outputs,
        searchEvidence: kind,
      });
      expect(bundle.searchEvidence).toBe(kind);
      expect(bundle.substitutesForFreshSearch).toBe(false);
      expect(bundle.freshSearch).toBe(false);
    }
    expect(() =>
      exportDisposableSigningBundle({
        request,
        inputs,
        outputs,
        searchEvidence: "fresh-search",
      }),
    ).toThrow(/FreshSearchCannotBeClaimedHere/);
    expect(NOT_A_FRESH_SEARCH).toContain("not substitutes");
  });
});

describe("sibling drain and bounded compute", () => {
  it("does not treat aggregate counters or an open queue as drain", () => {
    const open = reconcileSiblingDrain(
      [
        drainedSibling({
          queueStatus: "IN_QUEUE",
          outcome: undefined,
          state: "running",
        }),
      ],
      { active: 0, completed: 4 },
    );
    expect(open.queueDrained).toBe(false);
    expect(open.aggregateIgnored).toBe(true);
    expect(open.freshSearch).toBe(false);
    expect(open.independentCpuVerificationOfFreshSearch).toBe(false);
    expect(open.reasons.join(" ")).toContain("not per-job drain");
    expect(open.limits.join(" ")).toContain("not substitutes");

    const reconciled = reconcileSiblingDrain(
      [drainedSibling({ cpuVerification: "simulated" })],
      { active: 0, completed: 1 },
    );
    expect(reconciled.queueDrained).toBe(true);
    expect(reconciled.independentCpuVerificationOfFreshSearch).toBe(false);
    expect(reconciled.substitutesForFreshSearch).toBe(false);
    expect(reconciled.reasons.join(" ")).toContain(
      "Simulated CPU verification",
    );

    const enrolledOnly = reconcileSiblingDrain([
      drainedSibling({ cpuVerification: "enrolled-cpu-verifier" }),
    ]);
    expect(enrolledOnly.queueDrained).toBe(true);
    expect(enrolledOnly.independentCpuVerificationOfFreshSearch).toBe(false);
    expect(reconcileSiblingDrain([]).queueDrained).toBe(false);
    expect(
      reconcileSiblingDrain([drainedSibling({ slot: 0 })]).queueDrained,
    ).toBe(false);
  });

  it("accepts a bounded plan without provisioning compute", () => {
    const now = new Date("2026-09-24T00:00:00.000Z");
    const plan = assessBoundedCompute(
      {
        explicitlyAuthorized: true,
        minIdleWorkers: 0,
        maxCostUnits: "25",
        deadline: "2026-09-25T00:00:00.000Z",
        workerId: "worker-a",
        cleanupWatchdogs: [{ id: "watchdog-a", independentOfWorker: true }],
      },
      now,
    );
    expect(plan.planAccepted).toBe(true);
    expect(plan.provisioned).toBe(false);
    expect(plan.liveComputeStarted).toBe(false);
    expect(plan.authorizesMainnetBroadcast).toBe(false);
    expect(plan.minIdleWorkers).toBe(0);
    expect(plan.mainnetEnabled).toBe(false);
    expect(plan.broadcastAuthorized).toBe(false);
    expect(() =>
      assessBoundedCompute({
        explicitlyAuthorized: true,
        minIdleWorkers: 1,
        maxCostUnits: "25",
        deadline: "2026-09-25T00:00:00.000Z",
        workerId: "worker-a",
        cleanupWatchdogs: [{ id: "watchdog-a", independentOfWorker: true }],
      }),
    ).toThrow(/BoundedComputeRefused/);
    expect(() =>
      assessBoundedCompute({
        explicitlyAuthorized: false,
        minIdleWorkers: 0,
        maxCostUnits: "25",
        deadline: "2026-09-25T00:00:00.000Z",
        workerId: "worker-a",
        cleanupWatchdogs: [{ id: "watchdog-a", independentOfWorker: true }],
      }),
    ).toThrow(/BoundedComputeRefused/);
    expect(() =>
      assessBoundedCompute({
        explicitlyAuthorized: true,
        minIdleWorkers: 0,
        maxCostUnits: "25",
        deadline: "2026-09-25T00:00:00.000Z",
        workerId: "worker-a",
        cleanupWatchdogs: [{ id: "worker-a", independentOfWorker: true }],
      }),
    ).toThrow(/BoundedComputeRefused/);
    expect(() =>
      assessBoundedCompute({
        explicitlyAuthorized: true,
        minIdleWorkers: 0,
        maxCostUnits: "25",
        deadline: "2026-09-25T00:00:00.000Z",
        workerId: "worker-a",
        cleanupWatchdogs: [{ id: "watchdog-a", independentOfWorker: false }],
      }),
    ).toThrow(/BoundedComputeRefused/);
    expect(() =>
      assessBoundedCompute(
        {
          explicitlyAuthorized: true,
          minIdleWorkers: 0,
          maxCostUnits: "25",
          deadline: "2026-09-23T00:00:00.000Z",
          workerId: "worker-a",
          cleanupWatchdogs: [{ id: "watchdog-a", independentOfWorker: true }],
        },
        now,
      ),
    ).toThrow(/BoundedComputeDeadlineExpired/);
    expect(() =>
      assessBoundedCompute(
        {
          explicitlyAuthorized: true,
          minIdleWorkers: 0,
          maxCostUnits: "25",
          deadline: "2026-09-24T00:00:00.000Z",
          workerId: "worker-a",
          cleanupWatchdogs: [{ id: "watchdog-a", independentOfWorker: true }],
        },
        now,
      ),
    ).toThrow(/BoundedComputeDeadlineExpired/);
  });
});

describe("core harness judgment", () => {
  it("refuses puzzle-relaxed, mainnet, and self-certified section 6 reports", () => {
    const relaxed = judgeCoreReport({
      harnessRan: true,
      network: "regtest",
      fullProductionWithdrawalVerified: false,
      freshOptimizedWithdrawal: false,
      section6Closed: false,
      tests: [
        {
          name: "PUZZLE-RELAXED-structural-spend",
          passed: true,
          puzzleChecksBypassed: 3,
        },
      ],
    });
    expect(relaxed.section6Closed).toBe(false);
    expect(relaxed.fullProductionWithdrawalVerified).toBe(false);
    expect(relaxed.freshOptimizedWithdrawal).toBe(false);
    expect(relaxed.puzzleRelaxedSpend).toBe(true);
    expect(relaxed.chain).toBe("regtest");
    expect(() =>
      admitCoreHarnessResult({
        harnessRan: true,
        network: "regtest",
        fullProductionWithdrawalVerified: false,
        freshOptimizedWithdrawal: false,
        section6Closed: false,
        tests: [],
        coreBinaries: {
          bitcoindSha256: "ab".repeat(32),
          bitcoinCliSha256: "cd".repeat(32),
        },
      }),
    ).toThrow(/CoreBinaryNotEnrolled/);
    expect(() =>
      admitCoreHarnessResult({
        harnessRan: true,
        network: "regtest",
        section6Closed: true,
      }),
    ).toThrow(/CoreReportOverclaimsSection6/);
    expect(() =>
      admitCoreHarnessResult({
        harnessRan: true,
        network: "mainnet",
        fullProductionWithdrawalVerified: false,
        section6Closed: false,
      }),
    ).toThrow(/CoreReportOverclaimsSection6/);
    expect(() =>
      admitCoreHarnessResult({
        harnessRan: true,
        network: "testnet4",
        section6Closed: false,
      }),
    ).toThrow(/ControlledProofChainMustBeRegtest/);
    const checkoutEnrollment = loadCoreBinaryEnrollment();
    expect(checkoutEnrollment.enrolled).toBe(false);
    expect(checkoutEnrollment.bitcoindSha256).toBeNull();
    expect(checkoutEnrollment.bitcoinCliSha256).toBeNull();
    const enrolledFile = path.join(
      mkdtempSync(path.join(tmpdir(), "qsb-core-enrollment-")),
      "core-binary.json",
    );
    const bitcoindSha256 = "ab".repeat(32);
    const bitcoinCliSha256 = "cd".repeat(32);
    writeFileSync(
      enrolledFile,
      JSON.stringify({
        format: "qsb-core-binary-enrollment-v1",
        bitcoindSha256,
        bitcoinCliSha256,
        enrolled: true,
      }),
    );
    const admitted = admitCoreHarnessResult(
      {
        harnessRan: true,
        network: "regtest",
        fullProductionWithdrawalVerified: false,
        freshOptimizedWithdrawal: false,
        section6Closed: false,
        tests: [{ name: "regtest-report", passed: true }],
        coreBinaries: { bitcoindSha256, bitcoinCliSha256 },
      },
      enrolledFile,
    );
    expect(admitted.harnessRan).toBe(true);
    expect(admitted.section6Closed).toBe(false);
    expect(admitted.freshOptimizedWithdrawal).toBe(false);
    expect(() =>
      admitCoreHarnessResult(
        {
          harnessRan: true,
          network: "regtest",
          section6Closed: false,
          coreBinaries: {
            bitcoindSha256: "ef".repeat(32),
            bitcoinCliSha256,
          },
        },
        enrolledFile,
      ),
    ).toThrow(/CoreBinaryMismatch/);
    expect(() => loadCoreBinaryEnrollment(enrolledFile + ".missing")).toThrow(
      /CoreBinaryEnrollmentRejected/,
    );
  });

  it("wires a missing bitcoind to a not-run report", () => {
    const root = process.cwd();
    const dir = mkdtempSync(path.join(tmpdir(), "qsb-core-"));
    const reportPath = path.join(dir, "report.json");
    let status = 0;
    try {
      execFileSync("bash", ["scripts/test-core.sh"], {
        cwd: root,
        env: {
          ...process.env,
          BITCOIN_BIN: dir,
          QSB_CORE_REPORT: reportPath,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? 1;
    }
    expect(status).toBe(2);
    const judgment = judgeCoreReport(
      JSON.parse(readFileSync(reportPath, "utf8")),
    );
    expect(judgment.harnessRan).toBe(false);
    expect(judgment.section6Closed).toBe(false);
    expect(judgment.freshOptimizedWithdrawal).toBe(false);
    expect(judgment.fullProductionWithdrawalVerified).toBe(false);
    expect(judgment.reason).toContain("does not close section 6");
    const bin = mkdtempSync(path.join(tmpdir(), "qsb-fake-core-"));
    writeFileSync(path.join(bin, "bitcoind"), "#!/bin/sh\nexit 0\n");
    writeFileSync(path.join(bin, "bitcoin-cli"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "bitcoind"), 0o755);
    chmodSync(path.join(bin, "bitcoin-cli"), 0o755);
    const namedReport = path.join(dir, "named-binaries.json");
    let namedStatus = 0;
    try {
      execFileSync("bash", ["scripts/test-core.sh"], {
        cwd: root,
        env: { ...process.env, BITCOIN_BIN: bin, QSB_CORE_REPORT: namedReport },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      namedStatus = (error as { status?: number }).status ?? 1;
    }
    expect(namedStatus).toBe(2);
    const named = judgeCoreReport(
      JSON.parse(readFileSync(namedReport, "utf8")),
    );
    expect(named.harnessRan).toBe(false);
    expect(named.reason).toContain("not harness evidence");

    const stdout = execFileSync("python3", ["tests/core_regtest.py"], {
      cwd: root,
      env: { ...process.env, QSB_CORE_CLASSIFY_ONLY: "1" },
      encoding: "utf8",
    });
    const classified = JSON.parse(stdout);
    expect(classified.knownSolutionReplayIsNotFreshSearch).toBe(true);
    expect(classified.syntheticNoHitIsNotFreshSearch).toBe(true);
    expect(classified.mockedSuccessIsNotFreshSearch).toBe(true);
    expect(judgeCoreReport(classified).section6Closed).toBe(false);
    expect(requiredReleasePaths).not.toContain("scripts/test-core.sh");
    expect(requiredReleasePaths).not.toContain("tests/core_regtest.py");
    expect(
      manifest.identities.sourceFiles["scripts/test-core.sh"],
    ).toBeUndefined();
    expect(
      manifest.identities.sourceFiles["tests/core_regtest.py"],
    ).toBeUndefined();
  });
});
