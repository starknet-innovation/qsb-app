import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fingerprint } from "../../src/lib/provenance";
import type { Row } from "../store";
import { assertNoCredentialMaterial } from "./host-requirements";
import {
  createSourceManifest,
  serializeManifest,
  sourceReleaseManifestSchema,
  type SourceReleaseManifest,
} from "./package-release";
import { sha256Hex } from "./identity";
import { inventoryRows } from "./storage-authority";
import { SUPERVISED_PROFILE_ID } from "./types";

/** Known-solution replay, a synthetic no-hit range, and mocked success are not a fresh search. */
export const NOT_A_FRESH_SEARCH =
  "Known-solution replay, synthetic no-hit ranges, and mocked success are not substitutes for a fresh search.";

/**
 * Public label for the spent historical Xverse regtest withdrawal.
 * The signed transaction and fixture bytes are not in this checkout.
 */
export const HISTORICAL_XVERSE_REGTEST_WITHDRAWAL = {
  label: "historical-xverse-regtest-withdrawal",
  chain: "regtest",
  spent: true,
  presentInCheckout: false,
} as const;

export type ProofChain = "mainnet" | "regtest" | "testnet4";

export type SearchEvidenceKind =
  "not-run" | "known-solution-replay" | "synthetic-no-hit" | "mocked-success";

const hash64 = z.string().regex(/^[a-f0-9]{64}$/);
/** Positive sats only, capped at the same supply limit as src/lib/model.ts. */
const BITCOIN_SUPPLY_SATS = 2100000000000000n;
const sats = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine(
    (value) => BigInt(value) <= BITCOIN_SUPPLY_SATS,
    "Amount exceeds Bitcoin supply",
  );
const proofChainSchema = z.enum(["mainnet", "regtest", "testnet4"]);

const proofServiceSchema = z
  .object({
    format: z.literal("qsb-proof-service-config-v1"),
    serviceId: z.string().min(1).max(128),
    configuredChain: proofChainSchema,
    mainnetOnly: z.boolean(),
    releaseProfileId: z.literal(SUPERVISED_PROFILE_ID),
    sourceManifestSha256: hash64,
    nativeBinariesEnrolled: z.literal(false),
    mainnetEnabled: z.literal(false),
    broadcastAuthorized: z.literal(false),
  })
  .strict();

export type ProofServiceConfig = z.infer<typeof proofServiceSchema>;

export type EnrolledRelease = {
  profileId: typeof SUPERVISED_PROFILE_ID;
  sourceManifestSha256: string;
  nativeBinariesEnrolled: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
};

function checkoutRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

type ParsedReleaseManifest = z.infer<typeof sourceReleaseManifestSchema>;

/**
 * A checkout commits `release/source-manifest.json`.
 * `writePackageTree` emits that same document as `release-manifest.json` beside `tree/`.
 */
export function committedManifestPath(root: string): string {
  const checkoutManifest = path.join(root, "release", "source-manifest.json");
  if (existsSync(checkoutManifest)) return checkoutManifest;
  if (path.basename(root) === "tree") {
    const packagedManifest = path.resolve(root, "..", "release-manifest.json");
    if (existsSync(packagedManifest)) return packagedManifest;
  }
  throw new Error("ReleaseManifestRejected");
}

function readCommittedManifest(root: string): ParsedReleaseManifest {
  try {
    return sourceReleaseManifestSchema.parse(
      JSON.parse(readFileSync(committedManifestPath(root), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "ReleaseManifestRejected")
      throw error;
    throw new Error("ReleaseManifestRejected");
  }
}

/** The presented manifest must be the committed file and the current checkout. */
function assertBoundReleaseManifest(
  manifest: ParsedReleaseManifest,
  root: string,
): void {
  const serialized = serializeManifest(manifest as SourceReleaseManifest);
  if (
    serializeManifest(readCommittedManifest(root) as SourceReleaseManifest) !==
    serialized
  )
    throw new Error("ReleaseEnrollmentMismatch");
  if (serializeManifest(createSourceManifest(root)) !== serialized)
    throw new Error("ReleaseEnrollmentMismatch");
}

/**
 * Dependency map keys are npm package names, including
 * `@aws-sdk/client-secrets-manager`. Scan their versions, not those names.
 */
function manifestForCredentialScan(manifest: unknown): unknown {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return manifest;
  const copy = structuredClone(manifest) as {
    buildInputs?: { dependencies?: unknown; devDependencies?: unknown };
  };
  const inputs = copy.buildInputs;
  if (!inputs || typeof inputs !== "object") return copy;
  for (const field of ["dependencies", "devDependencies"] as const) {
    const table = inputs[field];
    if (!table || typeof table !== "object" || Array.isArray(table)) continue;
    inputs[field] = Object.values(table);
  }
  return copy;
}

export function enrolledReleaseIdentity(manifest: unknown): EnrolledRelease {
  assertNoCredentialMaterial(manifestForCredentialScan(manifest));
  const parsed = sourceReleaseManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join("."));
    if (
      paths.some(
        (item) =>
          item.includes("mainnetEnabled") ||
          item.includes("broadcastAuthorized") ||
          item.includes("placeholderIsDeployable"),
      )
    )
      throw new Error("ActivationRefused");
    if (
      paths.some(
        (item) =>
          item.startsWith("identities.nativeBinaries") ||
          item.startsWith("identities.imageConfig") ||
          item.startsWith("identities.ociIndex") ||
          item.startsWith("identities.registryManifest"),
      )
    )
      throw new Error("NativeBinaryEnrollmentNotInThisCheckout");
    throw new Error("ReleaseManifestRejected");
  }
  assertBoundReleaseManifest(parsed.data, checkoutRoot());
  return {
    profileId: SUPERVISED_PROFILE_ID,
    sourceManifestSha256: fingerprint(parsed.data),
    nativeBinariesEnrolled: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
  };
}

