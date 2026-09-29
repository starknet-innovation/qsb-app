import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import { createHash } from "node:crypto";
import { base64 } from "@scure/base";
import { NETWORK_ID } from "../src/lib/network";
import type { PendingDeposit, PendingDeposits } from "./client";
import type { Signer } from "./signer";

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

/** A recovery passphrase from a file descriptor, QSB_PASSPHRASE or a terminal prompt. Never argv. */
export async function readPassphrase(
  io: CliIo,
  prompts: Prompter,
  fd: string | undefined,
  confirm: boolean,
): Promise<string> {
  if (fd !== undefined) {
    if (!/^\d+$/.test(fd)) throw new UsageError("--passphrase-fd takes a file descriptor number.");
    return readFileSync(Number(fd), "utf8").replace(/\r?\n$/, "");
  }
  if (io.env.QSB_PASSPHRASE !== undefined) return io.env.QSB_PASSPHRASE;
  if (!io.interactive)
    throw new UsageError(
      "Give the recovery passphrase on a terminal, with --passphrase-fd <n> or in QSB_PASSPHRASE. It is never read from arguments.",
    );
  const passphrase = await prompts.line("Recovery passphrase: ", true);
  if (confirm && (await prompts.line("Repeat the recovery passphrase: ", true)) !== passphrase)
    throw new UsageError("The passphrases do not match.");
  return passphrase;
}

const resolveIn = (io: CliIo, file: string) => path.resolve(io.cwd, file);

/** Refuse early, before any work, when a backup would land on an existing file. */
export function assertNewFile(io: CliIo, file: string | undefined): void {
  if (file !== undefined && existsSync(resolveIn(io, file)))
    throw new UsageError(`${file} already exists. Backups are never overwritten; choose a new path.`);
}
/** Write a private file (a backup) owner-only, never over an existing file, then read it back. */
export async function writeNewPrivateFile(io: CliIo, file: string, text: string): Promise<void> {
  const target = resolveIn(io, file);
  try {
    await writeFile(target, text, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new UsageError(`${file} already exists. Backups are never overwritten; choose a new path.`);
    throw error;
  }
  if ((await readFile(target, "utf8")) !== text) throw new Error(`${file} did not save correctly.`);
}
/** Write a public file (an unsigned PSBT, a signed transaction). */
export async function writePublicFile(io: CliIo, file: string, text: string): Promise<string> {
  const target = resolveIn(io, file);
  await writeFile(target, text);
  return target;
}
export async function readTextFile(io: CliIo, file: string): Promise<string> {
  const target = resolveIn(io, file);
  if ((await stat(target)).size > 4000000) throw new UsageError(`${file} is too large.`);
  return readFile(target, "utf8");
}
/** A PSBT file as base64: base64 text, or binary starting with the PSBT magic bytes. */
export async function readPsbtFile(io: CliIo, file: string): Promise<string> {
  const target = resolveIn(io, file);
  if ((await stat(target)).size > 4000000) throw new UsageError(`${file} is too large.`);
  const bytes = await readFile(target);
  if (bytes.subarray(0, 5).equals(Buffer.from("70736274ff", "hex"))) return base64.encode(bytes);
  return bytes.toString("utf8").trim();
}

/**
 * The default signer: it hands each request to the person or another tool
 * (a hardware wallet through Sparrow or HWI, for example) and reads the
 * signature back. Challenges go to stderr (and --message-out); PSBTs go to a
 * file. Keys never pass through this process.
 */
export function externalSigner(
  io: CliIo,
  prompts: Prompter,
  identity: { address: string; publicKey: string },
  files: { messageOut?: string; psbtOut?: string; signedPsbt?: string },
): Signer {
  return {
    address: identity.address,
    publicKey: identity.publicKey,
    async signMessage(address, message) {
      if (files.messageOut) await writePublicFile(io, files.messageOut, message);
      io.stderr.write(
        `Sign this message with BIP-322 for ${address}. It signs in for one hour and authorizes no transaction.\n-----\n${message}\n-----\n`,
      );
      return (await prompts.line("BIP-322 signature (base64): ")).trim();
    },
    async signPsbt(address, psbt, inputs) {
      const name =
        files.psbtOut ??
        `qsb-unsigned-${createHash("sha256").update(psbt).digest("hex").slice(0, 12)}.psbt`;
      const written = await writePublicFile(io, name, `${psbt}\n`);
      io.stderr.write(
        `Unsigned PSBT written to ${written}. Sign input ${inputs.join(", ")} with ${address}'s key. Do not finalize into a broadcast; nothing is sent until you approve it here.\n`,
      );
      if (files.signedPsbt) return readPsbtFile(io, files.signedPsbt);
      if (!io.interactive)
        throw new SignatureNeeded(`Sign ${written}, then re-run this command with --signed-psbt <file>.`);
      const answer = (await prompts.line("Signed PSBT (file path or base64): ")).trim();
      return existsSync(resolveIn(io, answer)) ? readPsbtFile(io, answer) : answer;
    },
  };
}

type CachedSession = {
  format: "qsb-cli-session-v1";
  api: string;
  network: string;
  address: string;
  token: string;
  expiresAt: number;
};
const sessionPath = (home: string) => path.join(home, "session.json");
/** A cached bearer token for this API, network and address, if still fresh and owner-only. */
export async function loadSession(home: string, api: string, address: string): Promise<string | undefined> {
  try {
    const file = sessionPath(home);
    if ((await stat(file)).mode & 0o077) return undefined;
    const cached = JSON.parse(await readFile(file, "utf8")) as CachedSession;
    if (
      cached.format !== "qsb-cli-session-v1" ||
      cached.api !== api ||
      cached.network !== NETWORK_ID ||
      cached.address !== address ||
      !/^[A-Za-z0-9_-]{43}$/.test(cached.token) ||
      !(cached.expiresAt > Date.now() / 1000)
    )
      return undefined;
    return cached.token;
  } catch {
    return undefined;
  }
}
async function writePrivateAtomically(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}
/** Sessions last an hour on the server; the cache gives up five minutes early. */
export async function saveSession(home: string, api: string, address: string, token: string) {
  const cached: CachedSession = {
    format: "qsb-cli-session-v1",
    api,
    network: NETWORK_ID,
    address,
    token,
    expiresAt: Math.floor(Date.now() / 1000) + 3300,
  };
  await writePrivateAtomically(sessionPath(home), JSON.stringify(cached));
}
export async function clearSession(home: string) {
  await rm(sessionPath(home), { force: true });
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
        return JSON.parse(await readFile(file(vaultId), "utf8")) as PendingDeposit;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    set: (vaultId, deposit) => writePrivateAtomically(file(vaultId), JSON.stringify(deposit)),
    delete: (vaultId) => rm(file(vaultId), { force: true }),
  };
}
