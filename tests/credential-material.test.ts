import { describe, expect, it } from "vitest";
import { assertNoCredentialMaterial } from "../server/runtime/host-requirements";

// judgeInclusionEvidence runs this on inclusion evidence before recording it.
describe("assertNoCredentialMaterial", () => {
  it("rejects credential-shaped keys and values anywhere in the value", () => {
    for (const value of [
      { browserRequest: { apiKey: "synthetic" } },
      { awsSecretAccessKey: "synthetic-secret-value" },
      { accessToken: "synthetic-token" },
      { session: "ASIAIOSFODNN7EXAMPLE" },
      { runpodKey: "synthetic-secret-value" },
    ])
      expect(() => assertNoCredentialMaterial(value), JSON.stringify(value)).toThrow(
        /CredentialMaterialRejected/,
      );
  });

  it("accepts a manifest's idempotency key", () => {
    expect(() =>
      assertNoCredentialMaterial({
        manifest: { idempotencyKey: "00000000-0000-4000-8000-000000000000" },
      }),
    ).not.toThrow();
  });
});
