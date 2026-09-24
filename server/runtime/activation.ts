import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { release } from "../../src/lib/model";
import capability from "../mainnet-capability.json";
import { assertNoCredentialMaterial } from "./host-requirements";
import { exactSpendAuthorizationSchema } from "./miner-inclusion";

/**
 * Section 8 gates. Nothing here deploys, enables mainnet, or authorizes a
 * spend. A decision record stays unapproved unless a later reviewed change
 * says otherwise, and this module still refuses to apply one.
 * release.mainnetEnabled and broadcastAuthorized stay false.
 */

export class ActivationError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ActivationError";
  }
}

export const COMMIT_BEFORE_DEPLOY =
  "Never deploy code or infrastructure changes before committing them to Git. Verify that deployed source matches the recorded commit and contains no uncommitted changes. Push the commit to the project remote before deployment and report the commit or PR with the deployment target. Never commit secrets or ignored runtime configuration.";

export const RUNBOOK_RULES = {
  publication: "Publishing research source is not deployment or activation.",
  featureSpend: "Feature enablement is not authorization to spend.",
  unknownPaid:
    "Preserve unknown paid outcomes for reconciliation rather than retrying blindly.",
  localBuild: "Local builds and source flags are not live-configuration evidence.",
  remoteStop: "Loss of a local process is not proof that remote GPU work stopped.",
  exactSpend:
    "Every proposed mainnet spend requires a separate exact-transaction authorization.",
  costField: "The operator cost field is not the experimental USD ceiling.",
  commit: COMMIT_BEFORE_DEPLOY,
} as const;

export const OPEN_RELEASE_GATES = [
  "Sections 1 through 7 still have open technical gates.",
  "No native binary, OCI image config, index, or registry manifest is enrolled.",
  "No production host, regional inventory, or IAM review is recorded.",
  "No fresh optimized withdrawal or external miner inclusion is recorded.",
  RUNBOOK_RULES.publication,
  RUNBOOK_RULES.featureSpend,
] as const;

/** Matches server/mainnet-capability.json providerGpuLimit. Not a capacity study. */
export const CONCURRENCY_CAP = {
  maxConcurrentSearches: 1,
  maxGpuWorkers: 1,
  minIdleWorkers: 0,
} as const;

export const REQUIRED_ALERTS = [
  "cost-cap",
  "deadline",
  "uncertain-paid-outcome",
  "cleanup-failure",
  "activation-attempt",
] as const;

const hash64 = z.string().regex(/^[a-f0-9]{64}$/);
const commit40 = z.string().regex(/^[0-9a-f]{40}$/);
const ociDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const positiveUnits = z.string().regex(/^[1-9][0-9]{0,15}$/);
const forbiddenCommitPath =
  /(^|[\\/])\.env($|[\\/.])|\.pem$|\.key$|id_rsa|credentials\.json|wallet-backup|secret\./i;

const decisionSchema = z
  .object({
    format: z.literal("qsb-activation-decision-v1"),
    decision: z.enum(["not-approved", "approved"]),
    reviewer: z.string().min(1).max(120).nullable(),
    reviewedAt: z.string().datetime().nullable(),
    limitations: z.array(z.string().min(1).max(500)).min(1).max(20),
    evidenceLinks: z.array(z.string().min(1).max(200)).max(20),
    featureEnablementRequested: z.boolean(),
    spendRecordRequested: z.literal(false),
    technicalGatesClosed: z.literal(false),
    publicationIsActivation: z.literal(false),
    mainnetEnabled: z.literal(false),
    broadcastAuthorized: z.literal(false),
    section8Closed: z.literal(false),
  })
  .strict();

export type ActivationDecision = z.infer<typeof decisionSchema>;

export type ActivationEvaluation = {
  format: "qsb-activation-evaluation-v1";
  recordShape: "unapproved" | "approval-attempt";
  decisionRecordAccepted: boolean;
  applied: false;
  featureEnabled: false;
  spendAuthorized: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
  section8Closed: false;
  publicationIsActivation: false;
  reason: string;
};

const notProducedSchema = z
  .object({
    status: z.literal("not-produced"),
    value: z.null(),
  })
  .strict();

