/**
 * Refuses a value that carries credential-shaped keys or values: private-key blocks, AWS
 * access key ids, or fields named like secrets. judgeInclusionEvidence runs it before
 * reading inclusion evidence.
 */
const forbiddenKeys = new Set([
  "apikey",
  "apisecret",
  "secret",
  "secretstring",
  "password",
  "passphrase",
  "privatekey",
  "authorization",
  "mnemonic",
  "seed",
  "walletbackup",
  "token",
  "accesstoken",
  "accesskey",
  "accesskeyid",
  "secretaccesskey",
  "awsaccesskeyid",
  "awssecretaccesskey",
  "sessiontoken",
  "securitytoken",
  "refreshtoken",
  "credential",
  "credentials",
]);
const privateKeyPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const awsAccessKeyPattern = /A(?:K|S)IA[0-9A-Z]{16}/;
const sensitiveStems = [
  "secret",
  "password",
  "passphrase",
  "token",
  "credential",
  "mnemonic",
  "privatekey",
  "apikey",
  "accesskey",
  "authorization",
];
/** Public identifiers whose names end in "key" and are not secret material. */
const nonSecretKeyNames = new Set([
  "idempotencykey",
  "publickey",
  "helperpublickey",
]);

function credentialKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sensitiveFieldName(key: string): boolean {
  const normalized = credentialKey(key);
  if (forbiddenKeys.has(normalized)) return true;
  if (sensitiveStems.some((stem) => normalized.includes(stem))) return true;
  return normalized.endsWith("key") && !nonSecretKeyNames.has(normalized);
}

export function assertNoCredentialMaterial(value: unknown, label = "value"): void {
  if (typeof value === "string") {
    if (privateKeyPattern.test(value) || awsAccessKeyPattern.test(value))
      throw new Error(`CredentialMaterialRejected:${label}`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveFieldName(key))
      throw new Error(`CredentialMaterialRejected:${label}.${key}`);
    assertNoCredentialMaterial(child, `${label}.${key}`);
  }
}
