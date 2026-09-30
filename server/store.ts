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
export interface Store {
  get(pk: string, sk: string): Promise<Row | undefined>;
  /** `signal` cancels the request; a write it cancels may or may not have been applied. */
  put(row: Row, expected?: number, options?: { signal?: AbortSignal }): Promise<void>;
  delete(pk: string, sk: string, expected: number): Promise<void>;
  list(pk: string, prefix: string): Promise<Row[]>;
  reservationRows(): Promise<Row[]>;
  atomicPut(writes: AtomicWrite[]): Promise<void>;
}
export type AtomicWrite = {
  row: Row;
  expected?: number;
  /** Check the row's version without writing it. */
  conditionOnly?: boolean;
  /** Remove the row in the same transaction. This is TransactWriteItems, not DeleteItem. */
  remove?: boolean;
};

export function isReservationRow(row: Row): boolean {
  return row.sk === "RESERVATION" && row.pk.startsWith("OUTPOINT#");
}

function transactItem(
  table: string,
  { row, expected, conditionOnly, remove }: AtomicWrite,
): NonNullable<TransactWriteCommandInput["TransactItems"]>[number] {
  const version = {
    ConditionExpression: "#v = :v",
    ExpressionAttributeNames: { "#v": "version" },
    ExpressionAttributeValues: { ":v": expected ?? row.version },
  };
  if (remove)
    return { Delete: { TableName: table, Key: { pk: row.pk, sk: row.sk }, ...version } };
  if (conditionOnly)
    return { ConditionCheck: { TableName: table, Key: { pk: row.pk, sk: row.sk }, ...version } };
  return {
    Put: {
      TableName: table,
      Item: row,
      ...(expected === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : version),
    },
  };
}
export class Conflict extends Error {}

/**
 * A new job's reservation rows: one per outpoint, keyed by its lowercase txid. Each is
 * written with attribute_not_exists(pk), so a second job for the same outpoint conflicts.
 * A reservation an older writer stored under a mixed-case txid must be resolved first.
 */
export async function canonicalReservationWrites(
  store: Store,
  reservations: { owner: string; jobId: string; txid: string; vout: number }[],
): Promise<AtomicWrite[]> {
  for (const point of reservations) {
    if (point.txid === point.txid.toLowerCase()) continue;
    const legacy = await store.get(
      `OUTPOINT#${point.txid}:${point.vout}`,
      "RESERVATION",
    );
    if (legacy) throw new Conflict("ReservationAliasUnresolved");
  }
  return reservations.map((point) => ({
    row: {
      pk: `OUTPOINT#${point.txid.toLowerCase()}:${point.vout}`,
      sk: "RESERVATION",
      version: 0,
      owner: point.owner,
      jobId: point.jobId,
    },
  }));
}

export class MemoryStore implements Store {
  readonly rows = new Map<string, Row>();
  async atomicPut(writes: AtomicWrite[]) {
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
        throw new Conflict("Input reserved or concurrent update");
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
  async put(row: Row, expected?: number, _options?: { signal?: AbortSignal }) {
    const k = `${row.pk}|${row.sk}`,
      old = this.rows.get(k);
    if (expected === undefined ? old !== undefined : old?.version !== expected)
      throw new Conflict("Concurrent update");
    this.rows.set(k, structuredClone(row));
  }
  async delete(pk: string, sk: string, expected: number) {
    const k = `${pk}|${sk}`;
    const current = this.rows.get(k);
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
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: writes.map((write) => transactItem(this.table, write)),
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
      throw new Conflict("Input reserved or concurrent update");
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
  async put(row: Row, expected?: number, options: { signal?: AbortSignal } = {}) {
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
        options.signal ? { abortSignal: options.signal } : {},
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
