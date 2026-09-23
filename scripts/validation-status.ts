/** Follow the exact Step Functions continuation chain; never infer success from
 * a completed parent execution while its child still owns the durable job. */
export type ExecutionSnapshot = {
  executionArn?: string;
  status?: string;
  input?: string;
  output?: string;
};
export async function followValidationExecution(
  firstArn: string,
  expected: { owner: string; jobId: string; revision: number },
  describe: (arn: string) => Promise<ExecutionSnapshot>,
) {
  const seen = new Set<string>();
  let arn = firstArn;
  const prefix = firstArn.slice(0, firstArn.lastIndexOf(":") + 1);
  for (let depth = 0; depth < 256; depth++) {
    if (seen.has(arn) || !arn.startsWith(prefix))
      throw Error("Invalid workflow continuation chain");
    seen.add(arn);
    const execution = await describe(arn);
    const input = JSON.parse(execution.input || "{}");
    if (
      input.owner !== expected.owner ||
      input.jobId !== expected.jobId ||
      input.revision !== expected.revision
    )
      throw Error("Workflow continuation does not match this validation run");
    if (execution.status !== "SUCCEEDED")
      return { ...execution, executionArn: arn, continuations: depth };
    const output = JSON.parse(execution.output || "{}");
    const next = output.ExecutionArn ?? output.executionArn;
    if (typeof next !== "string")
      return { ...execution, executionArn: arn, continuations: depth };
    arn = next;
  }
  throw Error("Workflow continuation chain exceeds inspection limit");
}
