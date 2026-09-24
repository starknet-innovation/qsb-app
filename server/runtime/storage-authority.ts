import { z } from "zod";
import { Conflict, MemoryStore, type AtomicWrite, type Row, type Store } from "../store";
import { assertNoCredentialMaterial } from "./host-requirements";
import {
  AUTHORITY_PK,
  AUTHORITY_SK,
  isAuthorityRow,
  isReservationRow,
} from "./reservation-guard";

export const permissionModel = {
  format: "qsb-permission-model-v1",
  productionIamReviewed: false,
  livePermissionsVerified: false,
  reservationWritesRequireTransaction: true,
  roles: {
    api: {
      data: ["GetItem", "PutItem", "DeleteItem", "Query", "TransactWriteItems"],
      secrets: [],
      evidence: "read-admitted-terminal-evidence",
      mayChangeReservationAuthority: false,
      mayBroadcast: false,
    },
    runtime: {
      data: ["GetItem", "PutItem", "Query", "TransactWriteItems"],
      secrets: ["GetSecretValue"],
      evidence: "write-terminal-evidence",
      mayChangeReservationAuthority: false,
      mayBroadcast: false,
    },
    operator: {
      data: ["GetItem", "Query", "Scan", "TransactWriteItems"],
      secrets: [],
      evidence: "read-terminal-evidence",
      mayChangeReservationAuthority: true,
      mayBroadcast: false,
      maySetMainnetEnabled: false,
      maySetBroadcastAuthorized: false,
    },
  },
} as const;

type PermissionModel = {
  format: string;
  productionIamReviewed: boolean;
  livePermissionsVerified: boolean;
  reservationWritesRequireTransaction: boolean;
  roles: {
    api: RolePermissions;
    runtime: RolePermissions & { evidence: string };
    operator: RolePermissions & {
      maySetMainnetEnabled: boolean;
      maySetBroadcastAuthorized: boolean;
    };
  };
};

type RolePermissions = {
  data: readonly string[];
  secrets: readonly string[];
  evidence: string;
  mayChangeReservationAuthority: boolean;
  mayBroadcast: boolean;
};

export function assertPermissionSeparation(
  model: PermissionModel = permissionModel,
): void {
  const apiSecrets = new Set<string>(model.roles.api.secrets);
  for (const action of model.roles.runtime.secrets) {
    if (apiSecrets.has(action)) throw new Error("ApiRoleMustNotReadRuntimeSecrets");
  }
  if (model.roles.api.evidence === model.roles.runtime.evidence)
    throw new Error("EvidenceAccessMustDiffer");
  if (
    model.roles.api.mayChangeReservationAuthority ||
    model.roles.runtime.mayChangeReservationAuthority ||
    !model.roles.operator.mayChangeReservationAuthority
  )
    throw new Error("OnlyOperatorMayChangeReservationAuthority");
  for (const role of [model.roles.api, model.roles.runtime, model.roles.operator]) {
    if (role.mayBroadcast) throw new Error("BroadcastRefused");
  }
  if (
    model.roles.operator.maySetMainnetEnabled ||
    model.roles.operator.maySetBroadcastAuthorized
  )
    throw new Error("ActivationRefused");
  if (!model.reservationWritesRequireTransaction)
    throw new Error("ReservationTransactionRequired");
  if (model.productionIamReviewed || model.livePermissionsVerified)
    throw new Error("LiveIamNotReviewed");
  if (!model.roles.operator.data.includes("TransactWriteItems"))
    throw new Error("OperatorAuthorityMutationRequiresTransaction");
  if (model.roles.operator.data.includes("PutItem"))
    throw new Error("OperatorPutItemIsNotAuthorityScoped");
}

export type MigrationBackend =
  | "memory-store"
  | "dynamodb-local"
  | "regional-dynamodb";

