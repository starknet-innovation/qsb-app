import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import archived from "./releases/qsb-config-a-ranked-v2.json";
import rebuilt from "./releases/qsb-config-a-ranked-v2-d28103b.json";

export type SolverRelease = {
  id: string;
  protocol: string;
  generatorCommit: string;
  kernelCommit: string;
  image: string;
  searchVersion: string;
  compiler: string;
  flags: { pinning: string[]; subset: string[] };
  sourceHashes: Record<string, string>;
};

// Append releases at the end. Never edit an archived descriptor or resolve through 'latest'.
const registry = [archived, rebuilt] as const;
export const archivedSolverId = archived.id;
export const currentSolverId = registry[registry.length - 1].id;

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
export function solverRelease(id: string): SolverRelease {
  const found = registry.find((release) => release.id === id);
  if (!found) throw new Error("UnsupportedSolverRelease");
  return JSON.parse(canonical(found)) as SolverRelease;
}
function newestRelease(protocol: string): SolverRelease {
  const found = [...registry]
    .reverse()
    .find((release) => release.protocol === protocol);
  if (!found) throw new Error("UnsupportedVaultProtocol");
  return JSON.parse(canonical(found)) as SolverRelease;
}
export function assertReleaseProtocol(
  descriptor: { protocol: string },
  configuration: { protocol: string },
) {
  if (descriptor.protocol !== configuration.protocol)
    throw new Error("SolverProtocolMismatch");
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
  return {
    protocol: "qsb-config-a-v1" as const,
    generatorCommit: "2c9172051d5c150ef0a994ca6b988a08a3ef9e85" as const,
    network: v.network ?? "mainnet",
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
  const descriptor = newestRelease(configuration.protocol);
  assertReleaseProtocol(descriptor, configuration);
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
  const configuration = assertVaultConfiguration(v);
  assertReleaseProtocol(descriptor, configuration);
  if (
    canonical(pin.descriptor) !== canonical(descriptor) ||
    pin.releaseHash !== fingerprint(descriptor)
  )
    throw new Error("SolverReleaseMismatch");
  if (pin.vaultConfigurationHash !== fingerprint(configuration))
    throw new Error("SolverVaultMismatch");
  return descriptor;
}
