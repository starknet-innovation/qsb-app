import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import archived from "./releases/qsb-config-a-ranked-v2.json";

// Append releases; never edit an archived descriptor or resolve through 'latest'.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown) =>
  bytesToHex(sha256(new TextEncoder().encode(canonical(value))));
const archivedJson = canonical(archived);
export const currentSolverId = archived.id;
export function solverRelease(id: string) {
  if (id !== archived.id) throw new Error("UnsupportedSolverRelease");
  return JSON.parse(archivedJson) as typeof archived;
}
type VaultInput = {
  network?: string;
  config: string;
  scriptHex: string;
  scriptHash: string;
  publicStateJson: string;
};
export function vaultConfiguration(v: VaultInput) {
  if (v.config !== "A") throw new Error("UnsupportedVaultProtocol");
  if (typeof v.network !== "string" || v.network === "")
    throw new Error("Unsupported QSB network configuration");
  const network = v.network;
  return {
    protocol: "qsb-config-a-v1" as const,
    generatorCommit: "2c9172051d5c150ef0a994ca6b988a08a3ef9e85" as const,
    network,
    config: "A" as const,
    scriptHash: v.scriptHash,
    scriptBytesHash: bytesToHex(
      sha256(
        Uint8Array.from(v.scriptHex.match(/../g) ?? [], (x) => parseInt(x, 16)),
      ),
    ),
    publicStateHash: fingerprint(JSON.parse(v.publicStateJson)),
  };
}
export function assertVaultConfiguration(
  v: VaultInput & { configuration?: unknown },
) {
  const expected = vaultConfiguration(v);
  if (expected.scriptBytesHash !== v.scriptHash)
    throw new Error("VaultScriptHashMismatch");
  if (v.configuration && canonical(v.configuration) !== canonical(expected))
    throw new Error("VaultConfigurationMismatch");
  return expected;
}
export function pinSolver(v: VaultInput & { configuration?: unknown }) {
  const configuration = assertVaultConfiguration(v);
  if (v.config !== "A") throw new Error("UnsupportedVaultProtocol");
  const descriptor = solverRelease(currentSolverId);
  return {
    descriptor,
    releaseHash: fingerprint(descriptor),
    vaultConfigurationHash: fingerprint(configuration),
  };
}
export type SolverPin = ReturnType<typeof pinSolver>;
export function assertSolverPin(
  pin: SolverPin,
  v: VaultInput & { configuration?: unknown },
) {
  const descriptor = solverRelease(pin.descriptor.id);
  if (
    canonical(pin.descriptor) !== canonical(descriptor) ||
    pin.releaseHash !== fingerprint(descriptor)
  )
    throw new Error("SolverReleaseMismatch");
  if (pin.vaultConfigurationHash !== fingerprint(assertVaultConfiguration(v)))
    throw new Error("SolverVaultMismatch");
  return descriptor;
}
