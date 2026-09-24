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
import { it, expect, vi } from "vitest";
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));
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

it("executes the checked snapshot when the source path changes after the read", async () => {
  const fs = await import("node:fs");
  const root = mkdtempSync(path.join(tmpdir(), "qsb-pin-race-"));
  const marker = path.join(root, "unverified-code-ran");
  const dir = path.join(root, "scripts/yukon");
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(root, "worker/cpu"), { recursive: true });
  for (const file of [...Object.keys(lock), "pin_verifier_lock.json"])
    copyFileSync(path.join("scripts/yukon", file), path.join(dir, file));
  const cpuLock = JSON.parse(
    readFileSync("scripts/yukon/pin_reference_lock.json", "utf8"),
  );
  for (const file of Object.keys(cpuLock))
    copyFileSync(
      path.join("worker/cpu", file),
      path.join(root, "worker/cpu", file),
    );
  const original = fs.readFileSync;
  let swapped = false;
  const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
    ...args: Parameters<typeof fs.readFileSync>
  ) => {
    const raw = original(...args);
    if (
      !swapped &&
      typeof args[0] === "number" &&
      raw.toString().startsWith('"""One-request public CPU bridge.')
    ) {
      swapped = true;
      writeFileSync(
        path.join(dir, "pin_verify_cli.py"),
        `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()\nprint('{}')\n`,
      );
    }
    return raw;
  }) as typeof fs.readFileSync);
  try {
    await expect(
      createPinVerifier(root)({}, {}, {}, "a".repeat(64)),
    ).rejects.toThrow("CPU verifier rejected result");
    expect(swapped).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
