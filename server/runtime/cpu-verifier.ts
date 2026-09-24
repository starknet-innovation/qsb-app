import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { componentForPath } from "./closure";
import { assertInsideRepo, sha256Hex } from "./identity";
import { componentIdentities } from "./package-release";
import { RELEASE_MANIFEST_FORMAT } from "./types";

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

const trustedManifestPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../release/source-manifest.json",
);

/** Refuse to label a run as enrolled unless the CPU sources match the trusted manifest. */
export function assertEnrolledCpuSources(root: string): void {
  const manifest = JSON.parse(readFileSync(trustedManifestPath, "utf8")) as {
    format: string;
    identities: {
      sourceFiles: Record<string, string>;
      components: Record<string, string>;
    };
  };
  if (manifest.format !== RELEASE_MANIFEST_FORMAT)
    throw new Error("CpuVerifierNotEnrolled");
  const enrolled: Record<string, string> = {};
  for (const [relativePath, digest] of Object.entries(manifest.identities.sourceFiles)) {
    if (componentForPath(relativePath) !== "cpu-verifier") continue;
    let actual: string;
    try {
      actual = sha256Hex(readFileSync(assertInsideRepo(root, relativePath)));
    } catch {
      throw new Error("CpuVerifierNotEnrolled");
    }
    if (actual !== digest) throw new Error("CpuVerifierNotEnrolled");
    enrolled[relativePath] = digest;
  }
  if (
    Object.keys(enrolled).length === 0 ||
    componentIdentities(enrolled)["cpu-verifier"] !==
      manifest.identities.components["cpu-verifier"]
  )
    throw new Error("CpuVerifierNotEnrolled");
}

/** Runs the enrolled public CPU verifier. A rejection is not search success. */
export async function runEnrolledCpuVerifier(
  root: string,
  event: unknown,
  timeoutMs = 20000,
): Promise<CpuVerifierResult> {
  assertEnrolledCpuSources(root);
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
