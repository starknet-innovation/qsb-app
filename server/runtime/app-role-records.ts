import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Partition-key prefixes written on the coordinator path.
 * Condition checks are not writes: the API condition-checks
 * SYSTEM#QSB_MAINNET_SERVICE and SYSTEM#RESERVATION_AUTHORITY and does not put them.
 * No operator role is granted here, so those system rows stay unwritable by these roles.
 */
export const coordinatorPathWrites = {
  api: [
    { prefix: "CHALLENGE#", actions: ["PutItem", "DeleteItem"] },
    { prefix: "SESSION#", actions: ["PutItem"] },
    { prefix: "OWNER#", actions: ["PutItem"] },
    { prefix: "OUTPOINT#", actions: ["PutItem"] },
    { prefix: "OUTBOX#", actions: ["PutItem"] },
  ],
  coordinator: [{ prefix: "OWNER#", actions: ["PutItem"] }],
} as const;

export type AppRole = keyof typeof coordinatorPathWrites;

type PolicyStatement = {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Condition?: {
    "ForAnyValue:StringLike"?: { "dynamodb:LeadingKeys"?: string[] };
  };
};

const policyPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../terraform/policies/app-records.json",
);

export function appRoleRecordStatements(): PolicyStatement[] {
  return JSON.parse(readFileSync(policyPath, "utf8")) as PolicyStatement[];
}

function stringLike(value: string, pattern: string): boolean {
  const expression = `^${pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".")}$`;
  return new RegExp(expression).test(value);
}

function matches(statement: PolicyStatement, action: string, leadingKeys: string[]): boolean {
  const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  if (!actions.includes(action)) return false;
  const patterns = statement.Condition?.["ForAnyValue:StringLike"]?.["dynamodb:LeadingKeys"];
  if (!patterns) return true;
  return leadingKeys.some((key) => patterns.some((pattern) => stringLike(key, pattern)));
}

/** Local evaluation of the shared API and coordinator record policy. Not a live IAM call. */
export function decideAppRoleAccess(
  action: string,
  leadingKeys: string[],
): "allow" | "deny" {
  let allowed = false;
  for (const statement of appRoleRecordStatements()) {
    if (!matches(statement, action, leadingKeys)) continue;
    if (statement.Effect === "Deny") return "deny";
    allowed = true;
  }
  return allowed ? "allow" : "deny";
}