export function assessMigrationBackend(backend: MigrationBackend): {
  rehearsal: boolean;
  productionCutoverCertified: false;
  iamCertified: false;
  reason: string;
} {
  switch (backend) {
    case "memory-store":
      return {
        rehearsal: true,
        productionCutoverCertified: false,
        iamCertified: false,
        reason: "MemoryStore rehearsal only. This does not certify a regional backend.",
      };
    case "dynamodb-local":
      return {
        rehearsal: false,
        productionCutoverCertified: false,
        iamCertified: false,
        reason:
          "DynamoDB Local does not certify IAM behavior or a production cutover.",
      };
    case "regional-dynamodb":
      return {
        rehearsal: false,
        productionCutoverCertified: false,
        iamCertified: false,
        reason:
          "This checkout has no selected regional table or IAM permissions to validate.",
      };
    default: {
      const neverBackend: never = backend;
      throw new Error(`Unhandled migration backend: ${neverBackend}`);
    }
  }
}

const exclusionControlSchema = z.enum([
  "store-transaction-condition",
  "frontend-flag",
  "capability-marker",
  "paused-workflow",
]);
export type ExclusionControl = z.infer<typeof exclusionControlSchema>;

export async function enableInProcessWriterExclusion(
  store: Store,
  control: ExclusionControl,
): Promise<Row> {
  if (control !== "store-transaction-condition")
    throw new Error("InsufficientWriterExclusion");
  const existing = await store.get(AUTHORITY_PK, AUTHORITY_SK);
  if (existing?.legacyExcluded === true && existing.canonicalAccepting === true)
    return existing;
  if (existing) throw new Error("AuthorityGenerationConflict");
  const row: Row = {
    pk: AUTHORITY_PK,
    sk: AUTHORITY_SK,
    version: 0,
    format: "qsb-reservation-authority-v1",
    generation: 1,
    legacyExcluded: true,
    canonicalAccepting: true,
    productionEnforcement: false,
    control,
    mainnetEnabled: false,
    broadcastAuthorized: false,
  };
  await store.atomicPut([{ row }]);
  return row;
}

export async function rollbackCanonicalAcceptance(store: Store): Promise<Row> {
  const existing = await store.get(AUTHORITY_PK, AUTHORITY_SK);
  if (!existing || existing.legacyExcluded !== true)
    throw new Error("RollbackWouldReviveWriters");
  const next: Row = {
    ...existing,
    version: existing.version + 1,
    canonicalAccepting: false,
    legacyExcluded: true,
    productionEnforcement: false,
    awsLegacyWriterDenied: false,
    rollbackScope: "local-dry-run",
    mainnetEnabled: false,
    broadcastAuthorized: false,
  };
  await store.atomicPut([{ row: next, expected: existing.version }]);
  return next;
}

/** In-process rollback never applies an AWS IAM deny to a deployed legacy writer. */
export function localRollbackCoverage(): {
  scope: "local-dry-run";
  deniesLegacyWriterInAws: false;
  reason: string;
} {
  return {
    scope: "local-dry-run",
    deniesLegacyWriterInAws: false,
    reason:
      "This rehearsal stops canonical acceptance in this process. It does not deny dynamodb:PutItem or dynamodb:TransactWriteItems for a deployed legacy writer.",
  };
}

export async function canonicalReservationWrites(
  store: Store,
  reservations: { owner: string; jobId: string; txid: string; vout: number }[],
): Promise<AtomicWrite[]> {
  const authority = await store.get(AUTHORITY_PK, AUTHORITY_SK);
  if (authority?.legacyExcluded === true && authority.canonicalAccepting !== true)
    throw new Conflict("ReservationAuthorityStopped");
  const stamped = authority?.legacyExcluded === true;
  const writes: AtomicWrite[] = reservations.map((point) => ({
    row: {
      pk: `OUTPOINT#${point.txid.toLowerCase()}:${point.vout}`,
      sk: "RESERVATION",
      version: 0,
      owner: point.owner,
      jobId: point.jobId,
      ...(stamped ? { authorityGeneration: authority?.generation } : {}),
    },
  }));
  if (stamped && authority)
    writes.push({
      row: { ...authority },
      expected: authority.version,
      conditionOnly: true,
    });
  return writes;
}

