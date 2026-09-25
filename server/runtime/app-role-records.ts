import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Partition-key prefixes written on the coordinator path.
 * Condition checks are not writes: the API condition-checks
 * SYSTEM#RESERVATION_AUTHORITY and does not put them.
 * No operator role is granted here, so those system rows stay unwritable by these roles.
 */
export const coordinatorPathWrites = {
  api: [
    { prefix: "CHALLENGE#", actions: ["PutItem", "DeleteItem"] },
    { prefix: "SESSION#", actions: ["PutItem"] },
    { prefix: "OWNER#", actions: ["PutItem"] },
    { prefix: "OUTPOINT#", actions: ["PutItem"] },
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
    "ForAllValues:StringLike"?: { "dynamodb:LeadingKeys"?: string[] };
    Null?: { "dynamodb:LeadingKeys"?: string };
  };
};

export function appRoleRecordStatements(
  role: AppRole = "api",
): PolicyStatement[] {
  const filename =
    role === "api" ? "app-records.json" : "coordinator-records.json";
  const policyPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../terraform/policies",
    filename,
  );
  return JSON.parse(readFileSync(policyPath, "utf8")) as PolicyStatement[];
}

function stringLike(value: string, pattern: string): boolean {
  const expression = `^${pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".")}$`;
  return new RegExp(expression).test(value);
}

function matches(
  statement: PolicyStatement,
  action: string,
  leadingKeys: string[],
): boolean {
  const actions = Array.isArray(statement.Action)
    ? statement.Action
    : [statement.Action];
  if (!actions.includes(action)) return false;
  const patterns =
    statement.Condition?.["ForAnyValue:StringLike"]?.["dynamodb:LeadingKeys"];
  if (
    statement.Condition?.Null?.["dynamodb:LeadingKeys"] === "false" &&
    leadingKeys.length === 0
  )
    return false;
  const all =
    statement.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"];
  if (
    all &&
    !leadingKeys.every((key) => all.some((pattern) => stringLike(key, pattern)))
  )
    return false;
  if (!patterns) return true;
  return leadingKeys.some((key) =>
    patterns.some((pattern) => stringLike(key, pattern)),
  );
}

/** Local evaluation of the selected API or coordinator record policy. Not a live IAM call. */
export function decideAppRoleAccess(
  action: string,
  leadingKeys: string[],
  role: AppRole = "api",
): "allow" | "deny" {
  let allowed = false;
  for (const statement of appRoleRecordStatements(role)) {
    if (!matches(statement, action, leadingKeys)) continue;
    if (statement.Effect === "Deny") return "deny";
    allowed = true;
  }
  return allowed ? "allow" : "deny";
}
