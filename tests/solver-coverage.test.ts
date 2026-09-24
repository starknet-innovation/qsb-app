import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { workRange } from "../server/search-ranges";
import {
  SUBSET_ATTEMPTS,
  SUBSET_TOTAL,
  applyRange,
  coverageAccountStopped,
  creditedAttempts,
  emptyLedger,
  insertAttempt,
  partitionIdentity,
  publishedHitRecords,
  replaceSession,
  subsetAccounted,
  type CoverageScope,
  type RangeOutcome,
  type SearchStage,
} from "../server/runtime/coverage-ledger";
import {
  holdSolverSourceGap,
  judgeEvidence,
  readHoldSolverBinding,
  reviewGenericPath,
  sourceIdentity,
} from "../server/runtime/solver-review";

const root = process.cwd();
const holdSolver = readHoldSolverBinding();
const pinA = "2147483648:500000000";

function credit(
  ledger: ReturnType<typeof emptyLedger>,
  scope: CoverageScope,
  stage: SearchStage,
  attempt: number,
  outcome: RangeOutcome,
) {
  return applyRange(ledger, scope, stage, attempt, outcome, holdSolver);
}
const scope: CoverageScope = {
  sessionId: "session-a",
  solverPin: "qsb-config-a-ranked-v2-2791ed0",
  searchPin: pinA,
};

describe("ranked range partition", () => {
  it("covers the pinning sequence domain in disjoint batches", () => {
    const identity = partitionIdentity("pinning");
    expect(identity).toEqual({
      attempts: 134217728,
      start: 0x80000000n,
      end: 0x100000000n,
    });
    for (const attempt of [0, 1, 73, 134217726]) {
      const range = workRange("pinning", attempt);
      expect(range.sequence).toBe(0x80000000 + attempt * 16);
      expect(range.sequenceCount).toBe(16);
      expect(BigInt(range.start) + BigInt(range.count)).toBe(
        BigInt(workRange("pinning", attempt + 1).start),
      );
    }
    const last = workRange("pinning", 134217727);
    expect(last.sequence! + last.sequenceCount!).toBe(0x100000000);
    expect(() => workRange("pinning", 134217728)).toThrow(/exhausted/);
  });

  it("covers both subset rounds with the same disjoint ranks", () => {
    const identity = partitionIdentity("round1");
    expect(identity.attempts).toBe(SUBSET_ATTEMPTS);
    expect(partitionIdentity("round2")).toEqual(identity);
    let end = 0n;
    for (let attempt = 0; attempt < SUBSET_ATTEMPTS; attempt += 1) {
      const first = workRange("round1", attempt);
      const second = workRange("round2", attempt);
      expect(second).toEqual(first);
      expect(BigInt(first.start)).toBe(end);
      end += BigInt(first.count);
    }
    expect(end).toBe(SUBSET_TOTAL);
    expect(() => workRange("round2", SUBSET_ATTEMPTS)).toThrow(/exhausted/);
  });
});

