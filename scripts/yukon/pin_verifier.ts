/** Fixed fresh-process CPU runner for the research Store bridge; no live enrollment. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  fstatSync,
  closeSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import lock from "./pin_verifier_lock.json";
const root = fileURLToPath(new URL("../../", import.meta.url));

// Open once without following the final symlink; hash and use the same bytes.
function snapshot(filename: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    if (!fstatSync(fd).isFile()) throw Error("Not a regular file");
    return readFileSync(fd);
  } catch {
    throw Error("Unenrolled CPU verifier artifact");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Paths are trusted launcher configuration, not fields in any public request.
function createRunner(repo = root, python = "python3") {
  return async (event: unknown): Promise<unknown> => {
    const directory = path.join(repo, "scripts/yukon");
    const sources = new Map<string, Buffer>();
    for (const [name, want] of Object.entries(lock)) {
      const raw = snapshot(path.join(directory, name));
      if (createHash("sha256").update(raw).digest("hex") !== want)
        throw Error("Unenrolled CPU verifier artifact");
      sources.set("scripts/yukon/" + name, raw);
    }
    const lockBytes = Buffer.from(JSON.stringify(lock, null, 2) + "\n");
    if (
      !snapshot(path.join(directory, "pin_verifier_lock.json")).equals(
        lockBytes,
      )
    )
      throw Error("CPU verifier lock differs");
    sources.set("scripts/yukon/pin_verifier_lock.json", lockBytes);
    const cpuLock = JSON.parse(
      sources.get("scripts/yukon/pin_reference_lock.json")!.toString("utf8"),
    ) as Record<string, string>;
    for (const [name, want] of Object.entries(cpuLock)) {
      if (!/^[a-zA-Z0-9_]+\.py$/.test(name))
        throw Error("Invalid CPU source name");
      const raw = snapshot(path.join(repo, "worker/cpu", name));
      if (createHash("sha256").update(raw).digest("hex") !== want)
        throw Error("Unenrolled CPU verifier artifact");
      sources.set("worker/cpu/" + name, raw);
    }
    const input = JSON.stringify(event);
    if (Buffer.byteLength(input) > 2000000)
      throw Error("Oversized public verification");
    // All later Python reads use this private closure, never the checked source tree.
    const isolated = mkdtempSync(path.join(tmpdir(), "qsb-enrolled-pin-"));
    try {
      for (const [name, raw] of sources) {
        const dest = path.join(isolated, name);
        mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        writeFileSync(dest, raw, { flag: "wx", mode: 0o400 });
      }
    } catch (error) {
      rmSync(isolated, { recursive: true, force: true });
      throw error;
    }
    const script = path.join(isolated, "scripts/yukon/pin_verify_cli.py");
    const code = sources
      .get("scripts/yukon/pin_verify_cli.py")!
      .toString("utf8");
    return new Promise((resolve, reject) => {
      const child = spawn(
        python,
        ["-I", "-c", "import sys; __file__=sys.argv[1];\n" + code, script],
        {
          cwd: isolated,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let failed = false,
        bytes = 0;
      const chunks: Buffer[] = [];
      const stop = () => {
        failed = true;
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* process already exited */
          }
      };
      const timer = setTimeout(stop, 90000);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1048576) stop();
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1048576) stop();
      });
      child.stdin.on("error", stop);
      child.on("error", () => {
        clearTimeout(timer);
        rmSync(isolated, { recursive: true, force: true });
        stop();
        reject(Error("CPU verifier launch failed"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        rmSync(isolated, { recursive: true, force: true });
        if (failed || code !== 0) {
          reject(Error("CPU verifier rejected result"));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(Error("Malformed CPU verdict"));
        }
      });
      child.stdin.end(input);
    });
  };
}

export function createPinVerifier(repo = root, python = "python3") {
  const run = createRunner(repo, python);
  return (
    request: unknown,
    output: unknown,
    context: unknown,
    expectedBinary: string,
  ) => run({ action: "verify", request, output, context, expectedBinary });
}
export function createPinHandoff(repo = root, python = "python3") {
  const run = createRunner(repo, python);
  return (context: unknown, candidate: unknown) =>
    run({ action: "handoff", context, candidate });
}

export function createPinPreflight(repo = root, python = "python3") {
  const run = createRunner(repo, python);
  return (request: unknown, context: unknown, expectedBinary: string) =>
    run({ action: "prepare", request, context, expectedBinary });
}
