import { pathToFileURL } from "node:url";
import { reconciliationEnvironmentError } from "../server/reconciliation-environment";

export async function runReconciliationCli(args: string[]): Promise<void> {
  // Validate before importing network.ts or constructing any SDK/store client.
  const reason = reconciliationEnvironmentError(process.env);
  if (reason) {
    process.stderr.write(`${JSON.stringify({ action: "refuse", reason })}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    const { reconcileSubmissionCli } = await import("../server/reconcile-submission");
    await reconcileSubmissionCli(args);
  } catch {
    process.stderr.write(`${JSON.stringify({ action: "refuse", reason: "ReconciliationInitializationFailed" })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runReconciliationCli(process.argv.slice(2));
