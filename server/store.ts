import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  AUTHORITY_PK,
  AUTHORITY_SK,
  authorityDeleteAllowed,
  dynamoAuthorityDeleteCondition,
  dynamoReservationTransaction,
  isAuthorityRow,
  isReservationRow,
  reservationBatchRejection,
  type DynamoTransactStep,
} from "./runtime/reservation-guard";
export type Row = {
  pk: string;
  sk: string;
  version: number;
  expiresAt?: number;
  [key: string]: unknown;
};
export interface Store {
  get(pk: string, sk: string): Promise<Row | undefined>;
  put(row: Row, expected?: number): Promise<void>;
  delete(pk: string, sk: string, expected: number): Promise<void>;
  list(pk: string, prefix: string): Promise<Row[]>;
  reservationRows(): Promise<Row[]>;
  atomicPut(writes: AtomicWrite[]): Promise<void>;
}
export type AtomicWrite = {
  row: Row;
  expected?: number;
  /** Check the row without writing it. Used for the reservation authority fence. */
  conditionOnly?: boolean;
  /** Remove the row in the same transaction. This is TransactWriteItems, not DeleteItem. */
  remove?: boolean;
  /** Rewrite an existing mixed-case reservation while canonical acceptance is still off. */
  aliasMigration?: boolean;
};

function transactItem(
  table: string,
  step: DynamoTransactStep,
  writes: AtomicWrite[],
): NonNullable<TransactWriteCommandInput["TransactItems"]>[number] {
  switch (step.kind) {
    case "put":
      return {
        Put: {
          TableName: table,
          Item: writes.find(
            (write) =>
              write.row.pk === step.pk && write.row.sk === step.sk && write.remove !== true,
          )!.row,
          ConditionExpression:
            step.condition === "attribute_not_exists(pk)"
              ? "attribute_not_exists(pk)"
              : "#v = :v",
          ...(step.condition === "version"
            ? {
                ExpressionAttributeNames: { "#v": "version" },
                ExpressionAttributeValues: { ":v": step.expectedVersion },
              }
            : {}),
        },
      };
    case "delete":
      return {
        Delete: {
          TableName: table,
          Key: { pk: step.pk, sk: step.sk },
          ConditionExpression: "#v = :v",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":v": step.expectedVersion },
        },
      };
    case "authority-generation":
      return {
        ConditionCheck: {
          TableName: table,
          Key: { pk: step.pk, sk: step.sk },
          ConditionExpression:
            "#v = :v AND #excluded = :true AND #generation = :generation AND #accepting = :true AND #enforcement = :false",
          ExpressionAttributeNames: {
            "#v": "version",
            "#excluded": "legacyExcluded",
            "#generation": "generation",
            "#accepting": "canonicalAccepting",
            "#enforcement": "productionEnforcement",
          },
          ExpressionAttributeValues: {
            ":v": step.expectedVersion,
            ":true": true,
            ":generation": step.generation,
            ":false": false,
          },
        },
      };
    case "authority-reconciling":
      return {
        ConditionCheck: {
          TableName: table,
          Key: { pk: step.pk, sk: step.sk },
          ConditionExpression:
            "#v = :v AND #excluded = :true AND #generation = :generation AND #accepting = :false AND #enforcement = :false",
          ExpressionAttributeNames: {
            "#v": "version",
            "#excluded": "legacyExcluded",
            "#generation": "generation",
            "#accepting": "canonicalAccepting",
            "#enforcement": "productionEnforcement",
          },
          ExpressionAttributeValues: {
            ":v": step.expectedVersion,
            ":true": true,
            ":generation": step.generation,
            ":false": false,
          },
        },
      };
    case "authority-absent":
      return {
        ConditionCheck: {
          TableName: table,
          Key: { pk: step.pk, sk: step.sk },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      };
    case "version-condition":
      return {
        ConditionCheck: {
          TableName: table,
          Key: { pk: step.pk, sk: step.sk },
          ConditionExpression: "#v = :v",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":v": step.expectedVersion },
        },
      };
    default: {
      const neverStep: never = step;
      throw new Error(`Unhandled transaction step: ${String(neverStep)}`);
    }
  }
}
export class Conflict extends Error {}

