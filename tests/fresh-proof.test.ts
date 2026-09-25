import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
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
  assessCoreReportEnrollment,
  assessBoundedCompute,
  assessProofFreshness,
  classifySearchEvidence,
  committedCoreBinarySha256,
  committedManifestPath,
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
import {
  createSourceManifest,
  writePackageTree,
} from "../server/runtime/package-release";
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

const inputs = [{ txid: otherTxid, vout: 1, valueSats: "100000" }];
const outputs = [
  {
    role: "withdrawal" as const,
    scriptHex: "0014",
    valueSats: "90000",
  },
];
const expectedSibling = [{ jobId: "sibling", slot: 1 }];

function requestInput(overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    vaultId,
    publicCommitmentHash: commitment,
    amountSats: "90000",
    feeSats: "10000",
    outpoints: [{ txid: otherTxid, vout: 1 }],
    outputs,
    rows: [unrelatedRow()],
    ...overrides,
  };
}

function passingHarnessReport(coreBinaries: {
  bitcoindSha256: string;
  bitcoinCliSha256: string;
}) {
  return {
    harnessRan: true,
    core: "/Satoshi:28.0.0/",
    network: "regtest",
    coreBinaries,
    tests: [
      {
        name: "unmodified-production-lock-funding",
        passed: true,
        scriptBytes: 400,
        scriptSha256: "12".repeat(32),
        txid: "aa".repeat(32),
      },
      {
        name: "unsolved-production-withdrawal-rejected",
        passed: true,
        reason: "mandatory-script-verify-flag-failed",
      },
      {
        name: "zero-output-transaction-rejected",
        passed: true,
        reason: "bad-txns-vout-empty",
      },
      {
        name: "structural-destination-amount-tamper-rejected",
        passed: true,
        reason: "mandatory-script-verify-flag-failed",
      },
      {
        name: "PUZZLE-RELAXED-structural-spend",
        passed: true,
        puzzleChecksBypassed: 3,
        txid: "bb".repeat(32),
      },
    ],
    puzzleChecksBypassed: 3,
    fullProductionWithdrawalVerified: false,
    freshOptimizedWithdrawal: false,
    section6Closed: false,
    puzzleRelaxedIsNotFreshSearch: true,
    knownSolutionReplayIsNotFreshSearch: true,
    syntheticNoHitIsNotFreshSearch: true,
    mockedSuccessIsNotFreshSearch: true,
  };
}

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

  it("resolves enrollment from the packaged tree as well as the checkout", () => {
    expect(committedManifestPath(process.cwd())).toBe(
      path.join(process.cwd(), "release", "source-manifest.json"),
    );
    const directory = mkdtempSync(path.join(tmpdir(), "qsb-proof-package-"));
    writePackageTree(process.cwd(), directory, manifest);
    symlinkSync(
      path.join(process.cwd(), "node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    const exercise = path.join(directory, "exercise-proof-gate.mts");
    writeFileSync(
      exercise,
      [
        'import { appendFileSync, readFileSync, writeFileSync } from "node:fs";',
        'import { enrolledReleaseIdentity, loadCoreBinaryEnrollment, selectProofRunner } from "./tree/server/runtime/fresh-proof.ts";',
        'const committed = JSON.parse(readFileSync(new URL("./release-manifest.json", import.meta.url), "utf8"));',
        "const enrolled = enrolledReleaseIdentity(committed);",
        "const selected = selectProofRunner({",
        '  requestedChain: "regtest",',
        '  advertisedChain: "regtest",',
        "  service: {",
        '    format: "qsb-proof-service-config-v1",',
        '    serviceId: "regtest-proof",',
        '    configuredChain: "regtest",',
        "    mainnetOnly: false,",
        "    releaseProfileId: enrolled.profileId,",
        "    sourceManifestSha256: enrolled.sourceManifestSha256,",
        "    nativeBinariesEnrolled: false,",
        "    mainnetEnabled: false,",
        "    broadcastAuthorized: false,",
        "  },",
        "  enrolled,",
        "});",
        'if (selected.chain !== "regtest") throw new Error("chain");',
        'if (selected.mainnetEnabled !== false || selected.broadcastAuthorized !== false) throw new Error("activation");',
        'if (selected.liveRunnerContacted !== false || selected.nativeBinariesEnrolled !== false) throw new Error("runner");',
        "console.log(selected.sourceManifestSha256);",
        "const core = loadCoreBinaryEnrollment();",
        'if (core.enrolled !== false || core.bitcoindSha256 !== null) throw new Error("core-enrollment");',
        'writeFileSync(new URL("./tree/server/runtime/core-binary.json", import.meta.url), "{\\"tampered\\":true}\\n");',
        "let coreRejected = false;",
        "try { loadCoreBinaryEnrollment(); } catch (error) {",
        '  coreRejected = error instanceof Error && error.message === "CoreBinaryEnrollmentRejected";',
        "}",
        'if (!coreRejected) throw new Error("core-bytes");',
        'appendFileSync(new URL("./tree/server/runtime/types.ts", import.meta.url), "\\n");',
        "let rejected = false;",
        "try { enrolledReleaseIdentity(committed); } catch (error) {",
        '  rejected = error instanceof Error && error.message === "ReleaseEnrollmentMismatch";',
        "}",
        'if (!rejected) throw new Error("stale-enrollment");',
        "",
      ].join("\n"),
    );
    const output = execFileSync(
      path.join(process.cwd(), "node_modules", ".bin", "tsx"),
      [exercise],
      { cwd: directory, encoding: "utf8" },
    );
    expect(output.trim()).toBe(fingerprint(manifest));
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
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({
          spentFixtures: [{ vaultId: vaultId.toUpperCase() }],
        }),
      ),
    ).toThrow(/HistoricalFixtureRestartRefused:vault:/);
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({
          spentFixtures: [{ requestId: requestId.toUpperCase() }],
        }),
      ),
    ).toThrow(/HistoricalFixtureRestartRefused:request:/);
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({
          spentFixtures: [{ publicCommitmentHash: commitment.toUpperCase() }],
        }),
      ),
    ).toThrow(/HistoricalFixtureRestartRefused:commitment:/);
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({
          rows: [
            {
              pk: "OWNER#spent-case",
              sk: "VAULT#spent-case",
              version: 1,
              spent: true,
              vaultId: vaultId.toUpperCase(),
            },
          ],
        }),
      ),
    ).toThrow(/HistoricalFixtureRestartRefused:vault:/);
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
    const supply = "2100000000000000";
    const atSupply = scaffoldDisposableProofRequest(
      requestInput({
        amountSats: supply,
        feeSats: "1",
        outputs: [{ role: "withdrawal", scriptHex: "0014", valueSats: supply }],
      }),
    );
    expect(atSupply.amountSats).toBe(supply);
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({ amountSats: "2100000000000001", feeSats: "1" }),
      ),
    ).toThrow(/Amount exceeds Bitcoin supply/);
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({ amountSats: "0", feeSats: "1" }),
      ),
    ).toThrow();
    expect(
      assessBoundedCompute(
        {
          explicitlyAuthorized: true,
          minIdleWorkers: 0,
          maxCostUnits: "1000000000000000",
          deadline: "2026-09-25T00:00:00.000Z",
          workerId: "worker-a",
          cleanupWatchdogs: [{ id: "watchdog-a", independentOfWorker: true }],
        },
        new Date("2026-09-24T00:00:00.000Z"),
      ).maxCostUnits,
    ).toBe("1000000000000000");
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
    expect(request.outputs).toEqual(outputs);
    expect(
      fingerprint({
        ...request,
        outputs: [
          { role: "withdrawal", scriptHex: "001411", valueSats: "90000" },
        ],
      }),
    ).not.toBe(bundle.requestHash);
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
    const swapped = {
      ...bundle,
      outputs: [{ ...bundle.outputs[0]!, scriptHex: "001411" }],
    };
    const { bundleHash: _ignored, ...swappedBody } = swapped;
    expect(() =>
      parseDisposableSigningBundle(
        { ...swappedBody, bundleHash: fingerprint(swappedBody) },
        request,
      ),
    ).toThrow(/BindingMismatch/);
    expect(() =>
      exportDisposableSigningBundle({
        request,
        inputs,
        outputs: [
          { role: "withdrawal", scriptHex: "001411", valueSats: "90000" },
        ],
        searchEvidence: "not-run",
      }),
    ).toThrow(/BindingMismatch/);
    expect(() =>
      scaffoldDisposableProofRequest(
        requestInput({
          outputs: [
            { role: "withdrawal", scriptHex: "0014", valueSats: "80000" },
          ],
        }),
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
      { active: 0, completed: 4, expected: expectedSibling },
    );
    expect(open.queueDrained).toBe(false);
    expect(open.aggregateIgnored).toBe(true);
    expect(open.freshSearch).toBe(false);
    expect(open.independentCpuVerificationOfFreshSearch).toBe(false);
    expect(open.reasons.join(" ")).toContain("not per-job drain");
    expect(open.limits.join(" ")).toContain("not substitutes");

    const reconciled = reconcileSiblingDrain(
      [drainedSibling({ cpuVerification: "simulated" })],
      { active: 0, completed: 1, expected: expectedSibling },
    );
    expect(reconciled.queueDrained).toBe(true);
    expect(reconciled.independentCpuVerificationOfFreshSearch).toBe(false);
    expect(reconciled.substitutesForFreshSearch).toBe(false);
    expect(reconciled.reasons.join(" ")).toContain(
      "Simulated CPU verification",
    );

    const enrolledOnly = reconcileSiblingDrain(
      [drainedSibling({ cpuVerification: "enrolled-cpu-verifier" })],
      { expected: expectedSibling },
    );
    expect(enrolledOnly.queueDrained).toBe(true);
    expect(enrolledOnly.independentCpuVerificationOfFreshSearch).toBe(false);
    expect(reconcileSiblingDrain([]).queueDrained).toBe(false);
    expect(reconcileSiblingDrain([drainedSibling()]).queueDrained).toBe(false);
    expect(
      reconcileSiblingDrain([drainedSibling({ slot: 0 })], {
        expected: [{ jobId: "sibling", slot: 0 }],
      }).queueDrained,
    ).toBe(false);
    expect(
      reconcileSiblingDrain([drainedSibling()], {
        expected: [
          { jobId: "sibling", slot: 1 },
          { jobId: "other", slot: 2 },
        ],
      }).queueDrained,
    ).toBe(false);
    expect(
      reconcileSiblingDrain(
        [drainedSibling(), drainedSibling({ jobId: "other", slot: 2 })],
        { expected: expectedSibling },
      ).queueDrained,
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
      assessBoundedCompute(
        {
          explicitlyAuthorized: true,
          minIdleWorkers: 1,
          maxCostUnits: "25",
          deadline: "2026-09-25T00:00:00.000Z",
          workerId: "worker-a",
          cleanupWatchdogs: [{ id: "watchdog-a", independentOfWorker: true }],
        },
        now,
      ),
    ).toThrow(/BoundedComputeRefused/);
    expect(() =>
      assessBoundedCompute(
        {
          explicitlyAuthorized: false,
          minIdleWorkers: 0,
          maxCostUnits: "25",
          deadline: "2026-09-25T00:00:00.000Z",
          workerId: "worker-a",
          cleanupWatchdogs: [{ id: "watchdog-a", independentOfWorker: true }],
        },
        now,
      ),
    ).toThrow(/BoundedComputeRefused/);
    expect(() =>
      assessBoundedCompute(
        {
          explicitlyAuthorized: true,
          minIdleWorkers: 0,
          maxCostUnits: "25",
          deadline: "2026-09-25T00:00:00.000Z",
          workerId: "worker-a",
          cleanupWatchdogs: [{ id: "worker-a", independentOfWorker: true }],
        },
        now,
      ),
    ).toThrow(/BoundedComputeRefused/);
    expect(() =>
      assessBoundedCompute(
        {
          explicitlyAuthorized: true,
          minIdleWorkers: 0,
          maxCostUnits: "25",
          deadline: "2026-09-25T00:00:00.000Z",
          workerId: "worker-a",
          cleanupWatchdogs: [{ id: "watchdog-a", independentOfWorker: false }],
        },
        now,
      ),
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
    const matchingReport = passingHarnessReport({
      bitcoindSha256,
      bitcoinCliSha256,
    });
    expect(() => admitCoreHarnessResult(matchingReport)).toThrow(
      /CoreBinaryNotEnrolled/,
    );
    const admitted = assessCoreReportEnrollment(
      matchingReport,
      loadCoreBinaryEnrollment(enrolledFile),
    );
    expect(admitted.harnessRan).toBe(true);
    expect(admitted.section6Closed).toBe(false);
    expect(admitted.freshOptimizedWithdrawal).toBe(false);
    expect(admitted.puzzleRelaxedSpend).toBe(true);
    expect(() =>
      assessCoreReportEnrollment(
        { ...matchingReport, tests: [] },
        loadCoreBinaryEnrollment(enrolledFile),
      ),
    ).toThrow(/CoreHarnessChecksRejected/);
    expect(() =>
      assessCoreReportEnrollment(
        {
          harnessRan: true,
          network: "regtest",
          coreBinaries: { bitcoindSha256, bitcoinCliSha256 },
          tests: [{ name: "regtest-report", passed: true }],
        },
        loadCoreBinaryEnrollment(enrolledFile),
      ),
    ).toThrow(/CoreHarnessChecksRejected/);
    const failedReport = passingHarnessReport({
      bitcoindSha256,
      bitcoinCliSha256,
    });
    failedReport.tests[1] = { ...failedReport.tests[1]!, passed: false };
    expect(() =>
      assessCoreReportEnrollment(
        failedReport,
        loadCoreBinaryEnrollment(enrolledFile),
      ),
    ).toThrow(/CoreHarnessChecksRejected/);
    const reboundReport = passingHarnessReport({
      bitcoindSha256,
      bitcoinCliSha256,
    });
    const fundingTxid = "aa".repeat(32);
    reboundReport.tests[0] = {
      name: "unmodified-production-lock-funding",
      passed: true,
      scriptBytes: 400,
      scriptSha256: "12".repeat(32),
      txid: fundingTxid,
    };
    reboundReport.tests[4] = {
      name: "PUZZLE-RELAXED-structural-spend",
      passed: true,
      puzzleChecksBypassed: 3,
      txid: fundingTxid,
    };
    expect(() =>
      assessCoreReportEnrollment(
        reboundReport,
        loadCoreBinaryEnrollment(enrolledFile),
      ),
    ).toThrow(/CoreHarnessChecksRejected/);
    expect(() =>
      assessCoreReportEnrollment(
        {
          harnessRan: true,
          network: "regtest",
          section6Closed: false,
          coreBinaries: {
            bitcoindSha256: "ef".repeat(32),
            bitcoinCliSha256,
          },
        },
        loadCoreBinaryEnrollment(enrolledFile),
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
    const script = readFileSync(
      path.join(root, "scripts/test-core.sh"),
      "utf8",
    );
    expect(script).toContain('"${ROOT}/server/runtime/core-binary.json"');
    expect(script).toContain("HEAD:./release/source-manifest.json");
    expect(script).not.toContain('"${ROOT}/release/source-manifest.json"');
    expect(script).not.toContain("QSB_CORE_MANIFEST");
    expect(script).toContain('qsb-core-regtest.XXXXXX"');
    expect(script).not.toContain("qsb-core-regtest.XXXXXX.json");
    const forgedRoot = mkdtempSync(path.join(tmpdir(), "qsb-core-manifest-"));
    mkdirSync(path.join(forgedRoot, "scripts"), { recursive: true });
    mkdirSync(path.join(forgedRoot, "tests"), { recursive: true });
    mkdirSync(path.join(forgedRoot, "server/runtime"), { recursive: true });
    mkdirSync(path.join(forgedRoot, "release"), { recursive: true });
    cpSync(
      path.join(root, "scripts/test-core.sh"),
      path.join(forgedRoot, "scripts/test-core.sh"),
    );
    cpSync(
      path.join(root, "tests/core_regtest.py"),
      path.join(forgedRoot, "tests/core_regtest.py"),
    );
    cpSync(
      path.join(root, "release/source-manifest.json"),
      path.join(forgedRoot, "release/source-manifest.json"),
    );
    writeFileSync(
      path.join(forgedRoot, "server/runtime/core-binary.json"),
      `${JSON.stringify({
        format: "qsb-core-binary-enrollment-v1",
        bitcoindSha256: null,
        bitcoinCliSha256: null,
        enrolled: false,
      })}
`,
    );
    const forgedBin = mkdtempSync(path.join(tmpdir(), "qsb-forged-core-"));
    writeFileSync(path.join(forgedBin, "bitcoind"), "#!/bin/sh\nexit 0\n");
    writeFileSync(path.join(forgedBin, "bitcoin-cli"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(forgedBin, "bitcoind"), 0o755);
    chmodSync(path.join(forgedBin, "bitcoin-cli"), 0o755);
    const forgedReport = path.join(forgedRoot, "report.json");
    let forgedStatus = 0;
    try {
      execFileSync("bash", ["scripts/test-core.sh"], {
        cwd: forgedRoot,
        env: {
          ...process.env,
          BITCOIN_BIN: forgedBin,
          QSB_CORE_REPORT: forgedReport,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      forgedStatus = (error as { status?: number }).status ?? 1;
    }
    expect(forgedStatus).toBe(2);
    const forged = judgeCoreReport(
      JSON.parse(readFileSync(forgedReport, "utf8")),
    );
    expect(forged.harnessRan).toBe(false);
    expect(forged.reason).toContain("committed manifest");

    const paired = mkdtempSync(path.join(tmpdir(), "qsb-core-head-"));
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "core",
      GIT_AUTHOR_EMAIL: "core@example.com",
      GIT_COMMITTER_NAME: "core",
      GIT_COMMITTER_EMAIL: "core@example.com",
    };
    const git = (args: string[]) =>
      execFileSync("git", ["-C", paired, ...args], {
        env: gitEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    git(["init"]);
    mkdirSync(path.join(paired, "scripts"), { recursive: true });
    mkdirSync(path.join(paired, "tests"), { recursive: true });
    mkdirSync(path.join(paired, "server/runtime"), { recursive: true });
    mkdirSync(path.join(paired, "release"), { recursive: true });
    cpSync(
      path.join(root, "scripts/test-core.sh"),
      path.join(paired, "scripts/test-core.sh"),
    );
    cpSync(
      path.join(root, "tests/core_regtest.py"),
      path.join(paired, "tests/core_regtest.py"),
    );
    cpSync(
      path.join(root, "server/runtime/core-binary.json"),
      path.join(paired, "server/runtime/core-binary.json"),
    );
    cpSync(
      path.join(root, "release/source-manifest.json"),
      path.join(paired, "release/source-manifest.json"),
    );
    git(["add", "."]);
    git(["commit", "-m", "enroll the committed core file"]);
    const committedDigest = committedCoreBinarySha256(paired);
    expect(committedDigest).toBe(
      createHash("sha256")
        .update(
          readFileSync(path.join(paired, "server/runtime/core-binary.json")),
        )
        .digest("hex"),
    );
    const pairedBin = mkdtempSync(path.join(tmpdir(), "qsb-paired-core-"));
    writeFileSync(path.join(pairedBin, "bitcoind"), "paired-bitcoind");
    writeFileSync(path.join(pairedBin, "bitcoin-cli"), "paired-bitcoin-cli");
    chmodSync(path.join(pairedBin, "bitcoind"), 0o755);
    chmodSync(path.join(pairedBin, "bitcoin-cli"), 0o755);
    const pairedEnrollment = {
      format: "qsb-core-binary-enrollment-v1",
      bitcoindSha256: createHash("sha256")
        .update("paired-bitcoind")
        .digest("hex"),
      bitcoinCliSha256: createHash("sha256")
        .update("paired-bitcoin-cli")
        .digest("hex"),
      enrolled: true,
    };
    const pairedEnrollmentPath = path.join(
      paired,
      "server/runtime/core-binary.json",
    );
    writeFileSync(
      pairedEnrollmentPath,
      `${JSON.stringify(pairedEnrollment)}\n`,
    );
    const pairedManifest = JSON.parse(
      readFileSync(path.join(paired, "release/source-manifest.json"), "utf8"),
    );
    pairedManifest.identities.sourceFiles["server/runtime/core-binary.json"] =
      createHash("sha256")
        .update(readFileSync(pairedEnrollmentPath))
        .digest("hex");
    writeFileSync(
      path.join(paired, "release/source-manifest.json"),
      `${JSON.stringify(pairedManifest)}\n`,
    );
    expect(committedCoreBinarySha256(paired)).toBe(committedDigest);
    const pairedReport = path.join(paired, "report.json");
    let pairedStatus = 0;
    try {
      execFileSync("bash", ["scripts/test-core.sh"], {
        cwd: paired,
        env: {
          ...process.env,
          BITCOIN_BIN: pairedBin,
          QSB_CORE_REPORT: pairedReport,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      pairedStatus = (error as { status?: number }).status ?? 1;
    }
    expect(pairedStatus).toBe(2);
    const pairedJudgment = judgeCoreReport(
      JSON.parse(readFileSync(pairedReport, "utf8")),
    );
    expect(pairedJudgment.harnessRan).toBe(false);
    expect(pairedJudgment.reason).toContain("committed manifest");
    expect(pairedJudgment.reason).toContain("working-tree");

    const nestedOuter = mkdtempSync(path.join(tmpdir(), "qsb-core-nested-"));
    const nestedApp = path.join(nestedOuter, "app");
    mkdirSync(path.join(nestedApp, "scripts"), { recursive: true });
    mkdirSync(path.join(nestedApp, "tests"), { recursive: true });
    mkdirSync(path.join(nestedApp, "server/runtime"), { recursive: true });
    mkdirSync(path.join(nestedApp, "release"), { recursive: true });
    cpSync(
      path.join(root, "scripts/test-core.sh"),
      path.join(nestedApp, "scripts/test-core.sh"),
    );
    cpSync(
      path.join(root, "tests/core_regtest.py"),
      path.join(nestedApp, "tests/core_regtest.py"),
    );
    cpSync(
      path.join(root, "server/runtime/core-binary.json"),
      path.join(nestedApp, "server/runtime/core-binary.json"),
    );
    cpSync(
      path.join(root, "release/source-manifest.json"),
      path.join(nestedApp, "release/source-manifest.json"),
    );
    const nestedGit = (args: string[]) =>
      execFileSync("git", ["-C", nestedOuter, ...args], {
        env: gitEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    nestedGit(["init"]);
    nestedGit(["add", "app"]);
    nestedGit(["commit", "-m", "enroll the nested checkout"]);
    expect(committedCoreBinarySha256(nestedApp)).toBe(
      createHash("sha256")
        .update(
          readFileSync(path.join(nestedApp, "server/runtime/core-binary.json")),
        )
        .digest("hex"),
    );
    const nestedBin = mkdtempSync(path.join(tmpdir(), "qsb-nested-core-"));
    writeFileSync(path.join(nestedBin, "bitcoind"), "#!/bin/sh\nexit 0\n");
    writeFileSync(path.join(nestedBin, "bitcoin-cli"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(nestedBin, "bitcoind"), 0o755);
    chmodSync(path.join(nestedBin, "bitcoin-cli"), 0o755);
    const nestedReport = path.join(nestedApp, "report.json");
    let nestedStatus = 0;
    try {
      execFileSync("bash", ["scripts/test-core.sh"], {
        cwd: nestedApp,
        env: {
          ...process.env,
          BITCOIN_BIN: nestedBin,
          QSB_CORE_REPORT: nestedReport,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      nestedStatus = (error as { status?: number }).status ?? 1;
    }
    expect(nestedStatus).toBe(2);
    const nestedJudgment = judgeCoreReport(
      JSON.parse(readFileSync(nestedReport, "utf8")),
    );
    expect(nestedJudgment.harnessRan).toBe(false);
    expect(nestedJudgment.reason).toContain("No reviewed Bitcoin Core binary");
    expect(nestedJudgment.reason).not.toContain("does not match");

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
    const digestDir = mkdtempSync(path.join(tmpdir(), "qsb-core-digest-"));
    const bitcoindPath = path.join(digestDir, "bitcoind");
    const bitcoinCliPath = path.join(digestDir, "bitcoin-cli");
    writeFileSync(bitcoindPath, "bitcoind-bytes");
    writeFileSync(bitcoinCliPath, "bitcoin-cli-bytes");
    const recorded = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          'import json,sys,runpy; core_binary_digests=runpy.run_path("tests/core_regtest.py")["core_binary_digests"]; print(json.dumps(core_binary_digests(sys.argv[1], sys.argv[2])))',
          bitcoindPath,
          bitcoinCliPath,
        ],
        { cwd: root, encoding: "utf8" },
      ),
    );
    expect(recorded.bitcoindSha256).toBe(
      createHash("sha256").update("bitcoind-bytes").digest("hex"),
    );
    expect(recorded.bitcoinCliSha256).toBe(
      createHash("sha256").update("bitcoin-cli-bytes").digest("hex"),
    );
    const source = readFileSync(
      path.join(root, "tests/core_regtest.py"),
      "utf8",
    );
    expect(source).toContain("'coreBinaries': core_binary_digests");
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
