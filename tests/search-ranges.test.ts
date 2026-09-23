import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { workRange, subsetRank } from "../server/search-ranges";

describe("GPU work partitioning", () => {
  it("matches Python exactly at sequence transitions, final ranges and large ranks", () => {
    const samples = [0, 1, 73, 74, 75, 76, 134217726, 134217727]
      .map((a) => ["pinning", a] as const)
      .concat([]);
    const cases: [string, number][] = [
      ...samples.map(([s, a]) => [s, a] as [string, number]),
      ...[0, 1, 4827, 4828].flatMap(
        (a) =>
          [
            ["round1", a],
            ["round2", a],
          ] as [string, number][],
      ),
    ];
    const python = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import sys,json;sys.path.insert(0,'worker');from search_ranges import work_range;print(json.dumps([work_range(*x) for x in json.loads(sys.argv[1])]))",
          JSON.stringify(cases),
        ],
        { encoding: "utf8" },
      ),
    );
    expect(cases.map(([s, a]) => workRange(s, a))).toEqual(python);
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
