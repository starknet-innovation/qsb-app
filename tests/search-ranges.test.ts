import { describe, expect, it } from "vitest";
import vectors from "../contracts/ranked-v2.json";
import { workRange, subsetRank } from "../server/search-ranges";

describe("GPU work partitioning", () => {
  it("matches the published ranked-v2 solver release contract", () => {
    expect(vectors.searchVersion).toBe("ranked-v2");
    for (const { stage, attempt, range } of vectors.cases)
      expect(workRange(stage, attempt)).toEqual(range);
    for (const { stage, attempt } of vectors.invalid)
      expect(() => workRange(stage, attempt)).toThrow();
  });
  it("has contiguous non-overlapping ranges and covers both terminal boundaries", () => {
    for (const [stage, attempts] of [
      ["pinning", [0, 73, 74, 75, 134217726]],
      ["round1", [0, 1, 4827]],
    ] as const) {
      for (const a of attempts) {
        const current = workRange(stage, a),
          next = workRange(stage, a + 1);
        expect(BigInt(current.start) + BigInt(current.count)).toBe(
          BigInt(next.start),
        );
      }
    }
    const lastPin = workRange("pinning", 134217727);
    expect(lastPin.sequence! + lastPin.sequenceCount! - 1).toBe(0xffffffff);
    expect(lastPin.locktime! + lastPin.count / lastPin.sequenceCount!).toBe(
      1744600000,
    );
    const lastSubset = workRange("round2", 4828);
    expect(BigInt(lastSubset.start) + BigInt(lastSubset.count)).toBe(
      82947113349100n,
    );
    expect(() => workRange("round2", 4829)).toThrow("exhausted");
    expect(() => workRange("pinning", 134217728)).toThrow("exhausted");
  });
});

it("maps HORS indices to exact GPU lexicographic ranks", () => {
  expect(subsetRank([141, 142, 143, 144, 145, 146, 147, 148, 149])).toBe(0n);
  expect(subsetRank([140, 142, 143, 144, 145, 146, 147, 148, 149])).toBe(1n);
  expect(subsetRank([0, 1, 2, 3, 4, 5, 6, 7, 8])).toBe(82947113349099n);
  expect(() => subsetRank([1, 1, 2, 3, 4, 5, 6, 7, 8])).toThrow();
});
