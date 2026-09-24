import type { Row } from "../store";

export const AUTHORITY_PK = "SYSTEM#RESERVATION_AUTHORITY";
export const AUTHORITY_SK = "GENERATION";

export function isReservationRow(row: Row): boolean {
  return row.sk === "RESERVATION" && row.pk.startsWith("OUTPOINT#");
}

/** Delete must fail when the authority row is excluded, even if the version matches. */
export function authorityDeleteAllowed(
  existing: Row | undefined,
  expectedVersion: number,
): boolean {
  if (!existing || existing.version !== expectedVersion) return false;
  return existing.legacyExcluded !== true;
}

export function dynamoAuthorityDeleteCondition(expectedVersion: number): {
  ConditionExpression: string;
  ExpressionAttributeNames: { "#v": "version"; "#excluded": "legacyExcluded" };
  ExpressionAttributeValues: { ":v": number; ":false": false };
} {
  return {
    ConditionExpression:
      "#v = :v AND (attribute_not_exists(#excluded) OR #excluded = :false)",
    ExpressionAttributeNames: { "#v": "version", "#excluded": "legacyExcluded" },
    ExpressionAttributeValues: { ":v": expectedVersion, ":false": false },
  };
}

export function isAuthorityRow(row: Row): boolean {
  return row.pk === AUTHORITY_PK && row.sk === AUTHORITY_SK;
}

export type DynamoTransactStep =
  | {
      kind: "put";
      pk: string;
      sk: string;
      condition: "attribute_not_exists(pk)" | "version";
      expectedVersion?: number;
    }
  | {
      kind: "authority-absent";
      pk: typeof AUTHORITY_PK;
      sk: typeof AUTHORITY_SK;
      condition: "attribute_not_exists(pk)";
    };

/** Reservation batches that do not write the authority row condition on its absence, so authority creation conflicts with them. */
export function dynamoReservationTransaction(
  writes: { row: Row; expected?: number }[],
): DynamoTransactStep[] {
  const steps: DynamoTransactStep[] = writes.map(({ row, expected }) => ({
    kind: "put",
    pk: row.pk,
    sk: row.sk,
    condition: expected === undefined ? "attribute_not_exists(pk)" : "version",
    ...(expected === undefined ? {} : { expectedVersion: expected }),
  }));
  if (
    writes.some((write) => isReservationRow(write.row)) &&
    !writes.some((write) => isAuthorityRow(write.row))
  ) {
    steps.push({
      kind: "authority-absent",
      pk: AUTHORITY_PK,
      sk: AUTHORITY_SK,
      condition: "attribute_not_exists(pk)",
    });
  }
  return steps;
}

export function authorityMutationRejection(
  existing: Row | undefined,
  row: Row,
): string | undefined {
  if (!isAuthorityRow(row)) return undefined;
  if (row.expiresAt !== undefined) return "AuthorityMustNotExpire";
  if (row.productionEnforcement !== false) return "ProductionEnforcementRefused";
  if (row.mainnetEnabled === true || row.broadcastAuthorized === true)
    return "ProductionEnforcementRefused";
  if (existing?.legacyExcluded === true && row.legacyExcluded !== true)
    return "RollbackWouldReviveWriters";
  if (existing?.canonicalAccepting === false && row.canonicalAccepting !== false)
    return "RollbackWouldReviveWriters";
  if (
    existing?.legacyExcluded === true &&
    row.generation !== existing.generation
  )
    return "AuthorityGenerationImmutable";
  if (row.legacyExcluded === true) {
    if (row.control !== "store-transaction-condition")
      return "InsufficientWriterExclusion";
    if (row.canonicalAccepting !== true && row.canonicalAccepting !== false)
      return "InsufficientWriterExclusion";
  }
  return undefined;
}

/**
 * In-process reservation fence. A frontend flag, capability marker, or paused
 * workflow cannot satisfy it. An already deployed binary is outside this fence.
 */
export function reservationBatchRejection(
  existingAuthority: Row | undefined,
  writes: { row: Row; expected?: number }[],
): string | undefined {
  for (const { row } of writes) {
    const authorityRejection = authorityMutationRejection(existingAuthority, row);
    if (authorityRejection) return authorityRejection;
  }
  const reservations = writes.filter((write) => isReservationRow(write.row));
  if (!reservations.length) return undefined;
  const enablesExclusion = writes.some(
    (write) => isAuthorityRow(write.row) && write.row.legacyExcluded === true,
  );
  if (existingAuthority?.legacyExcluded !== true) {
    if (enablesExclusion) return "LegacyWriterExcluded";
    return undefined;
  }
  if (existingAuthority.canonicalAccepting !== true)
    return "ReservationAuthorityStopped";
  const generation = existingAuthority.generation;
  if (typeof generation !== "number") return "LegacyWriterExcluded";
  const stamped = reservations.every(
    (write) => write.row.authorityGeneration === generation,
  );
  const conditioned = writes.some(
    (write) =>
      isAuthorityRow(write.row) &&
      write.expected === existingAuthority.version &&
      write.row.legacyExcluded === true &&
      write.row.generation === generation &&
      write.row.canonicalAccepting === true &&
      write.row.productionEnforcement === false,
  );
  if (!stamped || !conditioned) return "LegacyWriterExcluded";
  return undefined;
}