const deploymentSchema = z
  .object({
    format: z.literal("qsb-deployment-record-v1"),
    commit: commit40,
    treeClean: z.literal(true),
    committed: z.literal(true),
    pushed: z.literal(true),
    remoteMatchesRecordedCommit: z.literal(true),
    packageManifestSha256: hash64,
    imageConfigDigest: z.union([ociDigest, notProducedSchema]),
    ociIndexDigest: z.union([ociDigest, notProducedSchema]),
    registryManifestDigest: z.union([ociDigest, notProducedSchema]),
    configurationHash: hash64,
    evidenceKind: z.literal("live-deployed-observation"),
    deployedRoutesObserved: z.literal(false),
    capabilitiesObserved: z.literal(false),
    identitiesObserved: z.literal(false),
    permissionsObserved: z.literal(false),
    sourceMainnetEnabled: z.literal(false),
    sourceBroadcastAuthorized: z.literal(false),
  })
  .strict();

export type DeploymentAssessment = {
  format: "qsb-deployment-assessment-v1";
  commitRecorded: true;
  packageBindingRecorded: true;
  configurationBindingRecorded: true;
  imageBindingsRecorded: boolean;
  localBuildAcceptedAsLive: false;
  sourceFlagsAcceptedAsLive: false;
  liveVerified: false;
  deployPerformed: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
  section8Closed: false;
  reason: string;
  reminder: typeof COMMIT_BEFORE_DEPLOY;
};

const runbookSchema = z
  .object({
    format: z.literal("qsb-operational-runbook-v1"),
    maxConcurrentSearches: z.literal(CONCURRENCY_CAP.maxConcurrentSearches),
    maxGpuWorkers: z.literal(CONCURRENCY_CAP.maxGpuWorkers),
    minIdleWorkers: z.literal(CONCURRENCY_CAP.minIdleWorkers),
    costUnit: z.literal("operator-units"),
    maxCostUnits: positiveUnits,
    deadline: z.string().datetime(),
    now: z.string().datetime(),
    workerId: z.string().min(1).max(128),
    cleanupWatchdogId: z.string().min(1).max(128),
    cleanupIndependentOfWorker: z.literal(true),
    alerts: z.array(z.enum(REQUIRED_ALERTS)).min(REQUIRED_ALERTS.length).max(8),
    incident: z
      .object({
        stopNewWork: z.literal(true),
        preserveUnknownPaidOutcomes: z.literal(true),
        blindRetry: z.literal(false),
      })
      .strict(),
    safeStop: z
      .object({
        stopNewSubmissions: z.literal(true),
        unknownPaidOutcome: z.literal("reconcile"),
        localProcessLossProvesRemoteStop: z.literal(false),
      })
      .strict(),
    rollback: z
      .object({
        reviveLegacyWriters: z.literal(false),
        releaseConsumedCommitments: z.literal(false),
        duplicatePaidWork: z.literal(false),
        authorizeSpend: z.literal(false),
      })
      .strict(),
    mainnetEnabled: z.literal(false),
    broadcastAuthorized: z.literal(false),
  })
  .strict();

export type RunbookAcceptance = {
  format: "qsb-operational-runbook-acceptance-v1";
  accepted: true;
  executed: false;
  provisioned: false;
  maxConcurrentSearches: 1;
  maxGpuWorkers: 1;
  minIdleWorkers: 0;
  costUnit: "operator-units";
  maxCostUnits: string;
  costFieldIsUsdCeiling: false;
  usdLimitsEvaluated: false;
  deadline: string;
  cleanupWatchdogId: string;
  alerts: readonly (typeof REQUIRED_ALERTS)[number][];
  unknownPaidOutcome: "reconcile";
  blindRetry: false;
  rollbackAuthorizesSpend: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
  section8Closed: false;
};

const paidOutcomeSchema = z.enum([
  "succeeded",
  "failed-before-submit",
  "unknown",
  "timeout",
  "http-ambiguous",
]);

export type PaidOutcome = z.infer<typeof paidOutcomeSchema>;

export type PaidOutcomeDisposition = {
  format: "qsb-paid-outcome-v1";
  outcome: PaidOutcome;
  action: "record" | "reconcile";
  retry: false;
  duplicateSubmission: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
};

function fail(code: string): never {
  throw new ActivationError(code);
}