function parseProofService(input: unknown): ProofServiceConfig {
  const parsed = proofServiceSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const paths = parsed.error.issues.map((issue) => issue.path.join("."));
  if (
    paths.some(
      (path) =>
        path.includes("mainnetEnabled") || path.includes("broadcastAuthorized"),
    )
  )
    throw new Error("ActivationRefused");
  if (paths.some((path) => path.includes("nativeBinariesEnrolled")))
    throw new Error("NativeBinaryEnrollmentNotInThisCheckout");
  if (paths.some((path) => path.includes("releaseProfileId")))
    throw new Error("ReleaseEnrollmentMismatch");
  throw new Error("ProofServiceConfigRejected");
}

export type ProofRunnerSelection = {
  format: "qsb-proof-runner-selection-v1";
  chain: "regtest";
  serviceId: string;
  releaseProfileId: typeof SUPERVISED_PROFILE_ID;
  sourceManifestSha256: string;
  nativeBinariesEnrolled: false;
  liveRunnerContacted: false;
  certifiesFreshOptimizedWithdrawal: false;
  freshSearch: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
  limits: readonly string[];
};

/**
 * Accepts a chain-correct regtest service whose release hash matches enrollment.
 * This does not contact a runner and does not perform a search.
 */
export function selectProofRunner(input: {
  requestedChain: ProofChain;
  advertisedChain: ProofChain;
  service: unknown;
  enrolled: EnrolledRelease;
}): ProofRunnerSelection {
  assertNoCredentialMaterial(input.service);
  assertNoCredentialMaterial(input.enrolled);
  const service = parseProofService(input.service);
  if (input.enrolled.nativeBinariesEnrolled !== false)
    throw new Error("NativeBinaryEnrollmentNotInThisCheckout");
  if (
    input.enrolled.mainnetEnabled !== false ||
    input.enrolled.broadcastAuthorized !== false
  )
    throw new Error("ActivationRefused");
  if (input.enrolled.profileId !== SUPERVISED_PROFILE_ID)
    throw new Error("ReleaseEnrollmentMismatch");
  const relabeled =
    (service.configuredChain === "mainnet" &&
      (input.advertisedChain === "regtest" ||
        input.requestedChain === "regtest")) ||
    (service.mainnetOnly &&
      (service.configuredChain === "regtest" ||
        input.advertisedChain === "regtest" ||
        input.requestedChain === "regtest"));
  if (relabeled) throw new Error("MainnetConfigRelabeledAsRegtest");
  if (input.advertisedChain !== service.configuredChain)
    throw new Error("ChainLabelMismatch");
  if (input.requestedChain !== service.configuredChain)
    throw new Error("ProofChainMismatch");
  const bound = enrolledReleaseIdentity(readCommittedManifest(checkoutRoot()));
  if (
    input.enrolled.sourceManifestSha256 !== bound.sourceManifestSha256 ||
    input.enrolled.profileId !== bound.profileId
  )
    throw new Error("ReleaseEnrollmentMismatch");
  switch (service.configuredChain) {
    case "regtest":
      break;
    case "mainnet":
      throw new Error("MainnetProofNotAuthorized");
    case "testnet4":
      throw new Error("ControlledProofChainMustBeRegtest");
    default: {
      const neverChain: never = service.configuredChain;
      throw new Error(`Unhandled proof chain: ${String(neverChain)}`);
    }
  }
  if (
    service.sourceManifestSha256 !== bound.sourceManifestSha256 ||
    service.releaseProfileId !== bound.profileId
  )
    throw new Error("ReleaseEnrollmentMismatch");
  return {
    format: "qsb-proof-runner-selection-v1",
    chain: "regtest",
    serviceId: service.serviceId,
    releaseProfileId: service.releaseProfileId,
    sourceManifestSha256: service.sourceManifestSha256,
    nativeBinariesEnrolled: false,
    liveRunnerContacted: false,
    certifiesFreshOptimizedWithdrawal: false,
    freshSearch: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
    limits: [
      "No runner was contacted. Exact release enrollment here is the source-manifest hash, not a native binary.",
      NOT_A_FRESH_SEARCH,
    ],
  };
}

const outpointSchema = z
  .object({
    txid: z.string().regex(/^[a-f0-9]{64}$/i),
    vout: z.number().int().min(0).max(0xffffffff),
  })
  .strict();

export type Outpoint = z.infer<typeof outpointSchema>;

export type SpentFixtureRef = {
  label?: string;
  requestId?: string;
  vaultId?: string;
  publicCommitmentHash?: string;
  outpoint?: Outpoint;
};

const scriptHexSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{2})+$/i)
  .transform((value) => value.toLowerCase());

const proofOutputSchema = z
  .object({
    role: z.enum(["withdrawal", "change"]),
    scriptHex: scriptHexSchema,
    valueSats: sats,
  })
  .strict();

export type ProofOutput = z.infer<typeof proofOutputSchema>;

const disposableRequestSchema = z
  .object({
    format: z.literal("qsb-disposable-proof-request-v1"),
    chain: z.literal("regtest"),
    requestId: z.string().uuid(),
    vaultId: z.string().uuid(),
    publicCommitmentHash: hash64,
    amountSats: sats,
    feeSats: sats,
    outpoints: z.array(outpointSchema).max(8),
    outputs: z.array(proofOutputSchema).min(1).max(8),
    historicalFixture: z.literal(false),
    restartsHistoricalFixture: z.literal(false),
    freshSearchPerformed: z.literal(false),
    browserGenerated: z.literal(false),
    awaitingBrowserRequest: z.literal(true),
    globalFreshness: z.literal(false),
    mainnetEnabled: z.literal(false),
    broadcastAuthorized: z.literal(false),
  })
  .strict();

