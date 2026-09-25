import { describe, expect, it } from "vitest";
import {
  coordinatorPathWrites,
  decideAppRoleAccess,
} from "../server/runtime/app-role-records";

describe("app role record access", () => {
  it("lists coordinator-path writes and keeps system rows off that list", () => {
    expect(coordinatorPathWrites.api.map((entry) => entry.prefix)).toEqual([
      "CHALLENGE#",
      "SESSION#",
      "OWNER#",
      "OUTPOINT#",
    ]);
    expect(coordinatorPathWrites.coordinator).toEqual([
      { prefix: "OWNER#", actions: ["PutItem"] },
    ]);
    expect(
      coordinatorPathWrites.api.find((entry) => entry.prefix === "OUTPOINT#")
        ?.actions,
    ).toEqual(["PutItem"]);
    expect(
      [...coordinatorPathWrites.api, ...coordinatorPathWrites.coordinator].some(
        (entry) => entry.prefix.startsWith("SYSTEM#"),
      ),
    ).toBe(false);
  });

  it("lets the API create a reservation and refuses to delete one", () => {
    const reservation = [`OUTPOINT#${"ab".repeat(32)}:0`];
    expect(decideAppRoleAccess("dynamodb:PutItem", reservation)).toBe("allow");
    expect(decideAppRoleAccess("dynamodb:DeleteItem", reservation)).toBe(
      "deny",
    );
    expect(decideAppRoleAccess("dynamodb:UpdateItem", reservation)).toBe(
      "deny",
    );
    expect(decideAppRoleAccess("dynamodb:BatchWriteItem", reservation)).toBe(
      "deny",
    );
    expect(
      decideAppRoleAccess("dynamodb:DeleteItem", [
        "OWNER#wallet",
        reservation[0]!,
      ]),
    ).toBe("deny");
  });

  it("denies system-row writes and still allows the authority condition check", () => {
    const authority = ["SYSTEM#RESERVATION_AUTHORITY"];
    expect(decideAppRoleAccess("dynamodb:PutItem", authority)).toBe("deny");
    expect(decideAppRoleAccess("dynamodb:DeleteItem", authority)).toBe("deny");
    expect(decideAppRoleAccess("dynamodb:ConditionCheckItem", authority)).toBe(
      "allow",
    );
    expect(decideAppRoleAccess("dynamodb:GetItem", authority)).toBe("allow");
    expect(
      decideAppRoleAccess("dynamodb:PutItem", ["SYSTEM#QSB_MAINNET_SERVICE"]),
    ).toBe("deny");
    expect(
      decideAppRoleAccess("dynamodb:DeleteItem", ["CHALLENGE#nonce"]),
    ).toBe("allow");
    expect(decideAppRoleAccess("dynamodb:PutItem", ["OWNER#wallet"])).toBe(
      "allow",
    );
  });
});

it("restricts coordinator writes including mixed and empty keys", () => {
  expect(
    decideAppRoleAccess(
      "dynamodb:GetItem",
      ["SYSTEM#RESERVATION_AUTHORITY"],
      "coordinator",
    ),
  ).toBe("allow");
  expect(
    decideAppRoleAccess("dynamodb:PutItem", ["OWNER#wallet"], "coordinator"),
  ).toBe("allow");
  for (const keys of [
    [],
    ["OUTPOINT#x"],
    ["SYSTEM#x"],
    ["OWNER#wallet", "OUTPOINT#x"],
  ])
    expect(decideAppRoleAccess("dynamodb:PutItem", keys, "coordinator")).toBe(
      "deny",
    );
  for (const action of [
    "DeleteItem",
    "UpdateItem",
    "BatchWriteItem",
    "Query",
    "ConditionCheckItem",
  ])
    expect(
      decideAppRoleAccess(
        `dynamodb:${action}`,
        ["OWNER#wallet"],
        "coordinator",
      ),
    ).toBe("deny");
});

// Only the active app roles are deployed; the other model entries are parked.
import { permissionModel } from "../server/runtime/storage-authority";
import apiPolicy from "../terraform/policies/app-records.json";
import operatorPolicy from "../terraform/policies/operator-reconcile-records.json";
import coordinatorPolicy from "../terraform/policies/coordinator-records.json";
it("documents the exact active role allow actions from Terraform", () => {
  for (const [role, policy] of [
    ["api", apiPolicy],
    ["coordinator", coordinatorPolicy],
    ["operator-reconcile", operatorPolicy],
  ] as const) {
    const actions = [
      ...new Set(
        policy.filter((s) => s.Effect === "Allow").flatMap((s) => s.Action),
      ),
    ]
      .map((s) => s.replace("dynamodb:", ""))
      .sort();
    expect([...permissionModel.roles[role].data].sort()).toEqual(actions);
  }
  for (const role of Object.values(permissionModel.roles)) {
    expect(role.data).not.toContain("TransactWriteItems");
  }
});

it("reconciliation permits only Get/Put on present OWNER keys", () => {
  expect(operatorPolicy.map(s => s.Action).flat().sort()).toEqual(["dynamodb:GetItem", "dynamodb:PutItem"]);
  for (const statement of operatorPolicy) {
    expect(statement.Effect).toBe("Allow");
    expect(statement.Condition).toEqual({"ForAllValues:StringLike": {"dynamodb:LeadingKeys": ["OWNER#*"]}, Null: {"dynamodb:LeadingKeys": "false"}});
    for (const key of ["SYSTEM#authority", "OUTPOINT#tx:0"]) {
      expect(key.startsWith(statement.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"][0].slice(0,-1))).toBe(false);
    }
  }
});