function containsEncryptedBackup(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsEncryptedBackup);
  const raw = value as Record<string, unknown>;
  if (raw.format === "qsb-encrypted-v1") return true;
  return Object.values(raw).some(containsEncryptedBackup);
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function refuseActivationFlags(raw: Record<string, unknown>): void {
  if (raw.mainnetEnabled === true || raw.broadcastAuthorized === true)
    fail("ActivationRefused");
  if (raw.section8Closed === true) fail("ActivationNotApproved");
  if (raw.publicationIsActivation === true) fail("PublicationIsNotActivation");
  if (raw.spendRecordRequested === true) fail("SpendIsNotFeatureEnablement");
  if (raw.technicalGatesClosed === true) fail("TechnicalGatesOpen");
}

function assertEvidenceLinks(links: readonly string[]): void {
  for (const link of links) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link) && !/^https:\/\//i.test(link))
      fail("ActivationDecisionRejected");
    if (/token=|api[_-]?key|secret|passphrase|@/i.test(link))
      fail("CredentialMaterialRejected:evidence");
  }
}

export function defaultActivationDecision(): ActivationDecision {
  return {
    format: "qsb-activation-decision-v1",
    decision: "not-approved",
    reviewer: null,
    reviewedAt: null,
    limitations: [...OPEN_RELEASE_GATES],
    evidenceLinks: [],
    featureEnablementRequested: false,
    spendRecordRequested: false,
    technicalGatesClosed: false,
    publicationIsActivation: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
    section8Closed: false,
  };
}

function evaluation(
  recordShape: ActivationEvaluation["recordShape"],
  decisionRecordAccepted: boolean,
  reason: string,
): ActivationEvaluation {
  return {
    format: "qsb-activation-evaluation-v1",
    recordShape,
    decisionRecordAccepted,
    applied: false,
    featureEnabled: false,
    spendAuthorized: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
    section8Closed: false,
    publicationIsActivation: false,
    reason,
  };
}

/** A reviewed record is required before enablement. This checkout does not apply it. */
export function evaluateActivation(input: unknown): ActivationEvaluation {
  assertNoCredentialMaterial(input);
  const raw = record(input);
  if (!raw) fail("ActivationDecisionRejected");
  refuseActivationFlags(raw);
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) fail("ActivationDecisionRejected");
  assertEvidenceLinks(parsed.data.evidenceLinks);
  const complete =
    parsed.data.decision === "approved" &&
    parsed.data.reviewer !== null &&
    parsed.data.reviewedAt !== null &&
    parsed.data.evidenceLinks.length > 0;
  if (!complete)
    return evaluation(
      "unapproved",
      false,
      "Activation decision is not approved. Feature enablement stays off and does not authorize a spend.",
    );
  return evaluation(
    "approval-attempt",
    false,
    "A reviewed decision record does not enable mainnet in this checkout and does not authorize a spend. Technical gates above are not closed.",
  );
}

/**
 * Feature enablement and spend authorization are different records.
 * The spend record is the section 7 exact-spend authorization. Accepting it
 * here does not broadcast and does not grant the section 7 permit.
 */
export function requireExactSpendBesideActivation(input: {
  activation: unknown;
  exactSpend: unknown;
}): ActivationEvaluation & {
  exactSpendRecordPresent: true;
} {
  if (input.exactSpend === input.activation) fail("SpendIsNotFeatureEnablement");
  assertNoCredentialMaterial(input.exactSpend);
  const activation = evaluateActivation(input.activation);
  const raw = record(input.exactSpend);
  if (!raw) fail("ExactTransactionAuthorizationRequired");
  if (raw.mainnetEnabled === true || raw.broadcastAuthorized === true)
    fail("ActivationRefused");
  if (!exactSpendAuthorizationSchema.safeParse(input.exactSpend).success)
    fail("ExactTransactionAuthorizationRequired");
  return {
    ...activation,
    exactSpendRecordPresent: true,
    spendAuthorized: false,
    broadcastAuthorized: false,
    reason:
      "Feature enablement and the exact spend record are separate. Neither authorizes a broadcast from this checkout.",
  };
}

export function assertCommitBeforeDeploy(input: {
  committed: boolean;
  pushed: boolean;
  clean: boolean;
}): {
  reminder: typeof COMMIT_BEFORE_DEPLOY;
  deployAllowedByThisCheckout: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
} {
  if (!input.committed || !input.pushed || !input.clean)
    fail(`CommitBeforeDeploy:${COMMIT_BEFORE_DEPLOY}`);
  return {
    reminder: COMMIT_BEFORE_DEPLOY,
    deployAllowedByThisCheckout: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
  };
}