export type DisposableProofRequest = z.infer<typeof disposableRequestSchema>;

const scaffoldInputSchema = z
  .object({
    requestId: z.string().uuid(),
    vaultId: z.string().uuid(),
    publicCommitmentHash: hash64,
    amountSats: sats,
    feeSats: sats,
    outpoints: z.array(outpointSchema).max(8).default([]),
    outputs: z.array(proofOutputSchema).min(1).max(8),
    fixtureLabel: z.string().min(1).max(128).optional(),
  })
  .strict();

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeOutpoint(point: Outpoint): Outpoint {
  return { txid: point.txid.toLowerCase(), vout: point.vout };
}

function sameOutpoint(left: Outpoint, right: Outpoint): boolean {
  const a = normalizeOutpoint(left);
  const b = normalizeOutpoint(right);
  return a.txid === b.txid && a.vout === b.vout;
}

function outpointKey(point: Outpoint): string {
  const normalized = normalizeOutpoint(point);
  return `${normalized.txid}:${normalized.vout}`;
}

function assertUniqueOutpoints(points: Outpoint[]): void {
  const keys = points.map(outpointKey);
  if (new Set(keys).size !== keys.length) throw new Error("DuplicateOutpoint");
}

function assertSameOutpointMultiset(left: Outpoint[], right: Outpoint[]): void {
  assertUniqueOutpoints(left);
  assertUniqueOutpoints(right);
  const keys = (points: Outpoint[]) => points.map(outpointKey).sort();
  const a = keys(left);
  const b = keys(right);
  if (a.length !== b.length || a.some((key, index) => key !== b[index]))
    throw new Error("BindingMismatch");
}

function pushOutpoint(refs: SpentFixtureRef[], value: unknown): void {
  const point = record(value);
  const txid = text(point?.txid);
  if (!point || !txid || typeof point.vout !== "number") return;
  refs.push({ outpoint: { txid, vout: point.vout } });
}

/** Completed, spent, or consumed rows only. An in-progress job is not this denylist. */
export function spentRefsFromInventory(rows: Row[]): SpentFixtureRef[] {
  assertNoCredentialMaterial(rows);
  const refs: SpentFixtureRef[] = [];
  for (const row of rows) {
    const vault = record(row.vault);
    const job = record(row.job);
    const completed =
      row.historicalCompletedFixture === true ||
      row.spent === true ||
      row.consumed === true ||
      vault?.status === "spent" ||
      job?.status === "confirmed" ||
      job?.status === "spent";
    if (!completed) continue;
    const requestId = comparableIdentity(text(row.requestId) ?? text(job?.id));
    const vaultId = comparableIdentity(
      text(row.vaultId) ?? text(vault?.id) ?? text(job?.vaultId),
    );
    const publicCommitmentHash = comparableIdentity(
      text(row.publicCommitmentHash) ?? text(row.requestHash),
    );
    const label = text(row.fixtureLabel);
    if (requestId || vaultId || publicCommitmentHash || label)
      refs.push({ requestId, vaultId, publicCommitmentHash, label });
    const manifest = record(job?.manifest);
    pushOutpoint(refs, vault?.funding);
    pushOutpoint(refs, manifest?.funding);
    pushOutpoint(refs, manifest?.helper);
    if (text(row.txid) && typeof row.vout === "number")
      pushOutpoint(refs, { txid: row.txid, vout: row.vout });
  }
  return refs;
}

function comparableIdentity(value: string | undefined): string | undefined {
  return value?.toLowerCase();
}

function refHasIdentity(ref: SpentFixtureRef): boolean {
  return Boolean(
    ref.requestId || ref.vaultId || ref.publicCommitmentHash || ref.outpoint,
  );
}

export type FreshnessReport = {
  format: "qsb-proof-freshness-v1";
  conflicts: string[];
  conflictFreeInSuppliedInventory: boolean;
  inventoryHasExclusionPower: boolean;
  globalFreshness: false;
  inventoryScope: "supplied-rows" | "absent";
  suppliedRowCount: number;
  omissions: string[];
  freshSearch: false;
  substitutesForFreshSearch: false;
  historicalFixturePresentInCheckout: false;
};

