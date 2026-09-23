import { assertVaultConfiguration } from "./provenance";
import {
  recoverySchema,
  withdrawalSchema,
  type Recovery,
  type Job,
} from "./model";
import { z } from "zod";
const envelopeSchema = z
  .object({
    format: z.literal("qsb-encrypted-v1"),
    kdf: z.literal("PBKDF2-SHA256"),
    iterations: z.literal(600000),
    salt: z.string().max(32),
    iv: z.string().max(24),
    ciphertext: z.string().max(250000),
  })
  .strict();
const enc = new TextEncoder();
const b64 = (a: Uint8Array) =>
  btoa(Array.from(a, (x) => String.fromCharCode(x)).join(""));
const unb64 = (s: string) => Uint8Array.from(atob(s), (x) => x.charCodeAt(0));
async function key(password: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 600000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
// A restored withdrawal backup remains bound to its first authorization even
// on a fresh device, where the optional localStorage reminder does not exist.
export async function assertRecoveryAuthorization(
  recovery: Recovery,
  expectedManifestHash?: string,
): Promise<void> {
  if (recovery.vault.configuration) assertVaultConfiguration(recovery.vault);
  const intent = recovery.authorization;
  if (!intent) return;
  if (intent.assembly)
    solutionSchema.parse(JSON.parse(intent.assembly.solutionJson));
  const manifest = withdrawalSchema.parse(JSON.parse(intent.manifestJson));
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", enc.encode(intent.manifestJson)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== intent.manifestHash || manifest.vaultId !== recovery.vault.id)
    throw new Error("The backup withdrawal authorization is inconsistent.");
  if (expectedManifestHash && expectedManifestHash !== intent.manifestHash)
    throw new Error(
      "This backup already authorizes another withdrawal. Resume the original intent; do not reuse its one-time keys.",
    );
}
export async function encryptRecovery(
  recovery: Recovery,
  password: string,
): Promise<string> {
  if (password.length < 14)
    throw new Error("Use a recovery passphrase of at least 14 characters.");
  recoverySchema.parse(recovery);
  await assertRecoveryAuthorization(recovery);
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode("qsb-encrypted-v1") },
    await key(password, salt),
    enc.encode(JSON.stringify(recovery)),
  );
  return JSON.stringify(
    {
      format: "qsb-encrypted-v1",
      kdf: "PBKDF2-SHA256",
      iterations: 600000,
      salt: b64(salt),
      iv: b64(iv),
      ciphertext: b64(new Uint8Array(ciphertext)),
    },
    null,
    2,
  );
}
export async function decryptRecovery(
  text: string,
  password: string,
): Promise<Recovery> {
  if (text.length > 260000) throw new Error("Recovery file is too large.");
  try {
    const e = envelopeSchema.parse(JSON.parse(text));
    const salt = unb64(e.salt),
      iv = unb64(e.iv);
    if (salt.length !== 16 || iv.length !== 12) throw new Error();
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode(e.format) },
      await key(password, salt),
      unb64(e.ciphertext),
    );
    const recovery = recoverySchema.parse(
      JSON.parse(new TextDecoder().decode(plain)),
    );
    await assertRecoveryAuthorization(recovery);
    return recovery;
  } catch {
    throw new Error(
      "Unable to unlock this backup. Check the file and passphrase.",
    );
  }
}
export function downloadBackup(contents: string, id: string) {
  const url = URL.createObjectURL(
    new Blob([contents], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `qsb-recovery-${id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const indices = z
  .array(z.number().int().min(0).max(149))
  .length(9)
  .refine(
    (values) => new Set(values).size === values.length,
    "Duplicate HORS index",
  );
const solutionSchema = z
  .object({
    sequence: z.number().int().min(0).max(0xffffffff),
    locktime: z.number().int().min(0).max(0xffffffff),
    round1: indices,
    round2: indices,
  })
  .strict();
async function assemblyCommitment(
  solution: NonNullable<Job["solution"]>,
  rawTxHex: string,
) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(rawTxHex))
    throw new Error("Invalid assembled transaction.");
  const bytes = Uint8Array.from(rawTxHex.match(/../g)!, (byte) =>
    parseInt(byte, 16),
  );
  const rawTxHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    solutionJson: JSON.stringify(solutionSchema.parse(solution)),
    rawTxHash,
  };
}
export async function bindRecoveryAssembly(
  recovery: Recovery,
  solution: NonNullable<Job["solution"]>,
  rawTxHex: string,
): Promise<Recovery> {
  await assertRecoveryAuthorization(recovery);
  if (!recovery.authorization)
    throw new Error("Save the withdrawal intent first.");
  const assembly = await assemblyCommitment(solution, rawTxHex);
  const previous = recovery.authorization.assembly;
  if (
    previous &&
    (previous.solutionJson !== assembly.solutionJson ||
      previous.rawTxHash !== assembly.rawTxHash)
  )
    throw new Error(
      "This backup already binds another QSB solution. Reuse the original authorization.",
    );
  return {
    ...recovery,
    authorization: { ...recovery.authorization, assembly },
  };
}
export async function assertRecoveryAssembly(
  recovery: Recovery,
  solution: NonNullable<Job["solution"]>,
  rawTxHex: string,
): Promise<void> {
  if (!recovery.authorization?.assembly)
    throw new Error("Restore the updated assembly backup before signing.");
  await bindRecoveryAssembly(recovery, solution, rawTxHex);
}
