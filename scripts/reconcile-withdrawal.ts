import { pathToFileURL } from "node:url";

/** Import-safe preflight. No secret values or raw transactions are CLI arguments. */
export function withdrawalReconciliationEnvironmentError(
  env: NodeJS.ProcessEnv,
) {
  if (env.QSB_NETWORK !== "mainnet") return "MainnetEnvironmentRequired";
  if (!env.TABLE_NAME?.trim()) return "TableNameRequired";
  if (!env.AWS_REGION?.trim()) return "AwsRegionRequired";
}
export async function runWithdrawalReconciliationCli(
  args: string[],
): Promise<void> {
  try {
    const reason = withdrawalReconciliationEnvironmentError(process.env);
    if (reason) throw Error(reason);
    const [owner, jobId, ...flags] = args,
      options: Record<string, string> = {};
    if (
      !owner ||
      !jobId ||
      !/^\S{1,200}$/.test(owner) ||
      !/^\S{1,200}$/.test(jobId)
    )
      throw Error("OwnerAndJobRequired");
    for (let i = 0; i < flags.length; i += 2) {
      const key = flags[i],
        value = flags[i + 1];
      if (
        !["--operator", "--evidence"].includes(key) ||
        !value ||
        key in options
      )
        throw Error("InvalidOptions");
      options[key] = value;
    }
    if (!options["--operator"] || !options["--evidence"])
      throw Error("OperatorAndEvidenceRequired");
    const [{ store }, { chain }, { Slipstream }, { reconcileWithdrawal }] =
      await Promise.all([
        import("../server/store"),
        import("../server/chain"),
        import("../server/providers"),
        import("../server/withdrawal-reconciliation"),
      ]);
    const result = await reconcileWithdrawal({
      store,
      chain,
      miner: new Slipstream(),
      owner,
      jobId,
      operator: options["--operator"],
      evidence: options["--evidence"],
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.alert) process.exitCode = 1;
  } catch {
    // Never log provider bodies, environment/credentials, signed bytes or SDK error payloads.
    process.stderr.write(
      JSON.stringify({
        action: "refuse",
        reason: "WithdrawalReconciliationFailed",
      }) + "\n",
    );
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runWithdrawalReconciliationCli(process.argv.slice(2));
