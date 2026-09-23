import { expect, it, vi } from "vitest";
import { followValidationExecution } from "../scripts/validation-status";
const expected = { owner: "regtest:fixture", jobId: "proof", revision: 0 };
const input = JSON.stringify(expected);
const prefix = "arn:aws:states:eu-west-1:123:execution:QsbVaultWithdrawal:";
it("reports the running child instead of the succeeded original execution", async () => {
  const describe = vi.fn(async (arn: string) =>
    arn.endsWith("parent")
      ? {
          status: "SUCCEEDED",
          input,
          output: JSON.stringify({ ExecutionArn: prefix + "child" }),
        }
      : { status: "RUNNING", input },
  );
  expect(
    await followValidationExecution(prefix + "parent", expected, describe),
  ).toMatchObject({
    executionArn: prefix + "child",
    status: "RUNNING",
    continuations: 1,
  });
  expect(describe).toHaveBeenCalledTimes(2);
});
it("reports a failed child and accepts a genuine terminal execution without continuation", async () => {
  const describe = vi.fn(async () => ({ status: "FAILED", input }));
  expect(
    await followValidationExecution(prefix + "child", expected, describe),
  ).toMatchObject({ status: "FAILED" });
  const done = async () => ({
    status: "SUCCEEDED",
    input,
    output: JSON.stringify({ done: true }),
  });
  expect(
    await followValidationExecution(prefix + "child", expected, done),
  ).toMatchObject({ status: "SUCCEEDED", continuations: 0 });
});
it("rejects cross-run and cyclic continuation chains", async () => {
  await expect(
    followValidationExecution(prefix + "first", expected, async () => ({
      status: "RUNNING",
      input: JSON.stringify({ ...expected, jobId: "other" }),
    })),
  ).rejects.toThrow("does not match");
  await expect(
    followValidationExecution(prefix + "first", expected, async () => ({
      status: "SUCCEEDED",
      input,
      output: JSON.stringify({ ExecutionArn: prefix + "first" }),
    })),
  ).rejects.toThrow("Invalid workflow");
  await expect(
    followValidationExecution(prefix + "first", expected, async () => ({
      status: "SUCCEEDED",
      input,
      output: JSON.stringify({ ExecutionArn: "arn:other" }),
    })),
  ).rejects.toThrow("Invalid workflow");
});