function rejectGuarded(existing: Row | undefined, writes: AtomicWrite[]) {
  const rejection = reservationBatchRejection(existing, writes);
  if (rejection) throw new Conflict(rejection);
}

export class MemoryStore implements Store {
  readonly rows = new Map<string, Row>();
  private authority(): Row | undefined {
    const row = this.rows.get(`${AUTHORITY_PK}|${AUTHORITY_SK}`);
    if (row?.expiresAt && row.expiresAt < Date.now() / 1000) return;
    return row;
  }
  async atomicPut(writes: AtomicWrite[]) {
    rejectGuarded(this.authority(), writes);
    const seen = new Set<string>();
    for (const { row, expected, conditionOnly, remove } of writes) {
      const key = `${row.pk}|${row.sk}`,
        old = this.rows.get(key);
      if (remove) {
        if (seen.has(key) || old?.version !== (expected ?? row.version))
          throw new Conflict("Concurrent update");
        seen.add(key);
        continue;
      }
      if (
        !conditionOnly &&
        (seen.has(key) ||
          (expected === undefined ? old !== undefined : old?.version !== expected))
      )
        throw new Conflict("Input reserved or concurrent update");
      if (conditionOnly && old?.version !== expected)
        throw new Conflict("ReservationAuthorityStopped");
      if (!conditionOnly) seen.add(key);
    }
    for (const { row, conditionOnly, remove } of writes) {
      const key = `${row.pk}|${row.sk}`;
      if (remove) this.rows.delete(key);
      else if (!conditionOnly) this.rows.set(key, structuredClone(row));
    }
  }
  async get(pk: string, sk: string) {
    const r = this.rows.get(`${pk}|${sk}`);
    if (r?.expiresAt && r.expiresAt < Date.now() / 1000) return;
    return r ? structuredClone(r) : undefined;
  }
  async put(row: Row, expected?: number) {
    if (isReservationRow(row) || isAuthorityRow(row))
      rejectGuarded(this.authority(), [{ row, expected }]);
    const k = `${row.pk}|${row.sk}`,
      old = this.rows.get(k);
    if (expected === undefined ? old !== undefined : old?.version !== expected)
      throw new Conflict("Concurrent update");
    this.rows.set(k, structuredClone(row));
  }
  async delete(pk: string, sk: string, expected: number) {
    const k = `${pk}|${sk}`;
    const current = this.rows.get(k);
    if (
      pk === AUTHORITY_PK &&
      sk === AUTHORITY_SK &&
      current &&
      !authorityDeleteAllowed(current, expected) &&
      current.legacyExcluded === true
    )
      throw new Conflict("RollbackWouldReviveWriters");
    if (current?.version !== expected) throw new Conflict("Concurrent update");
    this.rows.delete(k);
  }
  async list(pk: string, prefix: string) {
    return [...this.rows.values()]
      .filter((r) => r.pk === pk && r.sk.startsWith(prefix))
      .map((r) => structuredClone(r));
  }
  async reservationRows(): Promise<Row[]> {
    return [...this.rows.values()]
      .filter(isReservationRow)
      .map((row) => structuredClone(row));
  }
}
export class DynamoStore implements Store {
  private client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env.AWS_REGION }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  constructor(private table: string) {}
  async atomicPut(writes: AtomicWrite[]) {
    if (
      writes.some((write) => isReservationRow(write.row) || isAuthorityRow(write.row))
    )
      rejectGuarded(await this.get(AUTHORITY_PK, AUTHORITY_SK), writes);
    const steps = dynamoReservationTransaction(writes);
    const authorityCheck = steps.find((step) => step.kind === "authority-absent");
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: steps.map((step) => transactItem(this.table, step, writes)),
        }),
      );
    } catch (e) {
      const reasons = (
        e as { CancellationReasons?: { Code?: string }[] }
      ).CancellationReasons;
      // Do not disguise authorization, capacity, validation or unknown failures as
      // optimistic concurrency. A mixed cancellation must preserve its real error.
      const conflictCodes = new Set([
        "ConditionalCheckFailed",
        "TransactionConflict",
      ]);
      if (
        (e as Error).name !== "TransactionCanceledException" ||
        !reasons?.some((reason) => conflictCodes.has(reason.Code ?? "")) ||
        reasons.some(
          (reason) =>
            reason.Code !== "None" && !conflictCodes.has(reason.Code ?? ""),
        )
      )
        throw e;
      const authorityIndex = steps.findIndex(
        (step) =>
          step.kind === "authority-absent" ||
          step.kind === "authority-generation" ||
          step.kind === "authority-reconciling",
      );
      const authorityKind = steps[authorityIndex]?.kind;
      if (
        authorityCheck &&
        authorityKind === "authority-absent" &&
        (e as Error).name === "TransactionCanceledException" &&
        reasons?.[authorityIndex]?.Code === "ConditionalCheckFailed"
      )
        throw new Conflict("LegacyWriterExcluded");
      if (
        (authorityKind === "authority-generation" ||
          authorityKind === "authority-reconciling") &&
        (e as Error).name === "TransactionCanceledException" &&
        reasons?.[authorityIndex]?.Code === "ConditionalCheckFailed"
      )
        throw new Conflict("ReservationAuthorityStopped");
      if ((e as Error).name === "TransactionCanceledException")
        throw new Conflict("Input reserved or concurrent update");
      throw e;
    }
  }
  async get(pk: string, sk: string) {
    const r = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk, sk },
        ConsistentRead: true,
      }),
    );
    const item = r.Item as Row | undefined;
    if (item?.expiresAt && item.expiresAt < Date.now() / 1000) return;
    return item;
  }
  async put(row: Row, expected?: number) {
    if (isReservationRow(row)) {
      await this.atomicPut([{ row, expected }]);
      return;
    }
    if (isAuthorityRow(row))
      rejectGuarded(await this.get(AUTHORITY_PK, AUTHORITY_SK), [
        { row, expected },
      ]);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: row,
          ConditionExpression:
            expected === undefined ? "attribute_not_exists(pk)" : "#v = :v",
          ...(expected === undefined
            ? {}
            : {
                ExpressionAttributeNames: { "#v": "version" },
                ExpressionAttributeValues: { ":v": expected },
              }),
        }),
      );
    } catch (e) {
      if ((e as Error).name === "ConditionalCheckFailedException")
        throw new Conflict("Concurrent update");
      throw e;
    }
  }
  async delete(pk: string, sk: string, expected: number) {
    const authorityKey = pk === AUTHORITY_PK && sk === AUTHORITY_SK;
    const observed = authorityKey ? await this.get(pk, sk) : undefined;
    const condition = authorityKey
      ? dynamoAuthorityDeleteCondition(expected)
      : {
          ConditionExpression: "#v = :v",
          ExpressionAttributeNames: { "#v": "version" as const },
          ExpressionAttributeValues: { ":v": expected },
        };
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { pk, sk },
          ConditionExpression: condition.ConditionExpression,
          ExpressionAttributeNames: condition.ExpressionAttributeNames,
          ExpressionAttributeValues: condition.ExpressionAttributeValues,
        }),
      );
    } catch (e) {
      if ((e as Error).name === "ConditionalCheckFailedException") {
        const after = authorityKey ? await this.get(pk, sk) : undefined;
        const excluded =
          observed?.legacyExcluded === true || after?.legacyExcluded === true;
        throw new Conflict(
          excluded ? "RollbackWouldReviveWriters" : "Concurrent update",
        );
      }
      throw e;
    }
  }
  async list(pk: string, prefix: string) {
    const rows: Row[] = [];
    let start: Record<string, any> | undefined;
    do {
      const r = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
          ExclusiveStartKey: start,
          ConsistentRead: true,
        }),
      );
      rows.push(...(r.Items as Row[]));
      start = r.LastEvaluatedKey;
    } while (start);
    return rows;
  }
  async reservationRows(): Promise<Row[]> {
    const rows: Row[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "sk = :sk AND begins_with(pk, :prefix)",
          ExpressionAttributeValues: { ":sk": "RESERVATION", ":prefix": "OUTPOINT#" },
          ExclusiveStartKey: start,
          ConsistentRead: true,
        }),
      );
      rows.push(...((page.Items ?? []) as Row[]));
      start = page.LastEvaluatedKey;
    } while (start);
    return rows.filter(isReservationRow);
  }
}
export const store: Store = process.env.TABLE_NAME
  ? new DynamoStore(process.env.TABLE_NAME)
  : new MemoryStore();
