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