const localEvidence = new Set([
  "local-build",
  "source-flag",
  "unit-test",
  "vite-build",
]);

/** Records a pushed commit and bindings. It does not observe a live deployment. */
export function assessDeploymentRecord(input: unknown): DeploymentAssessment {
  assertNoCredentialMaterial(input);
  const raw = record(input);
  if (!raw) fail("DeploymentRecordRefused");
  refuseActivationFlags(raw);
  if (
    raw.sourceMainnetEnabled === true ||
    raw.sourceBroadcastAuthorized === true
  )
    fail("ActivationRefused");
  if (
    raw.committed !== true ||
    raw.pushed !== true ||
    raw.treeClean !== true ||
    raw.remoteMatchesRecordedCommit !== true
  )
    fail(`CommitBeforeDeploy:${COMMIT_BEFORE_DEPLOY}`);
  if (
    raw.deployedRoutesObserved === true ||
    raw.capabilitiesObserved === true ||
    raw.identitiesObserved === true ||
    raw.permissionsObserved === true
  )
    fail("LiveObservationNotAvailableInCheckout");
  if (typeof raw.evidenceKind === "string" && localEvidence.has(raw.evidenceKind))
    fail("LocalBuildIsNotLiveConfiguration");
  const parsed = deploymentSchema.safeParse(input);
  if (!parsed.success) fail("DeploymentRecordRefused");
  const digests = [
    parsed.data.imageConfigDigest,
    parsed.data.ociIndexDigest,
    parsed.data.registryManifestDigest,
  ];
  const imageBindingsRecorded = digests.every((digest) => typeof digest === "string");
  return {
    format: "qsb-deployment-assessment-v1",
    commitRecorded: true,
    packageBindingRecorded: true,
    configurationBindingRecorded: true,
    imageBindingsRecorded,
    localBuildAcceptedAsLive: false,
    sourceFlagsAcceptedAsLive: false,
    liveVerified: false,
    deployPerformed: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
    section8Closed: false,
    reason: imageBindingsRecorded
      ? "Commit, package, image, and configuration bindings are present on the record. This checkout did not observe deployed routes, capabilities, identities, or permissions."
      : "Commit, package, and configuration hashes are present. Image config, OCI index, and registry manifest bindings are not enrolled, so this record is not live-configuration evidence.",
    reminder: COMMIT_BEFORE_DEPLOY,
  };
}

