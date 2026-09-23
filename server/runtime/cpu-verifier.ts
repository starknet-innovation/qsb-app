import { spawn } from "node:child_process";
import path from "node:path";

export type CpuVerifierResult =
  | { ok: true; result: unknown; source: "worker/cpu/handler.py" }
  | { ok: false; error: string; source: "worker/cpu/handler.py" };

const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
from handler import handler
event = json.load(sys.stdin)
try:
    json.dump({"ok": True, "result": handler(event)}, sys.stdout)
except Exception as error:
    json.dump({"ok": False, "error": type(error).__name__ + ": " + str(error)}, sys.stdout)
`;

/** Runs the enrolled public CPU verifier. A rejection is not search success. */
export function runEnrolledCpuVerifier(
  root: string,
  event: unknown,
  timeoutMs = 20000,
): Promise<CpuVerifierResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      ["-c", script, path.join(root, "worker/cpu")],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CpuVerifierTimeout"));
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(new Error(stderr.trim() || `CpuVerifierExit:${code ?? "null"}`));
      else {
        const parsed = JSON.parse(stdout) as {
          ok: boolean;
          result?: unknown;
          error?: string;
        };
        resolve(
          parsed.ok
            ? { ok: true, result: parsed.result, source: "worker/cpu/handler.py" }
            : {
                ok: false,
                error: parsed.error ?? "CpuVerifierRejected",
                source: "worker/cpu/handler.py",
              },
        );
      }
    });
    child.stdin.end(JSON.stringify(event));
  });
}
