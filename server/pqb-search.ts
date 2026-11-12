import contract from "../contracts/pqb-ranked-v2.json";
import { comb, rankSubset, unrankSubset } from "../src/pqb-core/grind";
import { PQB_SEARCH_VERSION } from "../src/lib/pqb-identity";

export function pqbWorkerStage(stage: string): "pinning" | "round0" | "round1" {
  if (stage === "pinning") return stage;
  if (stage === "round1") return "round0";
  if (stage === "round2") return "round1";
  throw new Error("Invalid PQB stage");
}

export function pqbWorkRange(stage: string, attempt: number) {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error("Invalid work unit");
  const workerStage = pqbWorkerStage(stage);
  if (workerStage === "pinning") {
    const s = contract.shapes.pinning, offset = BigInt(attempt) * BigInt(s.sequences);
    if (offset >= BigInt(s.sequenceCount)) throw new Error("Search range exhausted");
    const sequenceCount = Math.min(s.sequences, s.sequenceCount - Number(offset));
    const locktimeCount = s.locktimeEnd - s.locktimeMin;
    return { version: PQB_SEARCH_VERSION, start: (offset * BigInt(locktimeCount)).toString(),
      count: sequenceCount * locktimeCount, sequence: s.sequenceMin + Number(offset),
      sequenceCount, locktime: s.locktimeMin, locktimeCount };
  }
  const { slots, picks, prefixChunk } = contract.shapes[workerStage];
  const prefixes = comb(slots - 1, picks - 1), first = BigInt(attempt) * BigInt(prefixChunk);
  if (first >= prefixes) throw new Error("Search range exhausted");
  const count = prefixes - first < BigInt(prefixChunk) ? prefixes - first : BigInt(prefixChunk);
  const boundary = (rank: bigint) => {
    if (rank === prefixes) return comb(slots, picks);
    const prefix = unrankSubset(rank, slots - 1, picks - 1);
    return rankSubset([...prefix, prefix.at(-1)! + 1], slots);
  };
  const start = boundary(first);
  return { version: PQB_SEARCH_VERSION, start: start.toString(), count: Number(boundary(first + count) - start),
    prefixStart: first.toString(), prefixCount: Number(count) };
}
