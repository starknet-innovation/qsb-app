import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import { base64 } from "@scure/base";
import type { PendingDeposit, PendingDeposits } from "./client";

export type CliIo = {
  env: Record<string, string | undefined>;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** stdin is a terminal: prompts may ask a person. */
  interactive: boolean;
  cwd: string;
  fetch?: typeof fetch;
};

export class UsageError extends Error {}
/** The external signer wrote a request and needs the signed file on a re-run. */
export class SignatureNeeded extends Error {}

/** Lines from stdin, one prompt at a time. A secret prompt doesn't echo what's typed. */
export class Prompter {
  private rl?: Interface;
  private muted = false;
  private closed = false;
  private lines: string[] = [];
  private waiting: ((line: string | undefined) => void)[] = [];
  constructor(private io: CliIo) {}
  private open(): Interface {
    if (this.rl) return this.rl;
    const output = new Writable({
      write: (chunk, _encoding, done) => {
        if (!this.muted) this.io.stderr.write(chunk);
        done();
      },
    });
    const rl = createInterface({ input: this.io.stdin, output, terminal: this.io.interactive });
    rl.on("line", (line) => {
      const next = this.waiting.shift();
      if (next) next(line);
      else this.lines.push(line);
    });
    rl.on("close", () => {
      this.closed = true;
      for (const next of this.waiting.splice(0)) next(undefined);
    });
    return (this.rl = rl);
  }
  async line(prompt: string, secret = false): Promise<string> {
    this.open();
    this.io.stderr.write(prompt);
    this.muted = secret;
    try {
      const line =
        this.lines.shift() ??
        (this.closed ? undefined : await new Promise<string | undefined>((r) => this.waiting.push(r)));
      if (line === undefined) throw new UsageError("No input: stdin is closed.");
      return line;
    } finally {
      this.muted = false;
      if (secret && this.io.interactive) this.io.stderr.write("\n");
    }
  }
  close() {
    this.rl?.close();
  }
}

const resolveIn = (io: CliIo, file: string) => path.resolve(io.cwd, file);
/** Owner-only. Every open passes it; a read-only open ignores it, but no open here can create a wider file. */
const PRIVATE = 0o600;

/**
 * Refuse, before any work, an output that already exists, that is also one of the
 * command's inputs, or that two outputs share. Nothing here is ever overwritten.
 */
export function assertOutputs(
  io: CliIo,
  outputs: (string | undefined)[],
  inputs: (string | undefined)[],
  maybeExisting: (string | undefined)[] = [],
): void {
  const seen = new Set(inputs.filter((f): f is string => f !== undefined).map((f) => resolveIn(io, f)));
  for (const file of [...outputs, ...maybeExisting]) {
    if (file === undefined) continue;
    const target = resolveIn(io, file);
    if (seen.has(target)) throw new UsageError(`${file} is used twice. Give every output its own new path.`);
    seen.add(target);
  }
  for (const file of outputs) {
    if (file === undefined) continue;
    if (existsSync(resolveIn(io, file)))
      throw new UsageError(`${file} already exists. Nothing is overwritten; choose a new path.`);
    if (!existsSync(path.dirname(resolveIn(io, file))))
      throw new UsageError(`The directory for ${file} doesn't exist.`);
  }
}
/** Create `target` exclusively, write it, and flush it and its directory to disk. */
async function writeExclusive(target: string, text: string) {
  const handle = await open(target, "wx", PRIVATE);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(path.dirname(target), "r", PRIVATE);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function writeNew(io: CliIo, file: string, text: string, sameContentOk = false): Promise<string> {
  const target = resolveIn(io, file);
  try {
    await writeExclusive(target, text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!sameContentOk || (await readBounded(target, file)).toString("utf8") !== text)
      throw new UsageError(`${file} already exists. Nothing is overwritten; choose a new path.`);
  }
  return target;
}
/** Write a public file (a PSBT, a signed transaction) owner-only, never over another file. */
export function writePublicFile(io: CliIo, file: string, text: string, sameContentOk = false): Promise<string> {
  return writeNew(io, file, text, sameContentOk);
}
/** Read a file through one handle, so its size is checked on the bytes that are read. */
async function readBounded(target: string, file: string): Promise<Buffer> {
  const handle = await open(target, "r", PRIVATE);
  try {
    if ((await handle.stat()).size > 4000000) throw new UsageError(`${file} is too large.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export async function readTextFile(io: CliIo, file: string): Promise<string> {
  return (await readBounded(resolveIn(io, file), file)).toString("utf8");
}
/** A PSBT file as base64: base64 text, or binary starting with the PSBT magic bytes. */
export async function readPsbtFile(io: CliIo, file: string): Promise<string> {
  const bytes = await readBounded(resolveIn(io, file), file);
  if (bytes.subarray(0, 5).equals(Buffer.from("70736274ff", "hex"))) return base64.encode(bytes);
  return bytes.toString("utf8").trim();
}

/** Replace CLI state (the session cache, a pending deposit) atomically and durably, owner-only. */
function writePrivateAtomically(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, "wx", PRIVATE);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const directory = openSync(path.dirname(file), "r", PRIVATE);
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
/** Signed deposits waiting for the miner, one owner-only file per vault. */
export function filePendingDeposits(home: string): PendingDeposits {
  const file = (vaultId: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(vaultId)) throw new UsageError("Invalid vault id.");
    return path.join(home, "pending-deposits", `${vaultId.toLowerCase()}.json`);
  };
  return {
    async get(vaultId) {
      try {
        return JSON.parse((await readBounded(file(vaultId), "The pending deposit")).toString("utf8")) as PendingDeposit;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    set: async (vaultId, deposit) => writePrivateAtomically(file(vaultId), JSON.stringify(deposit)),
    delete: (vaultId) => rm(file(vaultId), { force: true }),
  };
}