export function assessProofFreshness(input: {
  requestId: string;
  vaultId: string;
  publicCommitmentHash: string;
  outpoints: Outpoint[];
  fixtureLabel?: string;
  rows?: Row[];
  spentFixtures?: SpentFixtureRef[];
}): FreshnessReport {
  assertNoCredentialMaterial(input);
  const rows = input.rows;
  const spentFixtures = input.spentFixtures ?? [];
  if (rows) inventoryRows(rows);
  const refs = [
    ...spentFixtures,
    ...(rows ? spentRefsFromInventory(rows) : []),
  ];
  const conflicts: string[] = [];
  const requestId = input.requestId.toLowerCase();
  const vaultId = input.vaultId.toLowerCase();
  const publicCommitmentHash = input.publicCommitmentHash.toLowerCase();
  if (input.fixtureLabel === HISTORICAL_XVERSE_REGTEST_WITHDRAWAL.label)
    conflicts.push(
      `fixture-label:${HISTORICAL_XVERSE_REGTEST_WITHDRAWAL.label}`,
    );
  for (const ref of refs) {
    if (
      ref.label === HISTORICAL_XVERSE_REGTEST_WITHDRAWAL.label &&
      input.fixtureLabel === ref.label
    )
      conflicts.push(`fixture-label:${ref.label}`);
    const refRequestId = comparableIdentity(ref.requestId);
    const refVaultId = comparableIdentity(ref.vaultId);
    const refCommitment = comparableIdentity(ref.publicCommitmentHash);
    if (refRequestId && refRequestId === requestId)
      conflicts.push(`request:${refRequestId}`);
    if (refVaultId && refVaultId === vaultId)
      conflicts.push(`vault:${refVaultId}`);
    if (refCommitment && refCommitment === publicCommitmentHash)
      conflicts.push(`commitment:${refCommitment}`);
    if (!ref.outpoint) continue;
    for (const point of input.outpoints) {
      if (sameOutpoint(ref.outpoint, point))
        conflicts.push(
          `outpoint:${normalizeOutpoint(point).txid}:${point.vout}`,
        );
    }
  }
  const uniqueConflicts = [...new Set(conflicts)];
  const inventoryHasExclusionPower =
    (rows !== undefined && rows.length > 0) ||
    spentFixtures.some(refHasIdentity);
  return {
    format: "qsb-proof-freshness-v1",
    conflicts: uniqueConflicts,
    conflictFreeInSuppliedInventory: uniqueConflicts.length === 0,
    inventoryHasExclusionPower,
    globalFreshness: false,
    inventoryScope: rows ? "supplied-rows" : "absent",
    suppliedRowCount: rows?.length ?? 0,
    omissions: [
      "Rows absent from this snapshot are not inventoried. A partial public exclusion list is not global freshness proof.",
      "The historical Xverse regtest withdrawal is spent and is not in this checkout. This check does not know its outpoints unless the operator supplies them.",
      NOT_A_FRESH_SEARCH,
    ],
    freshSearch: false,
    substitutesForFreshSearch: false,
    historicalFixturePresentInCheckout: false,
  };
}

/** Public request scaffold. The browser request, funding, and search are still operator and user steps. */
export function scaffoldDisposableProofRequest(input: {
  requestId: string;
  vaultId: string;
  publicCommitmentHash: string;
  amountSats: string;
  feeSats: string;
  outpoints?: Outpoint[];
  outputs: ProofOutput[];
  fixtureLabel?: string;
  rows?: Row[];
  spentFixtures?: SpentFixtureRef[];
}): DisposableProofRequest {
  const parsed = scaffoldInputSchema.parse({
    requestId: input.requestId,
    vaultId: input.vaultId,
    publicCommitmentHash: input.publicCommitmentHash,
    amountSats: input.amountSats,
    feeSats: input.feeSats,
    outputs: input.outputs,
    ...(input.outpoints ? { outpoints: input.outpoints } : {}),
    ...(input.fixtureLabel ? { fixtureLabel: input.fixtureLabel } : {}),
  });
  assertUniqueOutpoints(parsed.outpoints);
  const freshness = assessProofFreshness({
    requestId: parsed.requestId,
    vaultId: parsed.vaultId,
    publicCommitmentHash: parsed.publicCommitmentHash,
    outpoints: parsed.outpoints,
    fixtureLabel: parsed.fixtureLabel,
    rows: input.rows,
    spentFixtures: input.spentFixtures,
  });
  if (!freshness.conflictFreeInSuppliedInventory)
    throw new Error(
      `HistoricalFixtureRestartRefused:${freshness.conflicts.join(",")}`,
    );
  if (!freshness.inventoryHasExclusionPower)
    throw new Error("InventoryHasNoExclusionPower");
  assertWithdrawalAmount(parsed.amountSats, parsed.outputs);
  return disposableRequestSchema.parse({
    format: "qsb-disposable-proof-request-v1",
    chain: "regtest",
    requestId: parsed.requestId,
    vaultId: parsed.vaultId,
    publicCommitmentHash: parsed.publicCommitmentHash,
    amountSats: parsed.amountSats,
    feeSats: parsed.feeSats,
    outpoints: parsed.outpoints.map(normalizeOutpoint),
    outputs: parsed.outputs,
    historicalFixture: false,
    restartsHistoricalFixture: false,
    freshSearchPerformed: false,
    browserGenerated: false,
    awaitingBrowserRequest: true,
    globalFreshness: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
  });
}

export function classifySearchEvidence(kind: SearchEvidenceKind): {
  kind: SearchEvidenceKind;
  substitutesForFreshSearch: false;
  freshOptimizedWithdrawal: false;
  reason: string;
} {
  switch (kind) {
    case "not-run":
      return {
        kind,
        substitutesForFreshSearch: false,
        freshOptimizedWithdrawal: false,
        reason: "No search was run.",
      };
    case "known-solution-replay":
      return {
        kind,
        substitutesForFreshSearch: false,
        freshOptimizedWithdrawal: false,
        reason: "Known-solution replay is not a fresh search.",
      };
    case "synthetic-no-hit":
      return {
        kind,
        substitutesForFreshSearch: false,
        freshOptimizedWithdrawal: false,
        reason: "A synthetic no-hit range is not a fresh search.",
      };
    case "mocked-success":
      return {
        kind,
        substitutesForFreshSearch: false,
        freshOptimizedWithdrawal: false,
        reason: "Mocked success is not a fresh search.",
      };
    default: {
      const neverKind: never = kind;
      throw new Error(`Unhandled search evidence: ${String(neverKind)}`);
    }
  }
}

