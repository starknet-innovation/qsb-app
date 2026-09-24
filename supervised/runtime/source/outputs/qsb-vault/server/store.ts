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
export type Row = {
  pk: string;
  sk: string;
  version: number;
  expiresAt?: number;
  [key: string]: unknown;
};
export type RuntimeWrite = {
  row: Row;
  expected?: number;
  /** Check the row without writing it. */
  conditionOnly?: boolean;
  remove?: boolean;
  aliasMigration?: boolean;
};
type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
/** conditionOnly is a version ConditionCheck. It is not a Put. */
export function runtimeTransactItems(
  table: string,
  writes: RuntimeWrite[],
): TransactItem[] {
  return writes.map((write) => {
    const { row, expected, conditionOnly, remove } = write;
    const version = expected ?? row.version;
    if (remove)
      return {
        Delete: {
          TableName: table,
          Key: { pk: row.pk, sk: row.sk },
          ConditionExpression: "#v = :v",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":v": version },
        },
      };
    if (conditionOnly)
      return {
        ConditionCheck: {
          TableName: table,
          Key: { pk: row.pk, sk: row.sk },
          ConditionExpression: "#v = :v",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":v": version },
        },
      };
    return {
      Put: {
        TableName: table,
        Item: row,
        ConditionExpression:
          expected === undefined ? "attribute_not_exists(pk)" : "#v = :v",
        ...(expected === undefined
          ? {}
          : {
              ExpressionAttributeNames: { "#v": "version" },
              ExpressionAttributeValues: { ":v": expected },
            }),
      },
    };
  });
}
function isReservationRow(row: Row) {
  return row.sk === "RESERVATION" && row.pk.startsWith("OUTPOINT#");
}
export interface Store {
  get(pk: string, sk: string): Promise<Row | undefined>;
  put(row: Row, expected?: number): Promise<void>;
  delete(pk: string, sk: string, expected: number): Promise<void>;
  list(pk: string, prefix: string): Promise<Row[]>;
  reservationRows(): Promise<Row[]>;
  atomicPut(writes: RuntimeWrite[]): Promise<void>;
}
export class Conflict extends Error {}
export class MemoryStore implements Store {
  readonly rows = new Map<string, Row>();
  async atomicPut(writes: RuntimeWrite[]) {
    const seen = new Set<string>();
    const removed = new Set<string>();
    for (const { row, expected, conditionOnly, remove } of writes) {
      const key = `${row.pk}|${row.sk}`,
        old = this.rows.get(key);
      if (conditionOnly) {
        if (old?.version !== expected)
          throw new Conflict("ReservationAuthorityStopped");
        continue;
      }
      if (remove) {
        if (seen.has(key) || old?.version !== (expected ?? row.version))
          throw new Conflict("Concurrent update");
        seen.add(key);
        removed.add(key);
        continue;
      }
      if (
        seen.has(key) ||
        (expected === undefined ? old !== undefined : old?.version !== expected)
      )
        throw new Conflict("Input reserved or concurrent update");
      seen.add(key);
    }
    for (const { row, conditionOnly } of writes) {
      if (conditionOnly) continue;
      const key = `${row.pk}|${row.sk}`;
      if (removed.has(key)) this.rows.delete(key);
      else this.rows.set(key, structuredClone(row));
    }
  }
  async get(pk: string, sk: string) {
    const r = this.rows.get(`${pk}|${sk}`);
    if (r?.expiresAt && r.expiresAt < Date.now() / 1000) return;
    return r ? structuredClone(r) : undefined;
  }
  async put(row: Row, expected?: number) {
    const k = `${row.pk}|${row.sk}`,
      old = this.rows.get(k);
    if (expected === undefined ? old !== undefined : old?.version !== expected)
      throw new Conflict("Concurrent update");
    this.rows.set(k, structuredClone(row));
  }
  async delete(pk: string, sk: string, expected: number) {
    const k = `${pk}|${sk}`;
    if (this.rows.get(k)?.version !== expected)
      throw new Conflict("Concurrent update");
    this.rows.delete(k);
  }
  async list(pk: string, prefix: string) {
    return [...this.rows.values()]
      .filter((r) => r.pk === pk && r.sk.startsWith(prefix))
      .map((r) => structuredClone(r));
  }
  async reservationRows() {
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
  async atomicPut(writes: RuntimeWrite[]) {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: runtimeTransactItems(this.table, writes),
        }),
      );
    } catch (e) {
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
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { pk, sk },
          ConditionExpression: "#v = :v",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":v": expected },
        }),
      );
    } catch (e) {
      if ((e as Error).name === "ConditionalCheckFailedException")
        throw new Conflict("Concurrent update");
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
  async reservationRows() {
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