export function inferDrainFromAggregate(_counters: {
  running?: number;
  queued?: number;
}): { drainProven: false; completionProven: false; reason: string } {
  return {
    drainProven: false,
    completionProven: false,
    reason:
      "Aggregate provider counters are not per-job drain or completion evidence.",
  };
}

export type InventoryKind =
  | "reservation"
  | "job"
  | "launch"
  | "provider-identity"
  | "release"
  | "one-time-commitment"
  | "original-request"
  | "completed-coverage"
  | "unknown-submission"
  | "cleanup-history"
  | "authority"
  | "operational"
  | "unclassified";

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function primaryKind(row: Row): InventoryKind {
  if (isAuthorityRow(row)) return "authority";
  if (isReservationRow(row)) return "reservation";
  if (row.sk.startsWith("COMMITMENT#")) return "one-time-commitment";
  if (row.sk.startsWith("REQUEST#")) return "original-request";
  if (row.sk.startsWith("COVERAGE#")) return "completed-coverage";
  if (row.sk.startsWith("CLEANUP#")) return "cleanup-history";
  if (row.sk.startsWith("LAUNCH#")) return "launch";
  if (row.sk.startsWith("JOB#")) return "job";
  if (row.sk.startsWith("RELEASE#")) return "release";
  if (
    row.sk === "AUTH" ||
    row.sk.startsWith("VAULT#") ||
    row.sk.startsWith("TX#") ||
    row.pk.startsWith("CHALLENGE#") ||
    row.pk.startsWith("SESSION#")
  )
    return "operational";
  return "unclassified";
}

function releaseIdentities(row: Row): string[] {
  const ids: string[] = [];
  if (typeof row.releaseId === "string") ids.push(`releaseId:${row.releaseId}`);
  const job = record(row.job);
  const execution = record(job?.execution);
  const profile = record(execution?.profile);
  if (typeof profile?.id === "string") ids.push(`profile:${profile.id}`);
  const solver = record(job?.solver);
  if (solver) {
    const descriptor = record(solver.descriptor);
    if (descriptor) ids.push(`descriptor:${stableJson(descriptor)}`);
    if (typeof solver.releaseHash === "string")
      ids.push(`releaseHash:${solver.releaseHash}`);
    if (typeof solver.id === "string") ids.push(`solver:${solver.id}`);
  }
  if (typeof job?.releaseHash === "string") ids.push(`jobReleaseHash:${job.releaseHash}`);
  return ids;
}

function hasProviderId(job: Record<string, unknown> | undefined): boolean {
  return typeof job?.runpodId === "string" && job.runpodId.length > 0;
}

/** Coordinator saves `searching` with no provider id before the paid submit returns. */
function searchingWithoutProvider(job: Record<string, unknown> | undefined): boolean {
  return job?.status === "searching" && !hasProviderId(job);
}

function pausedUnknownSubmission(job: Record<string, unknown> | undefined): boolean {
  return (
    !hasProviderId(job) &&
    job?.status === "paused" &&
    typeof job.error === "string" &&
    job.error.includes("Submission outcome unknown")
  );
}

/** Validation drain state is stored on the JOB row, not inside `job`. */
function validationState(row: Row): Record<string, unknown> | undefined {
  return record(row.validation) ?? record(record(row.job)?.validation);
}

function completedValidationRanges(validation: Record<string, unknown> | undefined): boolean {
  return typeof validation?.completed === "number" && validation.completed > 0;
}

