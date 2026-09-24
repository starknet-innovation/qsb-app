import { describe, it, expect } from "vitest";
import { MemoryStore } from "../server/store";
import { fingerprint } from "../src/lib/provenance";
import { PinInventoryV3 } from "../supervised/runtime/source/work/yukon-indexed-pin-20260923/pin-inventory-v3";
import { SCHEMA } from "../supervised/runtime/source/work/yukon-indexed-controller-20260923/identity-index";
import { publishResearchPin } from "../scripts/yukon/pin_store";

async function fixture() {
  const store = new MemoryStore(),
    scope = "isolated-yukon-pr30-store",
    pk = "VALIDATION#" + scope;
  const binding = {
    scope,
    owner: "test-owner",
    revision: 1,
    intent: "PIN#0",
    binarySha256: "a".repeat(64),
  };
  const context = {
    publicStateJson: "synthetic-test-context",
    manifest: { synthetic: true },
  };
  const request = {
    protocol: "qsb-yukon-pinning-research-v1",
    requestId: "test",
    manifestHash: fingerprint(context.manifest),
    binarySha256: binding.binarySha256,
    parameterSha256: "b".repeat(64),
    parameterBase64: "test",
    range: {
      sequence: 2147483648,
      sequenceCount: 1,
      locktime: 500000000,
      locktimeCount: 1,
    },
  };
  await store.put({
    pk,
    sk: "SCOPE",
    version: 1,
    owner: binding.owner,
    revision: 1,
    identitySchema: SCHEMA,
    stage: "pinning",
    phase: "pinning_searching",
    publicContext: JSON.stringify(context),
    publicContextHash: fingerprint(context),
    budget: {
      maxConcurrent: 1,
      maxSubmissions: 1,
      claimed: 0,
      deadlineMs: Date.now() + 60000,
    },
  });
  const inventory = new PinInventoryV3(store, scope, binding.owner, 1);
  await inventory.reserve(0, request, async () => {});
  await inventory.submit(
    "PIN#0",
    async () => "synthetic-provider",
    async () => {},
  );
  const { parameterBase64: _, ...fields } = request;
  const output = {
    ...fields,
    status: "range-drained",
    candidates: [{ sequence: 2147483648, locktime: 500000000, recid: 0 }],
    verified: false,
    rangeCreditEligible: false,
    releaseStatus: "HOLD",
  };
  const provider = { id: "synthetic-provider", status: "COMPLETED", output };
  const verdict = {
    referenceChecked: true,
    contextHash: fingerprint(context),
    verdicts: [{ valid: true, sequence: 2147483648, locktime: 500000000 }],
    decision: "candidate-verified",
    rangeCreditEligible: false,
    releaseStatus: "HOLD",
    freshWithdrawal: false,
  };
  return { store, pk, binding, provider, verdict };
}

describe("research pin publication through real Store and indexed submission", () => {
  it("publishes a candidate once and requests drain without range credit", async () => {
    const f = await fixture();
    await publishResearchPin(
      f.store,
      f.binding,
      f.provider,
      async () => f.verdict,
    );
    const scope = await f.store.get(f.pk, "SCOPE"),
      row = await f.store.get(f.pk, "PIN#0");
    expect(scope?.phase).toBe("pinning_draining");
    expect(scope?.completedRanges).toBeUndefined();
    expect(row?.state).toBe("research_result_verified");
    await expect(
      publishResearchPin(f.store, f.binding, f.provider, async () => f.verdict),
    ).rejects.toThrow();
  });
  it("allows only one racing publication", async () => {
    const f = await fixture();
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const verify = async () => {
      if (++entered === 2) release();
      await gate;
      return f.verdict;
    };
    const results = await Promise.allSettled([
      publishResearchPin(f.store, f.binding, f.provider, verify),
      publishResearchPin(f.store, f.binding, f.provider, verify),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  });
  it("rejects pause or provider identity changes during CPU verification atomically", async () => {
    for (const kind of ["pause", "identity"]) {
      const f = await fixture();
      const before = await f.store.get(f.pk, "PIN#0");
      await expect(
        publishResearchPin(f.store, f.binding, f.provider, async () => {
          const key = kind === "pause" ? "SCOPE" : "IDENTITY#PIN#0";
          const row = (await f.store.get(f.pk, key))!;
          await f.store.put(
            {
              ...row,
              version: row.version + 1,
              ...(kind === "pause"
                ? { phase: "paused", revision: 2 }
                : { ambiguous: true }),
            },
            row.version,
          );
          return f.verdict;
        }),
      ).rejects.toThrow();
      expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
    }
  });
  it("rejects mismatched provider, range and CPU context without writes", async () => {
    for (const kind of ["provider", "range", "cpu"]) {
      const f = await fixture();
      const before = await f.store.get(f.pk, "PIN#0");
      if (kind === "provider") f.provider.id = "other";
      if (kind === "range") f.provider.output.range.locktimeCount = 2;
      if (kind === "cpu") f.verdict.contextHash = "c".repeat(64);
      await expect(
        publishResearchPin(
          f.store,
          f.binding,
          f.provider,
          async () => f.verdict,
        ),
      ).rejects.toThrow();
      expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
    }
  });
  it("records empty drained results without granting coverage", async () => {
    const f = await fixture();
    f.provider.output.candidates = [];
    f.verdict.verdicts = [];
    f.verdict.decision = "range-drained-reference-bound";
    const receipt = await publishResearchPin(
      f.store,
      f.binding,
      f.provider,
      async () => f.verdict,
    );
    expect(receipt.rangeCreditEligible).toBe(false);
    const s = await f.store.get(f.pk, "SCOPE");
    expect(s?.phase).toBe("pinning_searching");
    expect(s?.completedRanges).toBeUndefined();
  });
  it("preserves attached work when verification fails or ownership is stale", async () => {
    for (const kind of ["throw", "owner", "revision", "decision"]) {
      const f = await fixture();
      const before = await f.store.get(f.pk, "PIN#0");
      if (kind === "owner") f.binding.owner = "other";
      if (kind === "revision") f.binding.revision = 2;
      if (kind === "decision")
        f.verdict.decision = "range-drained-reference-bound";
      await expect(
        publishResearchPin(f.store, f.binding, f.provider, async () => {
          if (kind === "throw") throw Error("CPU failed");
          return f.verdict;
        }),
      ).rejects.toThrow();
      expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
    }
  });
  it("rejects a global provider claim changed during verification", async () => {
    const f = await fixture();
    const before = await f.store.get(f.pk, "PIN#0");
    await expect(
      publishResearchPin(f.store, f.binding, f.provider, async () => {
        const rows = await f.store.list("VALIDATION#YUKON_PROVIDER_IDS", "");
        const claim = rows[0];
        await f.store.put(
          { ...claim, version: claim.version + 1, scope: "other" },
          claim.version,
        );
        return f.verdict;
      }),
    ).rejects.toThrow();
    expect(await f.store.get(f.pk, "PIN#0")).toEqual(before);
  });
});
