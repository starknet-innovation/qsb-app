import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  BatchWriteItemCommand,
  DynamoDBClient,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

/**
 * Copies the QSB records table from one region to another for the move in docs/REGION-MIGRATION.md.
 *
 * Items are copied as raw DynamoDB attribute values, so nothing is re-marshalled. Both tables are then
 * compared item by item. Run it only while both stacks' mainnet switches are off and nobody is signed
 * in to the new stack. It prints counts per key prefix and a digest, never item contents.
 *
 *   npx tsx scripts/copy-records.ts --from eu-west-1:SOURCE_TABLE --to eu-west-2:DEST_TABLE
 *   npx tsx scripts/copy-records.ts --from eu-west-1:SOURCE_TABLE --to eu-west-2:DEST_TABLE --apply
 *
 * When the tables are in different accounts, name each side's AWS profile with --from-profile and
 * --to-profile. Otherwise both sides use the default credentials.
 *
 * Without --apply it only counts. With --apply it copies and verifies. A re-run after a partial or
 * interrupted copy is safe: destination rows are overwritten by the source rows with the same key, and a
 * destination row whose key isn't in the source stops the copy.
 *
 * Two kinds of row are neither copied nor compared:
 * - sign-in challenges and sessions, since everyone signs in again at the new stack;
 * - any row whose TTL (`expiresAt`) has passed or passes within the hour. DynamoDB may delete those on its
 *   own at any moment, which would make the comparison unstable, and they're about to go anyway.
 * Other rows with a TTL (owner events, API keys, idempotency records) are copied like any other row.
 */
export type Item = Record<string, AttributeValue>;
type Command = ScanCommand | BatchWriteItemCommand;
export interface TableClient {
  send(command: Command): Promise<unknown>;
}
type Put = { PutRequest: { Item: Item } };

/** Sign-in state that the new stack doesn't need: everyone signs in again there. */
const DISPOSABLE = ["CHALLENGE#", "SESSION#"];
/** A row expiring within this margin may be deleted by DynamoDB's TTL during the copy. */
export const TTL_MARGIN_SECONDS = 3600;
/** Whether the copy leaves this row out: disposable sign-in state, or a TTL that has passed or soon will. */
export function skipped(item: Item, now: number) {
  if (DISPOSABLE.some((prefix) => item.pk?.S?.startsWith(prefix))) return true;
  const ttl = item.expiresAt?.N;
  return ttl !== undefined && Number(ttl) <= now + TTL_MARGIN_SECONDS;
}

export async function scanAll(client: TableClient, table: string): Promise<Item[]> {
  const items: Item[] = [];
  let start: Item | undefined;
  do {
    const page = (await client.send(
      new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: start }),
    )) as { Items?: Item[]; LastEvaluatedKey?: Item };
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}

/** A stable encoding: sorted keys, and DynamoDB set members sorted, since sets have no order. */
function normalize(value: unknown, key?: string): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) {
    const out = value.map((member) => normalize(member));
    return key === "SS" || key === "NS" || key === "BS"
      ? out.map((member) => JSON.stringify(member)).sort()
      : out;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, normalize((value as Record<string, unknown>)[k], k)]),
    );
  return value;
}
export const canonical = (item: Item) => JSON.stringify(normalize(item));
/** The row's primary key: the records table's partition and sort keys. */
const key = (item: Item) => JSON.stringify([item.pk, item.sk].map((part) => normalize(part)));
export function digest(items: Item[]) {
  const hash = createHash("sha256");
  for (const line of items.map(canonical).sort()) hash.update(line + "\n");
  return hash.digest("hex");
}
/** Items per partition-key prefix (the part before "#"), without revealing any key. */
export function prefixCounts(items: Item[]) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const prefix = (item.pk?.S ?? "?").split("#")[0] || "?";
    counts[prefix] = (counts[prefix] ?? 0) + 1;
  }
  return counts;
}