function providerNotes(row: Row): string[] {
  const notes: string[] = [];
  const launch = record(row.launch);
  const job = record(row.job);
  const validation = validationState(row);
  if (typeof launch?.providerId === "string" || hasProviderId(job))
    notes.push("provider-identity");
  if (
    launch?.providerOutcome === "uncertain" ||
    (typeof job?.error === "string" &&
      job.error.includes("Submission outcome unknown")) ||
    searchingWithoutProvider(job)
  )
    notes.push("unknown-submission");
  if (validation) notes.push("cleanup-history");
  if (releaseIdentities(row).length) notes.push("release");
  if (typeof job?.mainnetRequestHash === "string" || typeof job?.manifestHash === "string")
    notes.push("original-request");
  if (
    job?.coverage === "verified-hit-not-whole-range" ||
    completedValidationRanges(validation)
  )
    notes.push("completed-coverage");
  if (launch?.providerSubmissions !== undefined)
    notes.push(`providerSubmissions:${String(launch.providerSubmissions)}`);
  return notes;
}

export function inventoryRows(
  rows: Row[],
  options: { callerClaimsCompleteExport?: boolean } = {},
) {
  assertNoCredentialMaterial(rows);
  const counts: Record<InventoryKind, number> = {
    reservation: 0,
    job: 0,
    launch: 0,
    "provider-identity": 0,
    release: 0,
    "one-time-commitment": 0,
    "original-request": 0,
    "completed-coverage": 0,
    "unknown-submission": 0,
    "cleanup-history": 0,
    authority: 0,
    operational: 0,
    unclassified: 0,
  };
  const items = rows.map((row) => {
    const kind = primaryKind(row);
    counts[kind] += 1;
    const notes = providerNotes(row);
    if (notes.includes("provider-identity")) counts["provider-identity"] += 1;
    if (notes.includes("unknown-submission")) counts["unknown-submission"] += 1;
    if (notes.includes("release") && kind !== "release") counts.release += 1;
    if (notes.includes("original-request") && kind !== "original-request")
      counts["original-request"] += 1;
    if (notes.includes("completed-coverage") && kind !== "completed-coverage")
      counts["completed-coverage"] += 1;
    if (notes.includes("cleanup-history") && kind !== "cleanup-history")
      counts["cleanup-history"] += 1;
    return { pk: row.pk, sk: row.sk, kind, notes };
  });
  return {
    format: "qsb-storage-inventory-v1" as const,
    scope: "supplied-rows" as const,
    globalFreshness: false as const,
    partialPublicExclusionListIsFreshness: false as const,
    callerClaimIgnored: options.callerClaimsCompleteExport === true,
    suppliedRowCount: rows.length,
    accountedRowCount: items.length,
    counts,
    unclassifiedKeys: items
      .filter((item) => item.kind === "unclassified")
      .map((item) => `${item.pk}|${item.sk}`),
    omissions: [
      "Rows absent from this snapshot are not inventoried. A partial public exclusion list is not global freshness proof.",
      "Operator step: export the selected regional table without secrets and inventory that export. Do not treat this checkout as that export.",
    ],
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const recordValue = value as Record<string, unknown>;
    return `{${Object.keys(recordValue)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(recordValue[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function rowKey(row: Row): string {
  return `${row.pk}|${row.sk}`;
}

function byKey(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [rowKey(row), row]));
}

function isPrefix(before: unknown[], after: unknown[]): boolean {
  if (after.length < before.length) return false;
  return before.every((entry, index) => stableJson(entry) === stableJson(after[index]));
}

export function preservationFailures(before: Row[], after: Row[]): string[] {
  const failures: string[] = [];
  const restored = byKey(after);
  const beforeAuthority = before.find(isAuthorityRow);
  const afterAuthority = after.find(isAuthorityRow);
  if (beforeAuthority?.legacyExcluded === true && afterAuthority?.legacyExcluded !== true)
    failures.push("RollbackWouldReviveWriters");
  for (const row of before) {
    const next = restored.get(rowKey(row));
    if (!next) {
      failures.push(`RowMissing:${rowKey(row)}`);
      continue;
    }
    if (row.sk.startsWith("COMMITMENT#")) {
      if (row.consumed === true && next.consumed !== true)
        failures.push("RollbackWouldReleaseCommitment");
      if (row.requestHash !== next.requestHash)
        failures.push("OriginalRequestChanged");
    }
    if (row.sk.startsWith("REQUEST#")) {
      if (
        row.requestHash !== next.requestHash ||
        stableJson(row.request) !== stableJson(next.request)
      )
        failures.push("OriginalRequestChanged");
    }
    if (row.sk.startsWith("COVERAGE#")) {
      if (row.completed === true && next.completed !== true)
        failures.push("CompletedCoverageDropped");
      if (row.wholeRangeCovered === false && next.wholeRangeCovered !== false)
        failures.push("CoverageWidened");
      if (row.pin !== undefined && row.pin !== next.pin)
        failures.push("CoveragePinChanged");
    }
    if (row.sk.startsWith("CLEANUP#")) {
      const previous = Array.isArray(row.entries) ? row.entries : [];
      const following = Array.isArray(next.entries) ? next.entries : [];
      if (!isPrefix(previous, following)) failures.push("CleanupHistoryShrunk");
    }
    if (isReservationRow(row)) {
      if (row.owner !== next.owner || row.jobId !== next.jobId)
        failures.push("ReservationRebound");
    }
    const launch = record(row.launch);
    const nextLaunch = record(next.launch);
    if (launch) {
      if (!nextLaunch) failures.push("ProviderIdentityDropped");
      else {
        if (
          typeof launch.providerId === "string" &&
          nextLaunch.providerId !== launch.providerId
        )
          failures.push("RollbackWouldDuplicatePaidWork");
        const beforeCount =
          typeof launch.providerSubmissions === "number"
            ? launch.providerSubmissions
            : 0;
        const afterCount =
          typeof nextLaunch.providerSubmissions === "number"
            ? nextLaunch.providerSubmissions
            : 0;
        if (afterCount < beforeCount) failures.push("RollbackWouldDuplicatePaidWork");
        if (
          (launch.providerOutcome === "uncertain" ||
            launch.providerOutcome === "submitted") &&
          nextLaunch.providerOutcome === "not-submitted"
        )
          failures.push("RollbackWouldDuplicatePaidWork");
      }
    }
    const job = record(row.job);
    const nextJob = record(next.job);
    if (job && !nextJob) failures.push("JobPayloadDropped");
    if (job && nextJob) {
      if (job.manifestHash !== undefined && job.manifestHash !== nextJob.manifestHash)
        failures.push("OriginalRequestChanged");
      if (
        job.mainnetRequestHash !== undefined &&
        job.mainnetRequestHash !== nextJob.mainnetRequestHash
      )
        failures.push("OriginalRequestChanged");
      if (job.coverage !== undefined && job.coverage !== nextJob.coverage)
        failures.push("CompletedCoverageDropped");
      if (typeof job.runpodId === "string" && nextJob.runpodId !== job.runpodId)
        failures.push("RollbackWouldDuplicatePaidWork");
      if (
        pausedUnknownSubmission(job) &&
        !pausedUnknownSubmission(nextJob)
      )
        failures.push("RollbackWouldDuplicatePaidWork");
      if (
        searchingWithoutProvider(job) &&
        !searchingWithoutProvider(nextJob) &&
        !pausedUnknownSubmission(nextJob)
      )
        failures.push("RollbackWouldDuplicatePaidWork");
    }
    const beforeCleanup = validationState(row);
    const nextCleanup = validationState(next);
    if (beforeCleanup) {
      if (!nextCleanup) failures.push("CleanupHistoryShrunk");
      else {
        for (const field of ["active", "cancel", "interrupted"] as const) {
          const previous = Array.isArray(beforeCleanup[field])
            ? beforeCleanup[field]
            : [];
          const following = Array.isArray(nextCleanup[field])
            ? nextCleanup[field]
            : [];
          if (!isPrefix(previous, following)) failures.push("CleanupHistoryShrunk");
        }
        const beforeCompleted = beforeCleanup.completed;
        const nextCompleted = nextCleanup.completed;
        if (
          typeof beforeCompleted === "number" &&
          beforeCompleted > 0 &&
          (typeof nextCompleted !== "number" || nextCompleted < beforeCompleted)
        )
          failures.push("CompletedCoverageDropped");
      }
    }
    const evidence = record(launch?.evidence);
    const nextEvidence = record(nextLaunch?.evidence);
    if (evidence && stableJson(evidence) !== stableJson(nextEvidence))
      failures.push("TerminalEvidenceChanged");
    const releaseIds = releaseIdentities(row);
    if (
      releaseIds.length &&
      stableJson(releaseIds) !== stableJson(releaseIdentities(next))
    )
      failures.push("ReleaseIdentityChanged");
    if (primaryKind(row) === "unclassified" && stableJson(row) !== stableJson(next))
      failures.push("UnclassifiedRowChanged");
  }
  return failures;
}

const snapshotSchema = z
  .object({
    format: z.literal("qsb-storage-migration-snapshot-v1"),
    backend: z.enum(["memory-store", "dynamodb-local", "regional-dynamodb"]),
    productionCutover: z.literal(false),
    dynamodbLocalCertifiesIam: z.literal(false),
    globalFreshness: z.literal(false),
    rows: z.array(
      z
        .object({
          pk: z.string().min(1),
          sk: z.string().min(1),
          version: z.number().int().nonnegative(),
        })
        .passthrough(),
    ),
  })
  .strict();

export type MigrationSnapshot = z.infer<typeof snapshotSchema>;

export function exportSnapshot(rows: Row[]): MigrationSnapshot {
  assertNoCredentialMaterial(rows);
  return snapshotSchema.parse({
    format: "qsb-storage-migration-snapshot-v1",
    backend: "memory-store",
    productionCutover: false,
    dynamodbLocalCertifiesIam: false,
    globalFreshness: false,
    rows,
  });
}

export function memoryRows(store: MemoryStore): Row[] {
  return [...store.rows.values()].map((row) => structuredClone(row));
}

export async function importSnapshot(
  store: MemoryStore,
  snapshotInput: MigrationSnapshot,
): Promise<{
  format: "qsb-storage-migration-report-v1";
  backend: "memory-store";
  rehearsal: true;
  productionCutoverCertified: false;
  iamCertified: false;
  globalFreshness: false;
  preserved: true;
  reason: string;
}> {
  const snapshot = snapshotSchema.parse(snapshotInput);
  assertNoCredentialMaterial(snapshot.rows);
  const assessment = assessMigrationBackend(snapshot.backend);
  if (snapshot.backend !== "memory-store") throw new Error(assessment.reason);
  if (store.rows.size !== 0) throw new Error("MigrationTargetNotEmpty");
  const rows = snapshot.rows.map((row) => structuredClone(row) as Row);
  const authority = rows.filter(isAuthorityRow);
  const rest = rows.filter((row) => !isAuthorityRow(row));
  for (const row of rest) await store.put(structuredClone(row));
  for (const row of authority) await store.atomicPut([{ row: structuredClone(row) }]);
  const failures = preservationFailures(rows, memoryRows(store));
  if (failures.length) throw new Error(failures.join(","));
  return {
    format: "qsb-storage-migration-report-v1",
    backend: "memory-store",
    rehearsal: true,
    productionCutoverCertified: false,
    iamCertified: false,
    globalFreshness: false,
    preserved: true,
    reason: assessment.reason,
  };
}

export async function legacyReservationWrite(
  store: Store,
  point: { owner: string; jobId: string; txid: string; vout: number },
): Promise<void> {
  try {
    await store.atomicPut([
      {
        row: {
          pk: `OUTPOINT#${point.txid.toLowerCase()}:${point.vout}`,
          sk: "RESERVATION",
          version: 0,
          owner: point.owner,
          jobId: point.jobId,
        },
      },
    ]);
  } catch (error) {
    if (error instanceof Conflict) throw new Error(error.message);
    throw error;
  }
}
