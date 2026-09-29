import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Conflict, DynamoStore } from "../server/store";
import { recordOwnerEvents } from "../server/owner-events";

const writes = [{ row: { pk: "OWNER#test", sk: "JOB#test", version: 0 } }];
afterEach(() => vi.restoreAllMocks());
function fail(
  codes?: (string | undefined)[],
  name = "TransactionCanceledException",
) {
  const error = Object.assign(new Error("original service failure"), {
    name,
    CancellationReasons: codes?.map((Code) => ({ Code })),
  });
  vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockRejectedValue(error);
  return error;
}
describe("DynamoDB cancellation classification", () => {
  it.each([
    [["ConditionalCheckFailed", "None"]],
    [["ConditionalCheckFailed", "ConditionalCheckFailed"]],
    [["None", "TransactionConflict"]],
  ])("maps a refused transaction that carries an event row to Conflict: %j", async (codes) => {
    const failure = Object.assign(new Error("original service failure"), {
      name: "TransactionCanceledException",
      CancellationReasons: codes.map((Code) => ({ Code })),
    });
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockRejectedValue(failure);
    const store = recordOwnerEvents(new DynamoStore("test"));
    const job = { pk: "OWNER#test", sk: "JOB#test", version: 1, job: { id: "test", status: "queued", stage: "pinning" } };
    await expect(store.atomicPut([{ row: job, expected: 0 }])).rejects.toBeInstanceOf(Conflict);
    const items = (send.mock.calls[0][0] as { input: { TransactItems: { Put?: { Item: { sk: string } } }[] } }).input.TransactItems;
    expect(items.map((item) => item.Put?.Item.sk.split("#")[0])).toEqual(["JOB", "EVENT"]);
  });
  it("passes a put's cancel signal to the request", async () => {
    const send = vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockResolvedValue({} as never);
    const signal = new AbortController().signal;
    await new DynamoStore("test").put({ pk: "OWNER#test", sk: "EVENT#x", version: 0 }, undefined, { signal });
    expect(send.mock.calls[0][1]).toEqual({ abortSignal: signal });
  });

  it.each([
    ["ConditionalCheckFailed"],
    ["TransactionConflict"],
    ["None", "ConditionalCheckFailed"],
  ])("maps only concurrency cancellations: %j", async (...codes) => {
    fail(codes);
    await expect(
      new DynamoStore("test").atomicPut(writes),
    ).rejects.toBeInstanceOf(Conflict);
  });
  it.each([
    undefined,
    [],
    ["None"],
    [undefined],
    ["ValidationError"],
    ["ThrottlingError"],
    ["ItemCollectionSizeLimitExceeded"],
    ["ProvisionedThroughputExceeded"],
    ["AccessDenied"],
    ["FutureReason"],
    ["ConditionalCheckFailed", "ValidationError"],
    ["TransactionConflict", "ThrottlingError"],
  ])("preserves the original non-concurrency error: %j", async (codes) => {
    const error = fail(codes);
    await expect(new DynamoStore("test").atomicPut(writes)).rejects.toBe(error);
  });
  it("preserves a non-cancellation exception even with conflict metadata", async () => {
    const error = fail(["ConditionalCheckFailed"], "AccessDeniedException");
    await expect(new DynamoStore("test").atomicPut(writes)).rejects.toBe(error);
  });
});
