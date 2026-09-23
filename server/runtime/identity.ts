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
  const absolute = path.resolve(rootReal, relativePath);
  if (absolute !== rootReal && !absolute.startsWith(rootReal + path.sep))
    throw new Error("Release path escapes the checkout");
  if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error("Release path escapes the checkout");
  return absolute;
}
