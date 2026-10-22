import { pathToFileURL } from "node:url";

/** Import-safe preflight: no store import before the environment is right. */
export function scriptBackfillEnvironmentError(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.TABLE_NAME?.trim()) return "TableNameRequired";
  if (!env.AWS_REGION?.trim()) return "AwsRegionRequired";
  if (env.QSB_NETWORK !== "mainnet") return "MainnetEnvironmentRequired";
}

/** Reports what it would reserve; writes only with `--apply`. Exits non-zero on a duplicate or unreadable row. */
export async function runScriptBackfillCli(args: string[]): Promise<void> {
  const reason =
    scriptBackfillEnvironmentError(process.env) ??
    (args.length > 1 || (args.length === 1 && args[0] !== "--apply") ? "InvalidOptions" : undefined);
  if (reason) {
    process.stderr.write(`${JSON.stringify({ action: "refuse", reason })}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const [{ DynamoStore }, { backfillScriptReservations }] = await Promise.all([
      import("../server/store"),
      import("../server/script-reservations"),
    ]);
    const store = new DynamoStore(process.env.TABLE_NAME!);
    const result = await backfillScriptReservations(store, await store.vaultRows(), args[0] === "--apply");
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.duplicates.length || result.unreadable.length) process.exitCode = 1;
  } catch {
    // Never log SDK error payloads, table contents or credentials.
    process.stderr.write(`${JSON.stringify({ action: "refuse", reason: "ScriptBackfillFailed" })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runScriptBackfillCli(process.argv.slice(2));
