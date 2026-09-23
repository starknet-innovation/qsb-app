import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import capability from "../server/mainnet-capability.json";
import { release } from "../src/lib/model";
import {
  COMMIT_BEFORE_DEPLOY,
  CONCURRENCY_CAP,
  OPEN_RELEASE_GATES,
  REQUIRED_ALERTS,
  RUNBOOK_RULES,
  acceptOperationalRunbook,
  agentsDeploymentRule,
  assessDeploymentRecord,
  assertCommitBeforeDeploy,
  assertProposedCommitHasNoSecrets,
  defaultActivationDecision,
  evaluateActivation,
  judgeInRepoRegression,
  readAgentsDeploymentRule,
  reconcilePaidOutcome,
  requireExactSpendBesideActivation,
} from "../server/runtime/activation";

const root = process.cwd();
const now = "2026-09-23T00:00:00.000Z";
const deadline = "2026-09-23T01:00:00.000Z";
const commit = "ab".repeat(20);
const packageHash = "cd".repeat(32);
const configHash = "ef".repeat(32);
const image = `sha256:${"12".repeat(32)}`;

function decision(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...defaultActivationDecision(), ...overrides };
}

function deployment(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    format: "qsb-deployment-record-v1",
    commit,
    treeClean: true,
    committed: true,
    pushed: true,
    remoteMatchesRecordedCommit: true,
    packageManifestSha256: packageHash,
    imageConfigDigest: { status: "not-produced", value: null },
    ociIndexDigest: { status: "not-produced", value: null },
    registryManifestDigest: { status: "not-produced", value: null },
    configurationHash: configHash,
    evidenceKind: "live-deployed-observation",
    deployedRoutesObserved: false,
    capabilitiesObserved: false,
    identitiesObserved: false,
    permissionsObserved: false,
    sourceMainnetEnabled: false,
    sourceBroadcastAuthorized: false,
    ...overrides,
  };
}

function runbook(overrides: Record<string, unknown> = {}) {
  return {
    format: "qsb-operational-runbook-v1" as const,
    maxConcurrentSearches: CONCURRENCY_CAP.maxConcurrentSearches,
    maxGpuWorkers: CONCURRENCY_CAP.maxGpuWorkers,
    minIdleWorkers: CONCURRENCY_CAP.minIdleWorkers,
    maxCostUnits: "1000",
    deadline,
    now,
    workerId: "search-worker",
    cleanupWatchdogId: "cleanup-watchdog",
    cleanupIndependentOfWorker: true as const,
    alerts: [...REQUIRED_ALERTS],
    incident: {
      stopNewWork: true as const,
      preserveUnknownPaidOutcomes: true as const,
      blindRetry: false as const,
    },
    safeStop: {
      stopNewSubmissions: true as const,
      unknownPaidOutcome: "reconcile" as const,
      localProcessLossProvesRemoteStop: false as const,
    },
    rollback: {
      reviveLegacyWriters: false as const,
      releaseConsumedCommitments: false as const,
      duplicatePaidWork: false as const,
      authorizeSpend: false as const,
    },
    mainnetEnabled: false as const,
    broadcastAuthorized: false as const,
    ...overrides,
  };
}

function exactSpend(overrides: Record<string, unknown> = {}) {
  return {
    format: "qsb-exact-spend-authorization-v1" as const,
    chain: "mainnet" as const,
    txid: "11".repeat(32),
    amountSats: "50000",
    feeSats: "1000",
    mainnetEnabled: false as const,
    broadcastAuthorized: false as const,
    ...overrides,
  };
}

