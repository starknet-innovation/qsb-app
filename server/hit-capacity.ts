/** Retained hit records the host is willing to publish. Not an unlimited buffer. */
export const HOST_HIT_CAPACITY = 64;

/** How many hit records a range's candidates hold, counting past the cap only as far as needed. */
export function publishedHitRecords(candidates: readonly string[]): number {
  let count = 0;
  for (const text of candidates) {
    // Pinning records start with sequence=. Subset records start with indices=.
    // The CPU verifier splits on both prefixes, so either one consumes capacity.
    const marks = text.match(/^(?:indices|sequence)=/gm);
    count += marks?.length ?? (text.length ? 1 : 0);
    if (count > HOST_HIT_CAPACITY) return count;
  }
  return count;
}
