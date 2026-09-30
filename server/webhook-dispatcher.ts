import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { store as records, type Store } from "./store";
import { httpsTransport, systemResolver } from "./webhook-transport";
import {
  ROUND_LIMIT,
  WEBHOOK_DUE_INDEX,
  WEBHOOK_DUE_QUEUE,
  deliverDue,
  type Delivery,
} from "./webhooks";

/**
 * The scheduled webhook dispatcher (terraform/webhooks.tf). It sends queued deliveries whose
 * retry has come due, so they don't wait for the owner's next API request or coordinator tick.
 * It only runs deliverDue: it reads and writes WEBHOOKS rows and queries the due-delivery
 * index, and never touches jobs, vaults, intents, reservations or the coordinator. Its role
 * allows no more (terraform/policies/webhook-dispatcher-records.json).
 */

/** Owners with due deliveries, most overdue first. */
export type DueOwners = (now: number, limit: number) => Promise<string[]>;

/** Time for one run's rounds; the Lambda's 60-second timeout leaves room for the last write-back. */
export const DISPATCH_BUDGET_MS = 40_000;
/** Owners one run takes from the index. The rest are still due for the next run. */
export const DISPATCH_OWNERS = 50;
/** Owners served at once. */
export const DISPATCH_CONCURRENCY = 4;
/** Rounds per owner per run, of up to ROUND_LIMIT deliveries each. */
export const OWNER_ROUNDS = 5;
/** One round: a lookup and its requests, each at most REQUEST_TIMEOUT_MS. Well inside LEASE_MS. */
export const ROUND_MS = 8_000;
/** No round starts with less than this left. */
const MIN_ROUND_MS = 2_000;
const TIMEOUT_MARGIN_MS = 15_000;

function logDispatchError(stage: string, error: unknown) {
  // Error class only: never URLs, secrets, owners or payloads.
  console.error(JSON.stringify({ webhookDispatch: stage, error: (error as Error)?.name ?? "Error" }));
}

let client: DynamoDBDocumentClient | undefined;
/** The owners the due-delivery index lists as due by `now`: one Query, keys only. */
export function indexedDueOwners(table: string): DueOwners {
  return async (now, limit) => {
    client ??= DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
    const page = await client.send(
      new QueryCommand({
        TableName: table,
        IndexName: WEBHOOK_DUE_INDEX,
        KeyConditionExpression: "#queue = :queue AND #at <= :now",
        ExpressionAttributeNames: { "#queue": "webhookQueue", "#at": "webhookDueAt" },
        ExpressionAttributeValues: { ":queue": WEBHOOK_DUE_QUEUE, ":now": now },
        Limit: limit,
      }),
    );
    return (page.Items ?? []).flatMap((item) =>
      typeof item.pk === "string" && item.pk.startsWith("OWNER#") && item.sk === "WEBHOOKS"
        ? [item.pk.slice("OWNER#".length)]
        : [],
    );
  };
}

export type DispatchResult = { owners: number; served: number; rounds: number; failed: number };

/**
 * One run: take up to `maxOwners` due owners from the index and send their due deliveries
 * with deliverDue, within `budgetMs`. An owner gets further rounds while each claims a full
 * ROUND_LIMIT, up to OWNER_ROUNDS. The index is read without a consistent read, so an owner
 * it lists may have nothing due by now; deliverDue then claims and writes nothing.
 */
export async function dispatchWebhooks(
  store: Pick<Store, "get" | "put">,
  dueOwners: DueOwners,
  delivery: Delivery,
  { budgetMs = DISPATCH_BUDGET_MS, maxOwners = DISPATCH_OWNERS }: { budgetMs?: number; maxOwners?: number } = {},
): Promise<DispatchResult> {
  const until = Date.now() + budgetMs;
  const owners = [...new Set(await dueOwners(Date.now(), maxOwners))].slice(0, maxOwners);
  const result: DispatchResult = { owners: owners.length, served: 0, rounds: 0, failed: 0 };
  let next = 0;
  const left = () => until - Date.now();
  async function serve() {
    while (next < owners.length && left() >= MIN_ROUND_MS) {
      const owner = owners[next++];
      result.served++;
      for (let round = 0; round < OWNER_ROUNDS && left() >= MIN_ROUND_MS; round++) {
        let claimed: number;
        try {
          claimed = await deliverDue(store, owner, delivery, { deadline: Date.now() + Math.min(ROUND_MS, left()) });
        } catch (error) {
          result.failed++;
          logDispatchError("delivery_failed", error);
          break;
        }
        result.rounds++;
        if (claimed < ROUND_LIMIT) break;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DISPATCH_CONCURRENCY, owners.length) }, serve));
  return result;
}

/**
 * EventBridge Scheduler's target. The event carries nothing it reads. A failed index read
 * throws, so the function's error alarm sees it; a failed owner is logged and skipped.
 */
export async function handler(_event: unknown, context?: { getRemainingTimeInMillis?: () => number }) {
  const table = process.env.TABLE_NAME;
  if (!table) throw new Error("TABLE_NAME is required");
  const remaining = context?.getRemainingTimeInMillis?.() ?? DISPATCH_BUDGET_MS + TIMEOUT_MARGIN_MS;
  const result = await dispatchWebhooks(
    records,
    indexedDueOwners(table),
    { transport: httpsTransport, resolve: systemResolver },
    { budgetMs: Math.min(DISPATCH_BUDGET_MS, remaining - TIMEOUT_MARGIN_MS) },
  );
  // Counts only.
  console.log(JSON.stringify({ webhookDispatch: result }));
  return result;
}
