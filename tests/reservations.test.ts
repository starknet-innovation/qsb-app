import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient, type TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { canonicalReservationWrites, Conflict, DynamoStore, MemoryStore } from "../server/store";

const txid = (byte: string) => byte.repeat(32);
afterEach(() => vi.restoreAllMocks());

// Job creation reserves the funding and helper outpoints in the same transaction as the job.
describe("outpoint reservations", () => {
  it("keys each outpoint by its lowercase txid and writes only the reservation", async () => {
    const writes = await canonicalReservationWrites(new MemoryStore(), [
      { owner: "a", jobId: "j1", txid: txid("AB"), vout: 0 },
      { owner: "a", jobId: "j1", txid: txid("cd"), vout: 1 },
    ]);
    expect(writes).toEqual([
      { row: { pk: `OUTPOINT#${txid("ab")}:0`, sk: "RESERVATION", version: 0, owner: "a", jobId: "j1" } },
      { row: { pk: `OUTPOINT#${txid("cd")}:1`, sk: "RESERVATION", version: 0, owner: "a", jobId: "j1" } },
    ]);
  });

  it("admits distinct outpoints at once and refuses a second job for the same one", async () => {
    const store = new MemoryStore();
    const first = await canonicalReservationWrites(store, [{ owner: "a", jobId: "j1", txid: txid("55"), vout: 0 }]);
    const second = await canonicalReservationWrites(store, [{ owner: "b", jobId: "j2", txid: txid("66"), vout: 1 }]);
    await Promise.all([store.atomicPut(first), store.atomicPut(second)]);
    expect(await store.get(`OUTPOINT#${txid("55")}:0`, "RESERVATION")).toMatchObject({ owner: "a", jobId: "j1" });
    expect(await store.get(`OUTPOINT#${txid("66")}:1`, "RESERVATION")).toMatchObject({ owner: "b", jobId: "j2" });
    // The same outpoint named with an uppercase txid is the same reservation.
    const duplicate = await canonicalReservationWrites(store, [
      { owner: "c", jobId: "j3", txid: txid("55").toUpperCase(), vout: 0 },
    ]);
    await expect(store.atomicPut(duplicate)).rejects.toThrow(Conflict);
    expect(await store.get(`OUTPOINT#${txid("55")}:0`, "RESERVATION")).toMatchObject({ jobId: "j1" });
  });

  it("refuses an outpoint an older writer reserved under a mixed-case txid", async () => {
    const store = new MemoryStore();
    const mixed = txid("aB");
    await store.put({ pk: `OUTPOINT#${mixed}:0`, sk: "RESERVATION", version: 0, owner: "a", jobId: "old" });
    await expect(
      canonicalReservationWrites(store, [{ owner: "b", jobId: "new", txid: mixed, vout: 0 }]),
    ).rejects.toThrow("ReservationAliasUnresolved");
  });

  it("sends DynamoDB each write with its condition and nothing else", async () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({} as never);
    const store = new DynamoStore("records");
    const reservations = await canonicalReservationWrites(store, [
      { owner: "a", jobId: "j1", txid: txid("ab"), vout: 0 },
    ]);
    const updated = { pk: "OWNER#a", sk: "JOB#j0", version: 2 };
    const removed = { pk: "OWNER#a", sk: "INTENT#x", version: 5 };
    await store.atomicPut([
      { row: { pk: "OWNER#a", sk: "JOB#j1", version: 0 } },
      { row: { pk: "OWNER#a", sk: "VAULT#v", version: 3 }, expected: 3, conditionOnly: true },
      { row: updated, expected: 1 },
      { row: removed, remove: true },
      ...reservations,
    ]);
    // A lowercase txid needs no alias lookup: the only request is the transaction.
    expect(send).toHaveBeenCalledTimes(1);
    const version = (v: number) => ({
      ConditionExpression: "#v = :v",
      ExpressionAttributeNames: { "#v": "version" },
      ExpressionAttributeValues: { ":v": v },
    });
    expect((send.mock.calls[0][0] as TransactWriteCommand).input.TransactItems).toEqual([
      { Put: { TableName: "records", Item: { pk: "OWNER#a", sk: "JOB#j1", version: 0 }, ConditionExpression: "attribute_not_exists(pk)" } },
      { ConditionCheck: { TableName: "records", Key: { pk: "OWNER#a", sk: "VAULT#v" }, ...version(3) } },
      { Put: { TableName: "records", Item: updated, ...version(1) } },
      { Delete: { TableName: "records", Key: { pk: "OWNER#a", sk: "INTENT#x" }, ...version(5) } },
      { Put: { TableName: "records", Item: reservations[0]!.row, ConditionExpression: "attribute_not_exists(pk)" } },
    ]);
  });
});
