import { pathToFileURL } from "node:url";
import { reconcileSubmissionCli } from "../server/reconcile-submission";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void reconcileSubmissionCli(process.argv.slice(2));
