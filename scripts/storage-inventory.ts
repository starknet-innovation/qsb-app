import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertNoCredentialMaterial } from "../server/runtime/host-requirements";
import { inventoryRows } from "../server/runtime/storage-authority";
import type { Row } from "../server/store";

export function inventorySnapshot(parsed: unknown) {
  assertNoCredentialMaterial(parsed);
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { rows?: unknown }).rows)
      ? (parsed as { rows: Row[] }).rows
      : undefined;
  if (!rows) throw new Error("Snapshot has no rows");
  return inventoryRows(rows);
}

function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write("Usage: npm run inventory:storage -- snapshot.json\n");
    process.exitCode = 1;
    return;
  }
  const report = inventorySnapshot(JSON.parse(readFileSync(file, "utf8")));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