describe("activation decision", () => {
  it("stays unapproved and does not enable mainnet or authorize a spend", () => {
    expect(release.mainnetEnabled).toBe(false);
    expect(capability.broadcastAuthorized).toBe(false);
    const result = evaluateActivation(defaultActivationDecision());
    expect(result).toMatchObject({
      recordShape: "unapproved",
      decisionRecordAccepted: false,
      applied: false,
      featureEnabled: false,
      spendAuthorized: false,
      mainnetEnabled: false,
      broadcastAuthorized: false,
      section8Closed: false,
      publicationIsActivation: false,
    });
    expect(defaultActivationDecision().limitations).toEqual([
      ...OPEN_RELEASE_GATES,
    ]);
    expect(result.reason).toContain("not approved");
  });

  it("keeps an approval attempt unapplied while technical gates are open", () => {
    const result = evaluateActivation(
      decision({
        decision: "approved",
        reviewer: "release-review",
        reviewedAt: now,
        evidenceLinks: ["docs/MAINNET-READINESS.md"],
        featureEnablementRequested: true,
      }),
    );
    expect(result.recordShape).toBe("approval-attempt");
    expect(result.decisionRecordAccepted).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.featureEnabled).toBe(false);
    expect(result.spendAuthorized).toBe(false);
    expect(result.mainnetEnabled).toBe(false);
    expect(result.section8Closed).toBe(false);
  });

  it("refuses to treat publication, feature enablement, or a source flag as activation", () => {
    expect(() =>
      evaluateActivation(decision({ publicationIsActivation: true })),
    ).toThrow("PublicationIsNotActivation");
    expect(() =>
      evaluateActivation(decision({ technicalGatesClosed: true })),
    ).toThrow("TechnicalGatesOpen");
    expect(() =>
      evaluateActivation(decision({ mainnetEnabled: true })),
    ).toThrow("ActivationRefused");
    expect(() =>
      evaluateActivation(decision({ broadcastAuthorized: true })),
    ).toThrow("ActivationRefused");
    expect(() =>
      evaluateActivation(decision({ section8Closed: true })),
    ).toThrow("ActivationNotApproved");
    expect(() =>
      evaluateActivation(decision({ spendAuthorizationRequested: true })),
    ).toThrow("SpendIsNotFeatureEnablement");
  });

  it("requires a separate exact spend record and still does not broadcast", () => {
    const activation = defaultActivationDecision();
    expect(() =>
      requireExactSpendBesideActivation({ activation, exactSpend: null }),
    ).toThrow("ExactTransactionAuthorizationRequired");
    expect(() =>
      requireExactSpendBesideActivation({
        activation,
        exactSpend: activation,
      }),
    ).toThrow("SpendIsNotFeatureEnablement");
    expect(() =>
      requireExactSpendBesideActivation({
        activation,
        exactSpend: exactSpend({ broadcastAuthorized: true }),
      }),
    ).toThrow("ActivationRefused");
    expect(
      requireExactSpendBesideActivation({
        activation,
        exactSpend: exactSpend(),
      }),
    ).toMatchObject({
      exactSpendRecordPresent: true,
      spendAuthorized: false,
      broadcastAuthorized: false,
      featureEnabled: false,
      mainnetEnabled: false,
      section8Closed: false,
    });
  });
});