describe("coverage accounting", () => {
  it("credits a retry once and keeps a prior pin's rounds off the next pin", () => {
    const retry = credit(emptyLedger(), scope, "round1", 3, { kind: "retry" });
    expect(retry.credited).toBe(false);
    expect(retry.wholeRangeCovered).toBe(false);
    const first = credit(retry.ledger, scope, "round1", 3, {
      kind: "range-complete",
      hitCount: 0,
    });
    const again = credit(first.ledger, scope, "round1", 3, {
      kind: "range-complete",
      hitCount: 0,
    });
    expect(first.credited).toBe(true);
    expect(again.credited).toBe(false);
    expect(again.reason).toBe("already-credited");
    expect(creditedAttempts(again.ledger, scope, "round1")).toEqual([
      { start: 3, end: 4 },
    ]);
    const merged = insertAttempt(insertAttempt([], 0).intervals, 2);
    expect(insertAttempt(merged.intervals, 1).intervals).toEqual([{ start: 0, end: 3 }]);
    const nextPin = { ...scope, searchPin: "2147483649:500000001" };
    expect(creditedAttempts(again.ledger, nextPin, "round1")).toEqual([]);
    expect(subsetAccounted(again.ledger, nextPin).both).toBe(false);
  });

  it("stops deterministic failures, unsupported geometry, and overflow without credit", () => {
    const failed = credit(emptyLedger(), scope, "round2", 1, {
      kind: "deterministic-failure",
    });
    expect(failed.credited).toBe(false);
    expect(failed.stop).toBe(true);
    const later = credit(failed.ledger, scope, "round2", 1, {
      kind: "range-complete",
      hitCount: 0,
    });
    expect(later.credited).toBe(false);
    expect(creditedAttempts(later.ledger, scope, "round2")).toEqual([]);
    for (const outcome of [
      { kind: "unsupported-geometry" as const },
      { kind: "host-error" as const },
      { kind: "publication-failure" as const },
      { kind: "exceptional-unresolved" as const },
      { kind: "hit-capacity" as const, hitCount: 65 },
    ]) {
      const decision = credit(emptyLedger(), scope, "round1", 0, outcome);
      expect(decision.credited).toBe(false);
      expect(decision.stop).toBe(true);
      expect(decision.wholeRangeCovered).toBe(false);
    }
    const overflow = credit(emptyLedger(), scope, "round1", 0, {
      kind: "range-complete",
      hitCount: 65,
    });
    expect(overflow.reason).toBe("hit-capacity");
    expect(credit(emptyLedger(), scope, "round1", SUBSET_ATTEMPTS, {
      kind: "range-complete",
      hitCount: 0,
    }).reason).toBe("unsupported-geometry");
    expect(
      credit(emptyLedger(), { ...scope, searchPin: null }, "round1", 0, {
        kind: "range-complete",
        hitCount: 0,
      }).reason,
    ).toBe("unsupported-geometry");
  });

  it("refuses a ninth coverage account without crediting it", () => {
    let ledger = emptyLedger();
    for (let index = 0; index < 8; index += 1) {
      const created = replaceSession(ledger, {
        sessionId: `session-${index}`,
        solverPin: scope.solverPin,
      });
      expect(created.ok).toBe(true);
      expect(created.created).toBe(true);
      ledger = created.ledger;
    }
    expect(ledger.accounts).toHaveLength(8);
    const ninthSession = replaceSession(ledger, {
      sessionId: "session-9",
      solverPin: scope.solverPin,
    });
    expect(ninthSession).toEqual({
      ok: false,
      created: false,
      ledger,
      reason: "coverage-account-full",
    });
    expect(ninthSession.ledger.accounts.some((account) => account.sessionId === "session-9")).toBe(
      false,
    );
    const ninth = credit(
      ledger,
      { ...scope, sessionId: "session-9", searchPin: null },
      "pinning",
      0,
      { kind: "range-complete", hitCount: 0 },
    );
    expect(ninth.credited).toBe(false);
    expect(ninth.stop).toBe(true);
    expect(ninth.reason).toBe("coverage-account-full");
    expect(ninth.ledger.accounts).toHaveLength(8);
    expect(
      creditedAttempts(
        ninth.ledger,
        { ...scope, sessionId: "session-9", searchPin: null },
        "pinning",
      ),
    ).toEqual([]);
  });

  it("stops only the matching session and solver account", () => {
    const stopped = credit(emptyLedger(), scope, "pinning", 0, {
      kind: "deterministic-failure",
    }).ledger;
    const otherSession = { sessionId: "session-b", solverPin: scope.solverPin };
    const otherSolver = { sessionId: scope.sessionId, solverPin: "other-solver" };
    expect(coverageAccountStopped(stopped, scope)).toBe(true);
    expect(coverageAccountStopped(stopped, otherSession)).toBe(false);
    expect(coverageAccountStopped(stopped, otherSolver)).toBe(false);
    expect(coverageAccountStopped(undefined, scope)).toBe(false);
    const replaced = replaceSession(stopped, otherSession);
    expect(replaced.ok).toBe(true);
    expect(replaced.created).toBe(true);
    expect(
      replaced.ledger.accounts.find((account) => account.sessionId === "session-b"),
    ).toMatchObject({ stopped: false, pinning: [], stopReason: null });
    expect(coverageAccountStopped(replaced.ledger, otherSession)).toBe(false);
    expect(coverageAccountStopped(replaced.ledger, scope)).toBe(true);
  });

  it("does not transfer coverage across a session or solver pin replacement", () => {
    const credited = credit(emptyLedger(), scope, "pinning", 4, {
      kind: "range-complete",
      hitCount: 1,
    }).ledger;
    const replaced = replaceSession(credited, {
      sessionId: "session-b",
      solverPin: scope.solverPin,
    });
    expect(replaced.ok).toBe(true);
    expect(replaced.created).toBe(true);
    expect(
      creditedAttempts(
        replaced.ledger,
        { ...scope, sessionId: "session-b", searchPin: null },
        "pinning",
      ),
    ).toEqual([]);
    expect(creditedAttempts(replaced.ledger, scope, "pinning")).toEqual([{ start: 4, end: 5 }]);
    expect(
      creditedAttempts(
        credited,
        { ...scope, solverPin: "other-solver" },
        "pinning",
      ),
    ).toEqual([]);
  });

  it("can account both subset rounds without calling that whole-range coverage", () => {
    let ledger = emptyLedger();
    for (const stage of ["round1", "round2"] as const) {
      for (let attempt = 0; attempt < SUBSET_ATTEMPTS; attempt += 1) {
        const decision = credit(ledger, scope, stage, attempt, {
          kind: "range-complete",
          hitCount: 0,
        });
        expect(decision.wholeRangeCovered).toBe(false);
        expect(decision.measuresHoldSolverBinary).toBe(false);
        expect(decision.holdSolverBinarySha256).toBe(holdSolver.binarySha256);
        ledger = decision.ledger;
      }
    }
    expect(subsetAccounted(ledger, scope)).toEqual({
      round1: true,
      round2: true,
      both: true,
    });
    expect(ledger.measuresHoldSolverBinary).toBe(false);
    expect(subsetAccounted(ledger, { ...scope, searchPin: "1:1" }).both).toBe(false);
    expect(publishedHitRecords(["indices=1\n".repeat(65)])).toBe(65);
    expect(publishedHitRecords(["sequence=2147483648\nlocktime=500000000\n".repeat(65)])).toBe(65);
    expect(
      publishedHitRecords([
        "sequence=2147483648\nlocktime=500000000\n".repeat(64) + "indices=1,2,3,4,5,6,7,8,9\n",
      ]),
    ).toBe(65);
    expect(publishedHitRecords(["sequence=2147483648\nlocktime=500000000\n"])).toBe(1);
    expect(publishedHitRecords([])).toBe(0);
  });
});

