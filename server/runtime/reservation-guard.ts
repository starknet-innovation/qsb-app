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
      kind: "delete";
      pk: string;
      sk: string;
      expectedVersion: number;
    }
  | {
      kind: "authority-absent";
      pk: typeof AUTHORITY_PK;
      sk: typeof AUTHORITY_SK;
      condition: "attribute_not_exists(pk)";
    }
  | {
      kind: "authority-generation";
      pk: typeof AUTHORITY_PK;
      sk: typeof AUTHORITY_SK;
      condition: "generation";
      expectedVersion: number;
      generation: number;
    }
  | {
      kind: "authority-reconciling";
      pk: typeof AUTHORITY_PK;
      sk: typeof AUTHORITY_SK;
      condition: "reconciling";
      expectedVersion: number;
      generation: number;
    }
  | {
      kind: "version-condition";
      pk: string;
      sk: string;
      expectedVersion: number;
    };

function acceptancePermanentlyStopped(existing: Row | undefined): boolean {
  return (
    existing?.acceptanceStopped === true || existing?.rollbackScope === "local-dry-run"
  );
}

/** Reservation batches that do not write the authority row condition on its absence, so authority creation conflicts with them. */
export function dynamoReservationTransaction(
  writes: {
    row: Row;
    expected?: number;
    conditionOnly?: boolean;
    remove?: boolean;
  }[],
): DynamoTransactStep[] {
  const steps: DynamoTransactStep[] = writes.map(({ row, expected, conditionOnly, remove }) => {
    if (remove)
      return {
        kind: "delete" as const,
        pk: row.pk,
        sk: row.sk,
        expectedVersion: expected ?? row.version,
      };
    if (conditionOnly && isAuthorityRow(row)) {
      const generation = typeof row.generation === "number" ? row.generation : -1;
      const expectedVersion = expected ?? row.version;
      if (row.canonicalAccepting === false)
        return {
          kind: "authority-reconciling" as const,
          pk: AUTHORITY_PK,
          sk: AUTHORITY_SK,
          condition: "reconciling" as const,
          expectedVersion,
          generation,
        };
      return {
        kind: "authority-generation" as const,
        pk: AUTHORITY_PK,
        sk: AUTHORITY_SK,
        condition: "generation" as const,
        expectedVersion,
        generation,
      };
    }
    if (conditionOnly)
      return {
        kind: "version-condition" as const,
        pk: row.pk,
        sk: row.sk,
        expectedVersion: expected ?? row.version,
      };
    return {
      kind: "put" as const,
      pk: row.pk,
      sk: row.sk,
      condition:
        expected === undefined
          ? ("attribute_not_exists(pk)" as const)
          : ("version" as const),
      ...(expected === undefined ? {} : { expectedVersion: expected }),
    };
  });
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
  if (
    existing?.canonicalAccepting === false &&
    acceptancePermanentlyStopped(existing) &&
    row.canonicalAccepting !== false
  )
    return "RollbackWouldReviveWriters";
  if (existing?.acceptanceStopped === true && row.acceptanceStopped !== true)
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
  writes: {
    row: Row;
    expected?: number;
    conditionOnly?: boolean;
    aliasMigration?: boolean;
  }[],
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
  if (existingAuthority.canonicalAccepting !== true) {
    if (acceptancePermanentlyStopped(existingAuthority))
      return "ReservationAuthorityStopped";
    const migrating =
      reservations.length > 0 && reservations.every((write) => write.aliasMigration === true);
    const holdsFence = writes.some(
      (write) =>
        isAuthorityRow(write.row) &&
        write.conditionOnly === true &&
        write.expected === existingAuthority.version &&
        write.row.legacyExcluded === true &&
        write.row.canonicalAccepting === false &&
        write.row.generation === existingAuthority.generation,
    );
    if (migrating && holdsFence) return undefined;
    return "ReservationAuthorityStopped";
  }
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