describe("deployment verification", () => {
  it("requires a clean pushed commit and still refuses to deploy", () => {
    expect(() =>
      assertCommitBeforeDeploy({ committed: false, pushed: false, clean: false }),
    ).toThrow(COMMIT_BEFORE_DEPLOY);
    expect(
      assertCommitBeforeDeploy({ committed: true, pushed: true, clean: true }),
    ).toEqual({
      reminder: COMMIT_BEFORE_DEPLOY,
      deployAllowedByThisCheckout: false,
      mainnetEnabled: false,
      broadcastAuthorized: false,
    });
    expect(() =>
      assessDeploymentRecord(deployment({ pushed: false })),
    ).toThrow("CommitBeforeDeploy");
    expect(() =>
      assessDeploymentRecord(deployment({ commit: "HEAD" })),
    ).toThrow("DeploymentRecordRefused");
  });

  it("refuses local builds and source flags as live configuration", () => {
    for (const evidenceKind of [
      "local-build",
      "source-flag",
      "unit-test",
      "vite-build",
    ]) {
      expect(() => assessDeploymentRecord(deployment({ evidenceKind }))).toThrow(
        "LocalBuildIsNotLiveConfiguration",
      );
    }
    expect(() =>
      assessDeploymentRecord(deployment({ sourceMainnetEnabled: true })),
    ).toThrow("ActivationRefused");
    expect(() =>
      assessDeploymentRecord(deployment({ deployedRoutesObserved: true })),
    ).toThrow("LiveObservationNotAvailableInCheckout");
  });

  it("records package bindings and keeps image digests distinct from source hashes", () => {
    const unbound = assessDeploymentRecord(deployment());
    expect(unbound).toMatchObject({
      commitRecorded: true,
      packageBindingRecorded: true,
      configurationBindingRecorded: true,
      imageBindingsRecorded: false,
      localBuildAcceptedAsLive: false,
      sourceFlagsAcceptedAsLive: false,
      liveVerified: false,
      deployPerformed: false,
      mainnetEnabled: false,
      broadcastAuthorized: false,
      section8Closed: false,
    });
    expect(unbound.reason).toContain("not enrolled");
    expect(() =>
      assessDeploymentRecord(
        deployment({ imageConfigDigest: packageHash }),
      ),
    ).toThrow("DeploymentRecordRefused");
    const bound = assessDeploymentRecord(
      deployment({
        imageConfigDigest: image,
        ociIndexDigest: `sha256:${"34".repeat(32)}`,
        registryManifestDigest: `sha256:${"56".repeat(32)}`,
      }),
    );
    expect(bound.imageBindingsRecorded).toBe(true);
    expect(bound.liveVerified).toBe(false);
    expect(bound.deployPerformed).toBe(false);
    expect(bound.reminder).toBe(COMMIT_BEFORE_DEPLOY);
  });

  it("rejects secret material in a proposed commit", () => {
    expect(
      assertProposedCommitHasNoSecrets([
        { path: "docs/OPERATIONAL-RUNBOOK.md", text: "no secrets here" },
        {
          path: "server/runtime/host-requirements.ts",
          text: readFileSync(
            path.join(root, "server/runtime/host-requirements.ts"),
            "utf8",
          ),
        },
        {
          path: "src/lib/backup.ts",
          text: readFileSync(path.join(root, "src/lib/backup.ts"), "utf8"),
        },
      ]),
    ).toEqual({ secretsCommitted: false });
    expect(() =>
      assertProposedCommitHasNoSecrets([{ path: ".env", text: "X=1" }]),
    ).toThrow("SecretCommitRefused");
    expect(() =>
      assertProposedCommitHasNoSecrets([
        {
          path: "notes.json",
          text: JSON.stringify({ passphrase: "not-a-real-secret" }),
        },
      ]),
    ).toThrow("SecretCommitRefused");
    expect(() =>
      assertProposedCommitHasNoSecrets([
        {
          path: "key.txt",
          text: `-----BEGIN ${"PRIVATE KEY"}-----\nblob`,
        },
      ]),
    ).toThrow("SecretCommitRefused");
    expect(() =>
      assertProposedCommitHasNoSecrets([
        { path: "key.txt", text: "AKIA" + "A".repeat(16) },
      ]),
    ).toThrow("SecretCommitRefused");
    expect(() =>
      assertProposedCommitHasNoSecrets([
        {
          path: "backup.json",
          text: JSON.stringify({ format: "qsb-encrypted-v1", ciphertext: "aa" }),
        },
      ]),
    ).toThrow("SecretCommitRefused:backup");
  });

  it("keeps the commit-before-deploy reminder aligned with AGENTS.md", () => {
    const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
    agentsDeploymentRule(agents);
    readAgentsDeploymentRule(root);
    const runbook = readFileSync(
      path.join(root, "docs/OPERATIONAL-RUNBOOK.md"),
      "utf8",
    );
    for (const rule of Object.values(RUNBOOK_RULES)) expect(runbook).toContain(rule);
    expect(runbook).toContain("providerGpuLimit");
    expect(runbook).toContain("retry: false");
  });
});