describe("source-bound solver review", () => {
  it("binds the generic-path review to these bytes and rejects predecessor evidence", () => {
    const review = reviewGenericPath(root);
    expect(review.selectedFlags).toEqual({ ZLAB_TRIM: 0, QSB_PAIR_SHARED: 0 });
    expect(review.defaultFlagsAreSelectedPath).toBe(false);
    expect(review.nativeBinarySha256).toBeNull();
    expect(review.gpuExecuted).toBe(false);
    expect(review.mainnetEnabled).toBe(false);
    expect(review.broadcastAuthorized).toBe(false);
    expect(review.assumptions.map((item) => item.id)).toEqual([
      "field-representation",
      "normalization",
      "inversion",
      "point-recovery",
      "predicates-and-publication",
      "capacity-and-omissions",
    ]);
    expect(review.assumptions.every((item) => item.remains.length > 0)).toBe(true);
    expect(
      judgeEvidence(review, {
        kind: "predecessor-gpu",
        sourceSha256: review.sourceSha256,
        nativeBinarySha256: null,
      }),
    ).toEqual({ accepted: false, reason: "predecessor-evidence" });
    expect(
      judgeEvidence(review, {
        kind: "native-binary",
        sourceSha256: "0".repeat(64),
        nativeBinarySha256: "ab".repeat(32),
      }),
    ).toEqual({ accepted: false, reason: "source-mismatch" });
    expect(
      judgeEvidence(review, {
        kind: "native-binary",
        sourceSha256: review.sourceSha256,
        nativeBinarySha256: "ab".repeat(32),
      }),
    ).toEqual({ accepted: false, reason: "native-not-run" });
    const included = [
      "research/optimized-subset/subset/GPUHash.h",
      "research/optimized-subset/subset/chain_replay_field.cuh",
      "research/optimized-subset/subset/hit_filter_field.cuh",
      "research/optimized-subset/subset/hit_filter_field_sc.cuh",
      "research/optimized-subset/subset/square32.cuh",
      "research/optimized-subset/subset/tests/gpu_epochs/prefix_cache.cuh",
      "research/optimized-subset/subset/tests/gpu_epochs/window_schedule_shared.cuh",
      "research/optimized-subset/subset/tests/gpu_epochs/exact_recovery.h",
      "research/optimized-subset/subset/tests/gpu_epochs/hm39_divstep.cuh",
    ];
    for (const relativePath of included) {
      expect(review.files[relativePath]).toMatch(/^[a-f0-9]{64}$/);
    }
    const gpuHash = included[0];
    if (gpuHash === undefined) throw new Error("missing include");
    const previous = review.files[gpuHash];
    const altered = { ...review.files, [gpuHash]: "ab".repeat(32) };
    expect(sourceIdentity(altered)).not.toBe(review.sourceSha256);
    expect(sourceIdentity(review.files)).toBe(review.sourceSha256);
    expect(previous).not.toBe(altered[gpuHash]);
    expect(
      judgeEvidence(review, {
        kind: "source-review",
        sourceSha256: sourceIdentity(altered),
        nativeBinarySha256: null,
      }),
    ).toEqual({ accepted: false, reason: "source-mismatch" });
  });

  it("checks the admitted field rule and strict DER predicate on the CPU", () => {
    const report = JSON.parse(
      execFileSync("python3", ["worker/validation/field_assumptions.py"], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    expect(report).toMatchObject({ ok: true, gpuExecuted: false });
    expect(report.normalizationVectors).toBeGreaterThan(200);
    expect(report.derAgreements).toBeGreaterThan(32);
  });

  it("keeps enrolled historical truncation and does not port exceptional recovery", () => {
    execFileSync("python3", ["worker/prepare_kernels.py"], { cwd: root });
    const subset = readFileSync(
      "worker/build/subset/tests/gpu_epochs/tree.cu",
      "utf8",
    );
    const pinning = readFileSync("worker/build/pinning/pinning.cu", "utf8");
    const optimized = readFileSync(
      "research/optimized-subset/subset/tests/gpu_epochs/tree.cu",
      "utf8",
    );
    for (const text of [subset, pinning]) {
      expect(text).toContain("? 64 :");
      expect(text).not.toContain(
        "QSB_RANGE_INCOMPLETE: hit count exceeds host capacity",
      );
      expect(text).not.toContain("hand exceptional active points");
    }
    expect(subset).toContain("return gpu_is_valid_der(digest, 32);");
    expect(subset).toContain("if(!usable)return;");
    expect(optimized).not.toContain("? 64 :");
    expect(optimized).toContain("hand exceptional active points");
  });

  it("does not measure the HOLD solver binary from the in-memory ledger", () => {
    const gap = holdSolverSourceGap(root);
    expect(gap).toMatchObject({
      inMemoryLedgerMeasuresBinary: false,
      gpuExecuted: false,
      nativeBinarySha256: null,
      wholeRangeCovered: false,
      mainnetEnabled: false,
      broadcastAuthorized: false,
      sourceMatchesHoldBuild: false,
      reason: "source-diverges-from-hold-build",
      binding: {
        status: "HOLD",
        enrolled: false,
        historicalBinaryAttestation: false,
        binarySha256:
          "6d46cec4ddfebeb94993a9aad26a8506668b7b23b6d2d3f0214a6a77272586d6",
      },
    });
    expect([...gap.divergedFromHoldBuild]).toEqual([
      "research/optimized-subset/subset/tests/gpu_epochs/pair_shared.cuh",
      "research/optimized-subset/subset/tests/gpu_epochs/tree.cu",
    ]);
    const review = reviewGenericPath(root);
    expect(review.nativeBinarySha256).toBeNull();
    expect(review.gpuExecuted).toBe(false);
    expect(review.holdSolver.reason).toBe(gap.reason);
    expect(
      judgeEvidence(review, {
        kind: "native-binary",
        sourceSha256: review.sourceSha256,
        nativeBinarySha256: gap.binding.binarySha256,
      }),
    ).toEqual({ accepted: false, reason: "hold-binary-unenrolled" });
    const credited = credit(emptyLedger(), scope, "pinning", 0, {
      kind: "range-complete",
      hitCount: 0,
    });
    const mismatched = applyRange(
      credited.ledger,
      scope,
      "pinning",
      1,
      { kind: "range-complete", hitCount: 0 },
      { ...holdSolver, binarySha256: "ab".repeat(32) },
    );
    expect(mismatched.credited).toBe(false);
    expect(mismatched.reason).toBe("hold-solver-mismatch");
    expect(mismatched.measuresHoldSolverBinary).toBe(false);
    expect(mismatched.ledger.accounts).toHaveLength(1);
    const unbound = applyRange(
      emptyLedger(),
      scope,
      "pinning",
      0,
      { kind: "range-complete", hitCount: 0 },
      { ...holdSolver, enrolled: true } as unknown as typeof holdSolver,
    );
    expect(unbound.credited).toBe(false);
    expect(unbound.reason).toBe("hold-solver-unbound");
    expect(unbound.ledger.accounts).toEqual([]);
  });
});
