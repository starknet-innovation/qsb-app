import { createHash } from "node:crypto";

/** Process-local, single-use authority issued only after the durable intent. */
export type ExactSubmitPermit = Readonly<{ rawHash: string }>;
const live = new WeakSet<object>();
export const exactSubmitEnabled = () =>
  process.env.QSB_NETWORK === "mainnet" &&
  process.env.QSB_EXACT_SUBMIT_ENABLED === "true";
export function issueExactSubmitPermit(raw: string): ExactSubmitPermit {
  const permit = Object.freeze({
    rawHash: createHash("sha256").update(raw.toLowerCase()).digest("hex"),
  });
  live.add(permit);
  return permit;
}
export function isExactSubmitPermit(
  value: unknown,
): value is ExactSubmitPermit {
  return typeof value === "object" && value !== null && live.has(value);
}
export function consumeExactSubmitPermit(value: unknown, raw: string): void {
  if (!isExactSubmitPermit(value)) throw new Error("ExactSubmitPermitRequired");
  live.delete(value);
  if (
    value.rawHash !==
    createHash("sha256").update(raw.toLowerCase()).digest("hex")
  )
    throw new Error("ExactSubmitBytesChanged");
}
