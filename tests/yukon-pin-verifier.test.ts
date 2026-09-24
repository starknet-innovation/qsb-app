import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, expect } from "vitest";
import { createPinVerifier } from "../scripts/yukon/pin_verifier";
import lock from "../scripts/yukon/pin_verifier_lock.json";
it("refuses changed or symlinked adapter artifacts before starting the CPU process", async () => {
  for (const name of Object.keys(lock))
    for (const mode of ["changed", "symlink"]) {
      const root = mkdtempSync(path.join(tmpdir(), "qsb-pin-verifier-"));
      try {
        const dir = path.join(root, "scripts/yukon");
        mkdirSync(dir, { recursive: true });
        for (const file of [...Object.keys(lock), "pin_verifier_lock.json"])
          copyFileSync(path.join("scripts/yukon", file), path.join(dir, file));
        const file = path.join(dir, name);
        if (mode === "changed")
          writeFileSync(file, readFileSync(file, "utf8") + "\n");
        else {
          const target = path.join(root, "same-bytes");
          copyFileSync(file, target);
          rmSync(file);
          symlinkSync(target, file);
        }
        await expect(
          createPinVerifier(root, "/must-not-launch")(
            {},
            {},
            {},
            "a".repeat(64),
          ),
        ).rejects.toThrow("Unenrolled CPU verifier artifact");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
});