const quotedCredential =
  /(?:^|[^A-Za-z0-9_])(?:passphrase|password|api[_-]?key|secretString|private[_-]?key|mnemonic|seed|token|walletBackup|authorization)\s*[:=]\s*(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`)/i;
const envCredential =
  /(?:^|[\n;])\s*(?:export\s+)?[A-Z0-9_]*(?:PASSPHRASE|PASSWORD|API_KEY|SECRET|TOKEN|MNEMONIC|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*(?:"[^"\n]+"|'[^'\n]+'|\S+)/;
const yamlCredential =
  /(?:^|\n)\s*(?:passphrase|password|api_key|api-key|private_key|mnemonic|token)\s*:\s*(?:"[^"\n]+"|'[^'\n]+'|[^\s#]+)/i;

export type ProposedCommitSecretVerdict = {
  format: "qsb-proposed-commit-secret-verdict-v1";
  verdict: "clean" | "indeterminate";
  secretsCommitted: false | "unscanned";
  certified: boolean;
  unscannedPaths: string[];
};

function refuseCredentialText(file: { path: string; text: string }): void {
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(file.text) ||
    /AKIA[0-9A-Z]{16}/.test(file.text) ||
    quotedCredential.test(file.text) ||
    envCredential.test(file.text)
  )
    fail("SecretCommitRefused:material");
  if (/\.(?:ya?ml|txt)$/i.test(file.path) && yamlCredential.test(file.text))
    fail("SecretCommitRefused:material");
}

/** JSON objects are scanned structurally. Other text is not certified clean. */
function jsonStructurallyScanned(file: { path: string; text: string }): boolean {
  const trimmed = file.text.trim();
  if (trimmed === "") return true;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (containsEncryptedBackup(parsed)) fail("SecretCommitRefused:backup");
    assertNoCredentialMaterial(parsed, file.path);
    return true;
  } catch (error) {
    if (error instanceof ActivationError) throw error;
    if (error instanceof SyntaxError) return false;
    if (
      error instanceof Error &&
      error.message.startsWith("CredentialMaterialRejected")
    )
      fail(`SecretCommitRefused:${error.message}`);
    throw error;
  }
}

export function assertProposedCommitHasNoSecrets(
  files: { path: string; text: string }[],
): ProposedCommitSecretVerdict {
  if (files.length === 0) fail("SecretCommitRefused:empty");
  const unscannedPaths: string[] = [];
  for (const file of files) {
    if (forbiddenCommitPath.test(file.path)) fail(`SecretCommitRefused:${file.path}`);
    refuseCredentialText(file);
    if (!jsonStructurallyScanned(file)) unscannedPaths.push(file.path);
  }
  if (unscannedPaths.length > 0)
    return {
      format: "qsb-proposed-commit-secret-verdict-v1",
      verdict: "indeterminate",
      secretsCommitted: "unscanned",
      certified: false,
      unscannedPaths,
    };
  return {
    format: "qsb-proposed-commit-secret-verdict-v1",
    verdict: "clean",
    secretsCommitted: false,
    certified: true,
    unscannedPaths: [],
  };
}

export function agentsDeploymentRule(agentsMarkdown: string): void {
  if (!agentsMarkdown.includes(COMMIT_BEFORE_DEPLOY))
    fail("CommitBeforeDeployReminderMissing");
  if (!agentsMarkdown.includes("Never commit secrets"))
    fail("SecretCommitReminderMissing");
}

function numberAboveCap(value: unknown, cap: number): boolean {
  return typeof value === "number" && value > cap;
}

/**
 * Experimental USD envelope: vault 10000, fee 1000, GPU 1000.
 * This is the only encoding of those ceilings. It cannot run while
 * release.mainnetEnabled and broadcastAuthorized are false, and it does
 * not read the operator cost field or approve activation.
 */
function usdLimitCheckCanRun(): boolean {
  return Boolean(release.mainnetEnabled) && Boolean(capability.broadcastAuthorized);
}

export function assertExperimentalUsdLimits(amounts: {
  vaultUsd: number;
  feeUsd: number;
  gpuUsd: number;
}): never {
  if (!usdLimitCheckCanRun()) fail("UsdLimitCheckClosed");
  const vaultUsdLimit = 10_000;
  const feeUsdLimit = 1_000;
  const gpuUsdLimit = 1_000;
  const withinEnvelope =
    Number.isSafeInteger(amounts.vaultUsd) &&
    Number.isSafeInteger(amounts.feeUsd) &&
    Number.isSafeInteger(amounts.gpuUsd) &&
    amounts.vaultUsd >= 0 &&
    amounts.vaultUsd <= vaultUsdLimit &&
    amounts.feeUsd >= 0 &&
    amounts.feeUsd <= feeUsdLimit &&
    amounts.gpuUsd >= 0 &&
    amounts.gpuUsd <= gpuUsdLimit;
  if (!withinEnvelope) fail("UsdCeilingExceeded");
  fail("ActivationNotApproved");
}

function claimsCostFieldIsUsd(raw: Record<string, unknown>): boolean {
  return (
    raw.costUnit === "usd" ||
    raw.maxCostUnitsIsUsdCeiling === true ||
    "vaultUsd" in raw ||
    "feeUsd" in raw ||
    "gpuUsd" in raw
  );
}

/** Accepts a written procedure. It does not provision workers or start cleanup. */
export function acceptOperationalRunbook(input: unknown): RunbookAcceptance {
  assertNoCredentialMaterial(input);
  const raw = record(input);
  if (!raw) fail("RunbookIncomplete");
  refuseActivationFlags(raw);
  if (claimsCostFieldIsUsd(raw)) fail("CostFieldIsNotUsdCeiling");
  if (
    numberAboveCap(raw.maxConcurrentSearches, CONCURRENCY_CAP.maxConcurrentSearches) ||
    numberAboveCap(raw.maxGpuWorkers, CONCURRENCY_CAP.maxGpuWorkers) ||
    (raw.minIdleWorkers !== undefined && raw.minIdleWorkers !== 0)
  )
    fail("ConcurrencyCapExceeded");
  if (raw.maxCostUnits === undefined || raw.maxCostUnits === "0" || raw.maxCostUnits === "")
    fail("CostCapRequired");
  const incident = record(raw.incident);
  if (incident?.blindRetry === true) fail("BlindRetryRefused");
  const rollback = record(raw.rollback);
  if (rollback?.authorizeSpend === true) fail("SpendIsNotFeatureEnablement");
  if (
    rollback?.reviveLegacyWriters === true ||
    rollback?.releaseConsumedCommitments === true ||
    rollback?.duplicatePaidWork === true
  )
    fail("RollbackRefused");
  const parsed = runbookSchema.safeParse(input);
  if (!parsed.success) fail("RunbookIncomplete");
  if (Date.parse(parsed.data.deadline) <= Date.parse(parsed.data.now))
    fail("DeadlineRequired");
  if (
    parsed.data.cleanupWatchdogId === parsed.data.workerId ||
    parsed.data.cleanupIndependentOfWorker !== true
  )
    fail("CleanupWatchdogRefused");
  const alerts = new Set(parsed.data.alerts);
  for (const alert of REQUIRED_ALERTS) {
    if (!alerts.has(alert)) fail("RunbookIncomplete");
  }
  return {
    format: "qsb-operational-runbook-acceptance-v1",
    accepted: true,
    executed: false,
    provisioned: false,
    maxConcurrentSearches: 1,
    maxGpuWorkers: 1,
    minIdleWorkers: 0,
    costUnit: "operator-units",
    maxCostUnits: parsed.data.maxCostUnits,
    costFieldIsUsdCeiling: false,
    usdLimitsEvaluated: false,
    deadline: parsed.data.deadline,
    cleanupWatchdogId: parsed.data.cleanupWatchdogId,
    alerts: REQUIRED_ALERTS,
    unknownPaidOutcome: "reconcile",
    blindRetry: false,
    rollbackAuthorizesSpend: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
    section8Closed: false,
  };
}

function paidAction(outcome: PaidOutcome): "record" | "reconcile" {
  switch (outcome) {
    case "succeeded":
    case "failed-before-submit":
      return "record";
    case "unknown":
    case "timeout":
    case "http-ambiguous":
      return "reconcile";
    default: {
      const neverOutcome: never = outcome;
      throw new ActivationError(`Unhandled paid outcome: ${neverOutcome}`);
    }
  }
}

/** Unknown paid results stay for reconciliation. This function never retries. */
export function reconcilePaidOutcome(input: {
  outcome: PaidOutcome;
  requestedAction: "reconcile" | "retry" | "record";
}): PaidOutcomeDisposition {
  assertNoCredentialMaterial(input);
  const outcome = paidOutcomeSchema.parse(input.outcome);
  if (input.requestedAction === "retry") fail("BlindRetryRefused");
  const action = paidAction(outcome);
  if (input.requestedAction === "record" && action === "reconcile")
    fail("UnknownOutcomeNeedsReconciliation");
  return {
    format: "qsb-paid-outcome-v1",
    outcome,
    action,
    retry: false,
    duplicateSubmission: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
  };
}

export function judgeInRepoRegression(results: {
  backupReimported: boolean;
  oneTimeCommitmentRefused: boolean;
  walletChangeRefused: boolean;
  exactIntentDisplayed: boolean;
}): {
  format: "qsb-deployed-regression-judgment-v1";
  inRepoRegressionPassed: boolean;
  closesDeployedUiApiItem: false;
  observedDeployedUi: false;
  observedDeployedApi: false;
  section8Closed: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
} {
  return {
    format: "qsb-deployed-regression-judgment-v1",
    inRepoRegressionPassed:
      results.backupReimported &&
      results.oneTimeCommitmentRefused &&
      results.walletChangeRefused &&
      results.exactIntentDisplayed,
    closesDeployedUiApiItem: false,
    observedDeployedUi: false,
    observedDeployedApi: false,
    section8Closed: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
  };
}

export function readAgentsDeploymentRule(root: string): void {
  const absolute = path.join(path.resolve(root), "AGENTS.md");
  agentsDeploymentRule(readFileSync(absolute, "utf8"));
}