describe("operational runbook", () => {
  it("accepts explicit caps and does not execute them", () => {
    expect(acceptOperationalRunbook(runbook())).toMatchObject({
      accepted: true,
      executed: false,
      provisioned: false,
      maxConcurrentSearches: 1,
      maxGpuWorkers: 1,
      minIdleWorkers: 0,
      maxCostUnits: "1000",
      unknownPaidOutcome: "reconcile",
      blindRetry: false,
      rollbackAuthorizesSpend: false,
      mainnetEnabled: false,
      broadcastAuthorized: false,
      section8Closed: false,
    });
  });

  it("refuses a raised cap, a missing cost ceiling, a past deadline, and a worker watchdog", () => {
    expect(() =>
      acceptOperationalRunbook(runbook({ maxGpuWorkers: 2 })),
    ).toThrow("ConcurrencyCapExceeded");
    expect(() =>
      acceptOperationalRunbook(runbook({ minIdleWorkers: 1 })),
    ).toThrow("ConcurrencyCapExceeded");
    expect(() =>
      acceptOperationalRunbook(runbook({ maxCostUnits: "0" })),
    ).toThrow("CostCapRequired");
    expect(() =>
      acceptOperationalRunbook(runbook({ deadline: now })),
    ).toThrow("DeadlineRequired");
    expect(() =>
      acceptOperationalRunbook(
        runbook({ cleanupWatchdogId: "search-worker" }),
      ),
    ).toThrow("CleanupWatchdogRefused");
    expect(() =>
      acceptOperationalRunbook(
        runbook({
          incident: {
            stopNewWork: true,
            preserveUnknownPaidOutcomes: true,
            blindRetry: true,
          },
        }),
      ),
    ).toThrow("BlindRetryRefused");
    expect(() =>
      acceptOperationalRunbook(
        runbook({
          rollback: {
            reviveLegacyWriters: true,
            releaseConsumedCommitments: false,
            duplicatePaidWork: false,
            authorizeSpend: false,
          },
        }),
      ),
    ).toThrow("RollbackRefused");
  });

  it("preserves unknown paid outcomes instead of retrying", () => {
    for (const outcome of ["unknown", "timeout", "http-ambiguous"] as const) {
      expect(
        reconcilePaidOutcome({ outcome, requestedAction: "reconcile" }),
      ).toMatchObject({
        action: "reconcile",
        retry: false,
        duplicateSubmission: false,
        mainnetEnabled: false,
        broadcastAuthorized: false,
      });
      expect(() =>
        reconcilePaidOutcome({ outcome, requestedAction: "retry" }),
      ).toThrow("BlindRetryRefused");
      expect(() =>
        reconcilePaidOutcome({ outcome, requestedAction: "record" }),
      ).toThrow("UnknownOutcomeNeedsReconciliation");
    }
    expect(
      reconcilePaidOutcome({
        outcome: "succeeded",
        requestedAction: "record",
      }).action,
    ).toBe("record");
    expect(() =>
      reconcilePaidOutcome({ outcome: "succeeded", requestedAction: "retry" }),
    ).toThrow("BlindRetryRefused");
    expect(
      reconcilePaidOutcome({
        outcome: "failed-before-submit",
        requestedAction: "reconcile",
      }).retry,
    ).toBe(false);
  });
});

describe("in-repo regression judgment", () => {
  it("does not close the deployed UI or API item", () => {
    expect(
      judgeInRepoRegression({
        backupReimported: true,
        oneTimeCommitmentRefused: true,
        walletChangeRefused: true,
        exactIntentDisplayed: true,
      }),
    ).toMatchObject({
      inRepoRegressionPassed: true,
      closesDeployedUiApiItem: false,
      observedDeployedUi: false,
      observedDeployedApi: false,
      section8Closed: false,
      mainnetEnabled: false,
      broadcastAuthorized: false,
    });
    expect(
      judgeInRepoRegression({
        backupReimported: true,
        oneTimeCommitmentRefused: false,
        walletChangeRefused: true,
        exactIntentDisplayed: true,
      }).inRepoRegressionPassed,
    ).toBe(false);
  });
});
