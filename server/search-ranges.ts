// Must match worker/search_ranges.py; exact decimal ranks survive JSON/DynamoDB.
export const searchVersion = "ranked-v2";
export const chunkSize = 2 ** 34;
const ltSpan = 1744600000 - 500000000;
const sequences = 16;
const subsetTotal = 82947113349100n;
export function workRange(stage: string, attempt: number) {
  if (!Number.isSafeInteger(attempt) || attempt < 0)
    throw new Error("Invalid work unit");
  if (stage === "pinning") {
    const seqOffset = attempt * sequences;
    if (seqOffset >= 2 ** 31) throw new Error("Search range exhausted");
    return {
      version: searchVersion,
      start: (BigInt(seqOffset) * BigInt(ltSpan)).toString(),
      count: sequences * ltSpan,
      sequence: 0x80000000 + seqOffset,
      sequenceCount: sequences,
      locktime: 500000000,
    };
  }
  if (stage !== "round1" && stage !== "round2")
    throw new Error("Invalid stage");
  const start = BigInt(attempt) * BigInt(chunkSize);
  if (start >= subsetTotal) throw new Error("Search range exhausted");
  return {
    version: searchVersion,
    start: start.toString(),
    count: Number(
      subsetTotal - start < BigInt(chunkSize)
        ? subsetTotal - start
        : BigInt(chunkSize),
    ),
  };
}

// Convert the CPU verifier's HORS indices back to the GPU's lexicographic rank.
export function subsetRank(horsIndices: number[]): bigint {
  if (
    horsIndices.length !== 9 ||
    new Set(horsIndices).size !== 9 ||
    horsIndices.some((i) => !Number.isInteger(i) || i < 0 || i >= 150)
  )
    throw new Error("Invalid subset");
  const combo = horsIndices.map((i) => 149 - i).sort((a, b) => a - b);
  const choose = (n: number, k: number) => {
    let result = 1n;
    for (let i = 1; i <= k; i++)
      result = (result * BigInt(n - k + i)) / BigInt(i);
    return result;
  };
  let rank = 0n,
    previous = -1;
  for (let i = 0; i < 9; i++) {
    for (let j = previous + 1; j < combo[i]; j++)
      rank += choose(149 - j, 8 - i);
    previous = combo[i];
  }
  return rank;
}
