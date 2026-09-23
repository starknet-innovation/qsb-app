import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
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
  atomicPut(writes: { row: Row; expected?: number }[]): Promise<void>;
}
export class Conflict extends Error {}
export class MemoryStore implements Store {
  readonly rows = new Map<string, Row>();
  async atomicPut(writes: { row: Row; expected?: number }[]) {
    const seen = new Set<string>();
    for (const { row, expected } of writes) {
      const key = `${row.pk}|${row.sk}`,
        old = this.rows.get(key);
      if (
        seen.has(key) ||
        (expected === undefined ? old !== undefined : old?.version !== expected)
      )
        throw new Conflict("Input reserved or concurrent update");
      seen.add(key);
    }
    for (const { row } of writes)
      this.rows.set(`${row.pk}|${row.sk}`, structuredClone(row));
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
}
export class DynamoStore implements Store {
  private client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: process.env.AWS_REGION }),
    { marshallOptions: { removeUndefinedValues: true } },
  );
  constructor(private table: string) {}
  async atomicPut(writes: { row: Row; expected?: number }[]) {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: writes.map(({ row, expected }) => ({
            Put: {
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
            },
          })),
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
}
export const store: Store = process.env.TABLE_NAME
  ? new DynamoStore(process.env.TABLE_NAME)
  : new MemoryStore();
