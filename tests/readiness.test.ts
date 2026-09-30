import { describe, expect, it } from "vitest";
import { serviceStatus } from "../src/lib/readiness";

describe("service status shown in the app", () => {
  it("follows the server's switches and fails closed", () => {
    const on = { network: "mainnet", operationsEnabled: true, exactSubmitEnabled: true };
    expect(serviceStatus(on)).toBe("on");
    expect(serviceStatus({ ...on, exactSubmitEnabled: false })).toBe("search-only");
    expect(serviceStatus({ ...on, operationsEnabled: false })).toBe("off");
    expect(serviceStatus({ ...on, network: "testnet4" })).toBe("off");
    expect(serviceStatus({ ...on, exactSubmitEnabled: "true" })).toBe("search-only");
    expect(serviceStatus(undefined)).toBe("off");
  });
});
