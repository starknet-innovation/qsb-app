import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { expect, it, vi } from "vitest";

// Record every flush the CLI asks for, on real files.
const synced = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (file: string, flags?: string, mode?: number) => {
      const handle = await actual.open(file, flags, mode);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        synced.push(file);
      };
      return handle;
    },
  };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const names = new Map<number, string>();
  return {
    ...actual,
    openSync: (file: string, ...rest: unknown[]) => {
      const fd = (actual.openSync as (...a: unknown[]) => number)(file, ...rest);
      names.set(fd, file);
      return fd;
    },
    fsyncSync: (fd: number) => {
      actual.fsyncSync(fd);
      synced.push(names.get(fd)!);
    },
  };
});
const { filePendingDeposits, writeNewPrivateFile } = await import("../sdk/cli-io");

it("flushes a backup and its directory before saying it is saved, and pending deposits too", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "qsb-cli-"));
  const io = { env: {}, stdin: Readable.from([]), stdout: new PassThrough(), stderr: new PassThrough(), interactive: false, cwd };
  await writeNewPrivateFile(io, "backup.json", "encrypted");
  expect(readFileSync(path.join(cwd, "backup.json"), "utf8")).toBe("encrypted");
  expect(statSync(path.join(cwd, "backup.json")).mode & 0o777).toBe(0o600);
  expect(synced).toEqual([path.join(cwd, "backup.json"), cwd]);
  synced.length = 0;
  const home = path.join(cwd, "home");
  const vaultId = crypto.randomUUID();
  await filePendingDeposits(home).set(vaultId, { txid: "ab".repeat(32), amount: "1000", rawTxHex: "00" });
  const file = path.join(home, "pending-deposits", `${vaultId}.json`);
  expect(synced).toEqual([`${file}.${process.pid}.tmp`, path.dirname(file)]);
  expect(await filePendingDeposits(home).get(vaultId)).toEqual({ txid: "ab".repeat(32), amount: "1000", rawTxHex: "00" });
});
