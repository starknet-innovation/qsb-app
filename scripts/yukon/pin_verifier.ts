/** Fixed fresh-process CPU runner for the research Store bridge; no live enrollment. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import lock from "./pin_verifier_lock.json";
const root = fileURLToPath(new URL("../../", import.meta.url));

// Paths are trusted launcher configuration, not fields in any public request.
function createRunner(repo = root, python = "python3") {
  return async (event: unknown): Promise<unknown> => {
    const directory = path.join(repo, "scripts/yukon");
    for (const [name, want] of Object.entries(lock)) {
      const filename = path.join(directory, name);
      if (
        lstatSync(filename).isSymbolicLink() ||
        createHash("sha256").update(readFileSync(filename)).digest("hex") !==
          want
      )
        throw Error("Unenrolled CPU verifier artifact");
    }
    if (
      !readFileSync(path.join(directory, "pin_verifier_lock.json")).equals(
        Buffer.from(JSON.stringify(lock, null, 2) + "\n"),
      )
    )
      throw Error("CPU verifier lock differs");
    const input = JSON.stringify(event);
    if (Buffer.byteLength(input) > 2000000)
      throw Error("Oversized public verification");
    const script = path.join(directory, "pin_verify_cli.py");
    const code = readFileSync(script, "utf8");
    return new Promise((resolve, reject) => {
      const child = spawn(
        python,
        ["-I", "-c", "import sys; __file__=sys.argv[1];\n" + code, script],
        {
          cwd: repo,
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
        stop();
        reject(Error("CPU verifier launch failed"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
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