function assertSearchEvidence(kind: string): SearchEvidenceKind {
  switch (kind) {
    case "not-run":
    case "known-solution-replay":
    case "synthetic-no-hit":
    case "mocked-success":
      return kind;
    default:
      throw new Error("FreshSearchCannotBeClaimedHere");
  }
}

const bundleOutputSchema = proofOutputSchema;

const bundleInputSchema = outpointSchema.extend({ valueSats: sats }).strict();

const signingBundleSchema = z
  .object({
    format: z.literal("qsb-disposable-proof-signing-bundle-v1"),
    chain: z.literal("regtest"),
    vaultId: z.string().uuid(),
    requestId: z.string().uuid(),
    requestHash: hash64,
    bundleHash: hash64,
    inputs: z.array(bundleInputSchema).min(1).max(8),
    outputs: z.array(bundleOutputSchema).min(1).max(8),
    amountSats: sats,
    feeSats: sats,
    searchEvidence: z.enum([
      "not-run",
      "known-solution-replay",
      "synthetic-no-hit",
      "mocked-success",
    ]),
    substitutesForFreshSearch: z.literal(false),
    freshSearch: z.literal(false),
    cpuVerified: z.literal(false),
    coreValidated: z.literal(false),
    xverseSigned: z.literal(false),
    mainnetEnabled: z.literal(false),
    broadcastAuthorized: z.literal(false),
  })
  .strict();

export type DisposableSigningBundle = z.infer<typeof signingBundleSchema>;

