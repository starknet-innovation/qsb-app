import { expect, it } from "vitest";
import { HOST_HIT_CAPACITY, publishedHitRecords } from "../server/hit-capacity";

it("counts every pinning and subset record toward the host's hit capacity", () => {
  expect(HOST_HIT_CAPACITY).toBe(64);
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