export async function copyRecords(
  source: TableClient,
  sourceTable: string,
  dest: TableClient,
  destTable: string,
  apply: boolean,
  pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Math.floor(Date.now() / 1000),
) {
  // One cut-off for the whole run, so every scan leaves out the same rows.
  const kept = (item: Item) => !skipped(item, now);
  const all = await scanAll(source, sourceTable);
  const items = all.filter(kept);
  const summary = {
    items: items.length,
    skipped: all.length - items.length,
    prefixes: prefixCounts(items),
    digest: digest(items),
  };
  if (!apply) return { ...summary, copied: false };
  // Only an earlier copy may be present. Its rows are overwritten by the current source rows with the same
  // key (even if the source row changed since); a row whose key isn't in the source stops the copy.
  const keys = new Set(items.map(key));
  const strays = (await scanAll(dest, destTable)).filter((item) => kept(item) && !keys.has(key(item)));
  if (strays.length)
    throw new Error(
      `The destination holds ${strays.length} rows whose keys aren't in the source (${Object.keys(prefixCounts(strays)).join(", ")}). ` +
        "Nothing was copied. If they came from an earlier interrupted copy, remove them from the new table, then re-run.",
    );
  for (let i = 0; i < items.length; i += 25) {
    let pending: Put[] = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    for (let attempt = 0; pending.length; attempt++) {
      if (attempt === 8)
        throw new Error("DynamoDB kept returning unprocessed items. Re-run the copy; it resumes safely.");
      if (attempt) await pause(100 * 2 ** attempt);
      const out = (await dest.send(
        new BatchWriteItemCommand({ RequestItems: { [destTable]: pending } }),
      )) as { UnprocessedItems?: Record<string, Put[]> };
      pending = out.UnprocessedItems?.[destTable] ?? [];
    }
  }
  const after = digest((await scanAll(source, sourceTable)).filter(kept));
  if (after !== summary.digest)
    throw new Error("The source changed during the copy. Is the old stack still switched on? Re-run once it's frozen.");
  const copied = (await scanAll(dest, destTable)).filter(kept);
  if (copied.length !== items.length || digest(copied) !== summary.digest)
    throw new Error(
      `Verification failed: the destination has ${copied.length} items, the source ${items.length}. Don't switch the new stack on.`,
    );
  return { ...summary, copied: true };
}

/**
 * A client for one side of the copy. `profile` picks that side's credentials from the shared AWS config
 * (including credential_process and Identity Center profiles), independently of the other side.
 */
export function clientFor(region: string, profile?: string) {
  return new DynamoDBClient({ region, ...(profile ? { profile } : {}) });
}

export function parseTarget(value: string | undefined, flag: string) {
  const match = /^([a-z]{2}-[a-z]+-\d):([A-Za-z0-9_.-]{3,255})$/.exec(value ?? "");
  if (!match) throw new Error(`${flag} must be REGION:TABLE, for example eu-west-2:qsb-app-records.`);
  return { region: match[1], table: match[2] };
}

export async function runCopyRecordsCli(args: string[]) {
  try {
    const flag = (name: string) => args[args.indexOf(name) + 1];
    const from = parseTarget(args.includes("--from") ? flag("--from") : undefined, "--from");
    const to = parseTarget(args.includes("--to") ? flag("--to") : undefined, "--to");
    if (from.region === to.region && from.table === to.table) throw new Error("--from and --to are the same table.");
    const profile = (name: string) => {
      if (!args.includes(name)) return undefined;
      const value = flag(name);
      if (!value || !/^[\w+=,.@-]{1,128}$/.test(value)) throw new Error(`${name} must name an AWS profile.`);
      return value;
    };
    const result = await copyRecords(
      clientFor(from.region, profile("--from-profile")),
      from.table,
      clientFor(to.region, profile("--to-profile")),
      to.table,
      args.includes("--apply"),
    );
    process.stdout.write(JSON.stringify({ from, to, ...result }, null, 2) + "\n");
  } catch (error) {
    // Only this script's own messages are shown in full. An AWS error shows its name (for example
    // AccessDeniedException), since its message can carry request details.
    const own =
      error instanceof Error && !("$metadata" in error)
        ? error.message
        : `The copy failed: ${error instanceof Error ? error.name : "unknown error"}.`;
    process.stderr.write(JSON.stringify({ action: "refuse", reason: own }) + "\n");
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runCopyRecordsCli(process.argv.slice(2));
