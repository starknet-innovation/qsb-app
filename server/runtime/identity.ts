import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export function sha256Hex(bytes: Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(typeof bytes === "string" ? Buffer.from(bytes) : bytes);
  return hash.digest("hex");
}

export type WrapperCertification =
  | { ok: true }
  | {
      ok: false;
      reason: "wrapper-changed" | "native-not-enrolled" | "native-mismatch";
    };

/** A wrapper digest never inherits certification from an unchanged native digest. */
export function certifyWrapper(
  enrolled: { wrapperSha256: string; nativeSha256: string | null },
  presented: { wrapperBytes: Uint8Array; nativeSha256: string | null },
): WrapperCertification {
  if (sha256Hex(presented.wrapperBytes) !== enrolled.wrapperSha256)
    return { ok: false, reason: "wrapper-changed" };
  if (enrolled.nativeSha256 === null || presented.nativeSha256 === null)
    return { ok: false, reason: "native-not-enrolled" };
  if (presented.nativeSha256 !== enrolled.nativeSha256)
    return { ok: false, reason: "native-mismatch" };
  return { ok: true };
}

export function assertInsideRepo(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.split(/[/\\]/).includes(".."))
    throw new Error("Release path escapes the checkout");
  const rootReal = realpathSync(root);
  const parts = relativePath.split(/[/\\]/).filter((part) => part && part !== ".");
  let current = rootReal;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      const lexical = path.resolve(rootReal, ...parts);
      if (lexical !== rootReal && !lexical.startsWith(rootReal + path.sep))
        throw new Error("Release path escapes the checkout");
      return lexical;
    }
    if (stat.isSymbolicLink())
      throw new Error("Release path escapes the checkout");
  }
  const real = realpathSync(current);
  if (real !== current || (real !== rootReal && !real.startsWith(rootReal + path.sep)))
    throw new Error("Release path escapes the checkout");
  return current;
}
