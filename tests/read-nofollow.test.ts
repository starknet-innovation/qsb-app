import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readNoFollow } from "../supervised/runtime/source/work/read-nofollow";

describe("readNoFollow", () => {
  it("reads a regular file and does not follow a symlink", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qsb-nofollow-"));
    try {
      const secret = path.join(dir, "secret.txt");
      const regular = path.join(dir, "regular.txt");
      const link = path.join(dir, "link.txt");
      const dangling = path.join(dir, "dangling.txt");
      writeFileSync(secret, "secret-bytes");
      writeFileSync(regular, "public-bytes");
      symlinkSync(secret, link);
      symlinkSync(path.join(dir, "missing.txt"), dangling);
      expect(readNoFollow(regular, "refused").toString("utf8")).toBe(
        "public-bytes",
      );
      expect(() => readNoFollow(link, "refused")).toThrow("refused");
      expect(() => readNoFollow(dangling, "refused")).toThrow("refused");
      expect(() => readNoFollow(dir, "refused")).toThrow("refused");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