function sumSats(values: string[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

function assertWithdrawalAmount(
  amountSats: string,
  outputs: { role: "withdrawal" | "change"; valueSats: string }[],
): void {
  const withdrawals = outputs.filter((output) => output.role === "withdrawal");
  if (withdrawals.length !== 1 || withdrawals[0]?.valueSats !== amountSats)
    throw new Error("BindingMismatch");
}

function assertSameOutputs(
  committed: readonly ProofOutput[],
  presented: readonly ProofOutput[],
): void {
  if (committed.length !== presented.length) throw new Error("BindingMismatch");
  for (const [index, output] of presented.entries()) {
    const expected = committed[index];
    if (
      !expected ||
      output.role !== expected.role ||
      output.scriptHex !== expected.scriptHex ||
      output.valueSats !== expected.valueSats
    )
      throw new Error("BindingMismatch");
  }
}

function assertAmountFeeBinding(
  amountSats: string,
  feeSats: string,
  inputs: { valueSats: string }[],
  outputs: { role: "withdrawal" | "change"; valueSats: string }[],
): void {
  assertWithdrawalAmount(amountSats, outputs);
  const fee =
    sumSats(inputs.map((input) => input.valueSats)) -
    sumSats(outputs.map((output) => output.valueSats));
  if (fee !== BigInt(feeSats) || fee <= 0n) throw new Error("BindingMismatch");
}

/**
 * Public signing bundle bound to the vault, request, inputs, outputs, amount, and fee.
 * It contains no backup, passphrase, or signature.
 */
export function exportDisposableSigningBundle(input: {
  request: DisposableProofRequest;
  inputs: { txid: string; vout: number; valueSats: string }[];
  outputs: {
    role: "withdrawal" | "change";
    scriptHex: string;
    valueSats: string;
  }[];
  searchEvidence: string;
}): DisposableSigningBundle {
  assertNoCredentialMaterial(input);
  const request = disposableRequestSchema.parse(input.request);
  const evidence = assertSearchEvidence(input.searchEvidence);
  classifySearchEvidence(evidence);
  if (request.outpoints.length === 0 || input.inputs.length === 0)
    throw new Error("BindingMismatch");
  const requestPoints = request.outpoints.map(normalizeOutpoint);
  const inputs = input.inputs.map((item) => ({
    ...normalizeOutpoint(item),
    valueSats: item.valueSats,
  }));
  assertSameOutpointMultiset(requestPoints, inputs);
  const outputs = input.outputs.map((output) => ({
    ...output,
    scriptHex: output.scriptHex.toLowerCase(),
  }));
  assertSameOutputs(request.outputs, outputs);
  assertAmountFeeBinding(request.amountSats, request.feeSats, inputs, outputs);
  const body = {
    format: "qsb-disposable-proof-signing-bundle-v1" as const,
    chain: "regtest" as const,
    vaultId: request.vaultId,
    requestId: request.requestId,
    requestHash: fingerprint(request),
    inputs,
    outputs,
    amountSats: request.amountSats,
    feeSats: request.feeSats,
    searchEvidence: evidence,
    substitutesForFreshSearch: false as const,
    freshSearch: false as const,
    cpuVerified: false as const,
    coreValidated: false as const,
    xverseSigned: false as const,
    mainnetEnabled: false as const,
    broadcastAuthorized: false as const,
  };
  return signingBundleSchema.parse({ ...body, bundleHash: fingerprint(body) });
}

export function parseDisposableSigningBundle(
  value: unknown,
  request: DisposableProofRequest,
): DisposableSigningBundle {
  assertNoCredentialMaterial(value);
  const bundle = signingBundleSchema.parse(value);
  const { bundleHash, ...body } = bundle;
  if (bundleHash !== fingerprint(body)) throw new Error("BindingMismatch");
  const bound = disposableRequestSchema.parse(request);
  if (
    bundle.requestHash !== fingerprint(bound) ||
    bundle.vaultId !== bound.vaultId ||
    bundle.requestId !== bound.requestId ||
    bundle.amountSats !== bound.amountSats ||
    bundle.feeSats !== bound.feeSats
  )
    throw new Error("BindingMismatch");
  assertSameOutpointMultiset(bound.outpoints, bundle.inputs);
  assertSameOutputs(bound.outputs, bundle.outputs);
  assertAmountFeeBinding(
    bundle.amountSats,
    bundle.feeSats,
    bundle.inputs,
    bundle.outputs,
  );
  classifySearchEvidence(bundle.searchEvidence);
  return bundle;
}

const siblingSchema = z
  .object({
    jobId: z.string().min(1).max(128),
    slot: z.number().int().min(0).max(31),
    state: z.enum([
      "claimed",
      "launching",
      "uncertain",
      "acknowledged",
      "running",
      "terminal",
    ]),
    outcome: z
      .enum(["process-exit", "verified-hit", "failed", "drained", "cancelled"])
      .optional(),
    providerOutcome: z.enum(["not-submitted", "submitted", "uncertain"]),
    queueStatus: z.enum([
      "IN_QUEUE",
      "IN_PROGRESS",
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMED_OUT",
      "absent",
    ]),
    cpuVerification: z.enum(["not-run", "simulated", "enrolled-cpu-verifier"]),
  })
  .strict();

export type SiblingJob = z.infer<typeof siblingSchema>;

function siblingQueueClear(job: SiblingJob): boolean {
  if (job.state !== "terminal" || !job.outcome) return false;
  if (job.providerOutcome === "uncertain") return false;
  if (job.providerOutcome === "not-submitted")
    return job.queueStatus === "absent";
  switch (job.queueStatus) {
    case "COMPLETED":
    case "FAILED":
    case "CANCELLED":
    case "TIMED_OUT":
      return true;
    case "IN_QUEUE":
    case "IN_PROGRESS":
    case "absent":
      return false;
    default: {
      const neverStatus: never = job.queueStatus;
      throw new Error(`Unhandled queue status: ${String(neverStatus)}`);
    }
  }
}

export type SiblingDrainReport = {
  format: "qsb-sibling-drain-reconciliation-v1";
  queueDrained: boolean;
  allTerminal: boolean;
  independentCpuVerificationOfFreshSearch: false;
  aggregateIgnored: boolean;
  freshSearch: false;
  substitutesForFreshSearch: false;
  reasons: string[];
  limits: readonly string[];
};

const expectedSiblingSchema = z
  .object({
    jobId: z.string().min(1).max(128),
    slot: z.number().int().min(0).max(31),
  })
  .strict();

/** Per-job sibling reconciliation. Aggregate counters are recorded and ignored. */
export function reconcileSiblingDrain(
  jobs: SiblingJob[],
  aggregate?: {
    active?: number;
    completed?: number;
    expected?: { jobId: string; slot: number }[];
  },
): SiblingDrainReport {
  assertNoCredentialMaterial({ jobs, aggregate });
  const parsed = z.array(siblingSchema).min(0).max(32).parse(jobs);
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const job of parsed) {
    const key = `${job.jobId}:${job.slot}`;
    if (seen.has(key)) throw new Error("SiblingSetInvalid");
    seen.add(key);
  }
  if (parsed.length === 0) reasons.push("No sibling records were supplied.");
  if (!parsed.some((job) => job.slot > 0))
    reasons.push("Sibling set has no non-primary slot.");
  const allTerminal =
    parsed.length > 0 &&
    parsed.every(
      (job) => job.state === "terminal" && job.outcome !== undefined,
    );
  if (!allTerminal && parsed.length > 0)
    reasons.push("A sibling job is not terminal.");
  const queueClear = parsed.length > 0 && parsed.every(siblingQueueClear);
  if (parsed.some((job) => job.providerOutcome === "uncertain"))
    reasons.push("A provider outcome is uncertain.");
  if (
    parsed.some(
      (job) =>
        job.queueStatus === "IN_QUEUE" || job.queueStatus === "IN_PROGRESS",
    )
  )
    reasons.push("A provider queue entry is still active.");
  if (!queueClear && parsed.length > 0 && allTerminal)
    reasons.push("A sibling provider queue is not reconciled.");
  if (parsed.some((job) => job.cpuVerification === "simulated"))
    reasons.push(
      "Simulated CPU verification is not independent verification of a fresh search.",
    );
  let expectedSetMatches = false;
  if (!aggregate?.expected) {
    reasons.push("No authoritative expected sibling set was supplied.");
  } else {
    const expected = z
      .array(expectedSiblingSchema)
      .min(1)
      .max(32)
      .parse(aggregate.expected);
    const expectedKeys = new Set<string>();
    for (const item of expected) {
      const key = `${item.jobId}:${item.slot}`;
      if (expectedKeys.has(key)) throw new Error("SiblingSetInvalid");
      expectedKeys.add(key);
    }
    const suppliedKeys = new Set(
      parsed.map((job) => `${job.jobId}:${job.slot}`),
    );
    if (
      expectedKeys.size !== suppliedKeys.size ||
      [...expectedKeys].some((key) => !suppliedKeys.has(key))
    )
      reasons.push(
        "The supplied sibling records do not match the expected job and slot set.",
      );
    else expectedSetMatches = true;
  }
  const blocking = reasons.filter((reason) => !reason.startsWith("Simulated"));
  const queueDrained =
    expectedSetMatches &&
    queueClear &&
    parsed.some((job) => job.slot > 0) &&
    blocking.length === 0;
  if (aggregate)
    reasons.push(
      "Aggregate provider counters are not per-job drain or completion evidence.",
    );
  return {
    format: "qsb-sibling-drain-reconciliation-v1",
    queueDrained,
    allTerminal,
    independentCpuVerificationOfFreshSearch: false,
    aggregateIgnored: aggregate !== undefined,
    freshSearch: false,
    substitutesForFreshSearch: false,
    reasons,
    limits: [
      "Aggregate provider counters are not per-job drain or completion evidence.",
      NOT_A_FRESH_SEARCH,
      "An enrolled CPU verification record in this report is not a fresh optimized search.",
    ],
  };
}

const boundedComputeSchema = z
  .object({
    explicitlyAuthorized: z.literal(true),
    minIdleWorkers: z.literal(0),
    maxCostUnits: sats,
    deadline: z.string().datetime(),
    workerId: z.string().min(1).max(128),
    cleanupWatchdogs: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            independentOfWorker: z.literal(true),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();

export type BoundedComputePlan = {
  format: "qsb-bounded-compute-plan-v1";
  planAccepted: true;
  provisioned: false;
  liveComputeStarted: false;
  authorizesMainnetBroadcast: false;
  freshSearch: false;
  mainnetEnabled: false;
  broadcastAuthorized: false;
  maxCostUnits: string;
  deadline: string;
  minIdleWorkers: 0;
  watchdogIds: string[];
};

/** Checks a compute plan. This checkout does not provision workers. */
export function assessBoundedCompute(
  input: unknown,
  now: Date = new Date(),
): BoundedComputePlan {
  assertNoCredentialMaterial(input);
  const parsed = boundedComputeSchema.safeParse(input);
  if (!parsed.success) throw new Error("BoundedComputeRefused");
  const deadline = Date.parse(parsed.data.deadline);
  if (!Number.isFinite(deadline) || deadline <= now.getTime())
    throw new Error("BoundedComputeDeadlineExpired");
  const ids = parsed.data.cleanupWatchdogs.map((watchdog) => watchdog.id);
  if (new Set(ids).size !== ids.length || ids.includes(parsed.data.workerId))
    throw new Error("BoundedComputeRefused");
  return {
    format: "qsb-bounded-compute-plan-v1",
    planAccepted: true,
    provisioned: false,
    liveComputeStarted: false,
    authorizesMainnetBroadcast: false,
    freshSearch: false,
    mainnetEnabled: false,
    broadcastAuthorized: false,
    maxCostUnits: parsed.data.maxCostUnits,
    deadline: parsed.data.deadline,
    minIdleWorkers: 0,
    watchdogIds: ids,
  };
}

export type CoreJudgment = {
  format: "qsb-core-validation-judgment-v1";
  harnessRan: boolean;
  chain: "regtest" | null;
  fullProductionWithdrawalVerified: false;
  freshOptimizedWithdrawal: false;
  section6Closed: false;
  puzzleRelaxedSpend: boolean;
  overclaim: boolean;
  reason: string;
  limits: readonly string[];
};

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

/** Classifies a Core harness report. The judgment cannot close section 6. */
export function judgeCoreReport(value: unknown): CoreJudgment {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CoreReportRejected");
  assertNoCredentialMaterial(value);
  const report = value as Record<string, unknown>;
  const network = report.network;
  const chain = network === "regtest" ? "regtest" : null;
  const tests = Array.isArray(report.tests) ? report.tests : [];
  const testNames = tests.map((test) => {
    const name = record(test)?.name;
    return typeof name === "string" ? name : "";
  });
  const puzzleFromTests = tests.reduce((total, test) => {
    return total + numberValue(record(test)?.puzzleChecksBypassed);
  }, 0);
  const puzzleChecksBypassed = Math.max(
    numberValue(report.puzzleChecksBypassed),
    puzzleFromTests,
  );
  const puzzleRelaxedSpend =
    puzzleChecksBypassed > 0 ||
    testNames.some((name) => name.includes("PUZZLE-RELAXED"));
  const overclaim =
    report.fullProductionWithdrawalVerified === true ||
    report.freshOptimizedWithdrawal === true ||
    report.section6Closed === true ||
    network === "mainnet";
  const harnessRan = report.harnessRan === true;
  let reason: string;
  if (overclaim)
    reason =
      "The report claims a fresh optimized withdrawal, a closed section 6, or a mainnet Core result. That claim is refused.";
  else if (!harnessRan)
    reason =
      typeof report.reason === "string"
        ? report.reason
        : "Core harness was not run. This is not a Core validation.";
  else if (network !== "regtest")
    reason = "Core validation for this controlled proof must be regtest.";
  else if (puzzleRelaxedSpend)
    reason =
      "Puzzle-relaxed Core acceptance bypasses puzzle checks and is not a fresh optimized withdrawal.";
  else reason = "A Core harness report does not by itself close section 6.";
  return {
    format: "qsb-core-validation-judgment-v1",
    harnessRan,
    chain,
    fullProductionWithdrawalVerified: false,
    freshOptimizedWithdrawal: false,
    section6Closed: false,
    puzzleRelaxedSpend,
    overclaim,
    reason,
    limits: [
      NOT_A_FRESH_SEARCH,
      "Local regtest acceptance is not external miner inclusion.",
    ],
  };
}

const coreBinaryEnrollmentSchema = z
  .object({
    format: z.literal("qsb-core-binary-enrollment-v1"),
    bitcoindSha256: hash64.nullable(),
    bitcoinCliSha256: hash64.nullable(),
    enrolled: z.boolean(),
  })
  .strict()
  .refine(
    (value) => {
      const both =
        value.bitcoindSha256 !== null && value.bitcoinCliSha256 !== null;
      const neither =
        value.bitcoindSha256 === null && value.bitcoinCliSha256 === null;
      return (both || neither) && value.enrolled === both;
    },
    { message: "Core binary enrollment is inconsistent" },
  );

export type CoreBinaryEnrollment = z.infer<typeof coreBinaryEnrollmentSchema>;

/** Checkout enrollment file shared with scripts/test-core.sh. */
export function coreBinaryEnrollmentPath(): string {
  return fileURLToPath(new URL("./core-binary.json", import.meta.url));
}

function assertCommittedCoreBinaryBytes(bytes: Buffer): void {
  const manifest = readCommittedManifest(checkoutRoot());
  const expected =
    manifest.identities.sourceFiles["server/runtime/core-binary.json"];
  if (typeof expected !== "string" || sha256Hex(bytes) !== expected)
    throw new Error("CoreBinaryEnrollmentRejected");
}

export function loadCoreBinaryEnrollment(
  filePath: string = coreBinaryEnrollmentPath(),
): CoreBinaryEnrollment {
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch {
    throw new Error("CoreBinaryEnrollmentRejected");
  }
  if (path.resolve(filePath) === path.resolve(coreBinaryEnrollmentPath()))
    assertCommittedCoreBinaryBytes(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("CoreBinaryEnrollmentRejected");
  }
  const parsed = coreBinaryEnrollmentSchema.safeParse(raw);
  if (!parsed.success) throw new Error("CoreBinaryEnrollmentRejected");
  return parsed.data;
}

function requireEnrolledCoreBinaries(
  value: unknown,
  enrollment: CoreBinaryEnrollment,
): void {
  if (
    !enrollment.enrolled ||
    enrollment.bitcoindSha256 === null ||
    enrollment.bitcoinCliSha256 === null
  )
    throw new Error("CoreBinaryNotEnrolled");
  const binaries = record(record(value)?.coreBinaries);
  if (
    binaries?.bitcoindSha256 !== enrollment.bitcoindSha256 ||
    binaries?.bitcoinCliSha256 !== enrollment.bitcoinCliSha256
  )
    throw new Error("CoreBinaryMismatch");
}

/**
 * Compares a report with an enrollment record already in memory.
 * Public admission does not accept a caller-selected file.
 */
export function assessCoreReportEnrollment(
  value: unknown,
  enrollment: CoreBinaryEnrollment,
): CoreJudgment {
  const judgment = judgeCoreReport(value);
  if (judgment.overclaim) throw new Error("CoreReportOverclaimsSection6");
  if (!judgment.harnessRan) return judgment;
  if (judgment.chain !== "regtest")
    throw new Error("ControlledProofChainMustBeRegtest");
  requireEnrolledCoreBinaries(value, enrollment);
  requireAdmittedHarnessChecks(value);
  return judgment;
}

const coreTxidSchema = z.string().regex(/^[a-f0-9]{64}$/i);

/** The five checks `tests/core_regtest.py` records, in that order. */
const admittedHarnessReportSchema = z
  .object({
    harnessRan: z.literal(true),
    core: z.string().min(1),
    network: z.literal("regtest"),
    coreBinaries: z
      .object({
        bitcoindSha256: hash64,
        bitcoinCliSha256: hash64,
      })
      .strict(),
    tests: z.tuple([
      z
        .object({
          name: z.literal("unmodified-production-lock-funding"),
          passed: z.literal(true),
          scriptBytes: z.number().int().positive(),
          scriptSha256: hash64,
          txid: coreTxidSchema,
        })
        .strict(),
      z
        .object({
          name: z.literal("unsolved-production-withdrawal-rejected"),
          passed: z.literal(true),
          reason: z.string().min(1),
        })
        .strict(),
      z
        .object({
          name: z.literal("zero-output-transaction-rejected"),
          passed: z.literal(true),
          reason: z.string().min(1),
        })
        .strict(),
      z
        .object({
          name: z.literal("structural-destination-amount-tamper-rejected"),
          passed: z.literal(true),
          reason: z.string().min(1),
        })
        .strict(),
      z
        .object({
          name: z.literal("PUZZLE-RELAXED-structural-spend"),
          passed: z.literal(true),
          puzzleChecksBypassed: z.literal(3),
          txid: coreTxidSchema,
        })
        .strict(),
    ]),
    puzzleChecksBypassed: z.literal(3),
    fullProductionWithdrawalVerified: z.literal(false),
    freshOptimizedWithdrawal: z.literal(false),
    section6Closed: z.literal(false),
    puzzleRelaxedIsNotFreshSearch: z.literal(true),
    knownSolutionReplayIsNotFreshSearch: z.literal(true),
    syntheticNoHitIsNotFreshSearch: z.literal(true),
    mockedSuccessIsNotFreshSearch: z.literal(true),
  })
  .strict();

function requireAdmittedHarnessChecks(value: unknown): void {
  const parsed = admittedHarnessReportSchema.safeParse(value);
  if (!parsed.success) throw new Error("CoreHarnessChecksRejected");
  const [funding, unsolved, zeroOutput, tamper, spend] = parsed.data.tests;
  if (funding.txid.toLowerCase() === spend.txid.toLowerCase())
    throw new Error("CoreHarnessChecksRejected");
  if (!unsolved.reason.toLowerCase().includes("script"))
    throw new Error("CoreHarnessChecksRejected");
  if (!zeroOutput.reason.includes("vout-empty"))
    throw new Error("CoreHarnessChecksRejected");
  if (!tamper.reason.toLowerCase().includes("script"))
    throw new Error("CoreHarnessChecksRejected");
}

/** Always loads the committed `server/runtime/core-binary.json` shared with the shell harness. */
export function admitCoreHarnessResult(value: unknown): CoreJudgment {
  return assessCoreReportEnrollment(value, loadCoreBinaryEnrollment());
}
