import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Read a regular file without following a symlink at the final path.
 * The descriptor is opened with O_NOFOLLOW and then read, so the bytes
 * cannot be swapped onto a different inode after a separate stat.
 */
export function readNoFollow(file: string, label: string): Buffer {
  const descriptor = openNoFollow(file, label);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error(label);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function openNoFollow(file: string, label: string): number {
  try {
    return openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isNodeError(error, "ELOOP")) throw new Error(label);
    throw error;
  }
}
