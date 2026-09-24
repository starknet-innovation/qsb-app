import { it, expect } from "vitest";
import { fingerprint } from "../src/lib/provenance";
import { decodeResearchQueueCompletion } from "../scripts/yukon/pin_store";
it("binds provider ID, runtime manifest and submitted queue payload before publication", () => {
  const runtimeManifestSha256 = "a".repeat(64),
    request = {
      protocol: "qsb-yukon-pinning-research-v1",
      requestId: "test",
      manifestHash: "b".repeat(64),
      binarySha256: "c".repeat(64),
      parameterSha256: "d".repeat(64),
      range: {
        sequence: 2147483648,
        sequenceCount: 1,
        locktime: 500000000,
        locktimeCount: 1,
      },
    };
  const output = {
    ...request,
    status: "range-drained",
    candidates: [],
    verified: false,
    rangeCreditEligible: false,
    releaseStatus: "HOLD",
  };
  const queue = {
    protocol: "qsb-yukon-pin-queue-v1",
    providerJobId: "job",
    runtimeManifestSha256,
    inputSha256: fingerprint({ runtimeManifestSha256, request }),
    output,
  };
  expect(
    decodeResearchQueueCompletion(
      { id: "job", status: "COMPLETED", output: queue },
      request,
      runtimeManifestSha256,
    ).output,
  ).toEqual(output);
  for (const altered of [
    { ...queue, providerJobId: "other" },
    { ...queue, runtimeManifestSha256: "f".repeat(64) },
    { ...queue, inputSha256: "f".repeat(64) },
    { ...queue, protocol: "qsb-config-a-v1" },
    { ...queue, output: { ...output, requestId: "other-request" } },
  ])
    expect(() =>
      decodeResearchQueueCompletion(
        { id: "job", status: "COMPLETED", output: altered },
        request,
        runtimeManifestSha256,
      ),
    ).toThrow();
  expect(() =>
    decodeResearchQueueCompletion(
      { id: "job", status: "FAILED", output: queue },
      request,
      runtimeManifestSha256,
    ),
  ).toThrow();
});
