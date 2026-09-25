import { afterEach, describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Conflict, DynamoStore } from "../server/store";

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
