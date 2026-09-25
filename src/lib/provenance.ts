import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import archived from "./releases/qsb-config-a-ranked-v2.json";
import { z } from "zod";
import externalDescriptors from "./releases/registry.generated";

export const externalSolverDescriptorSchema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
    protocol: z.literal("qsb-config-a-v1"),
    generatorCommit: z.literal("2c9172051d5c150ef0a994ca6b988a08a3ef9e85"),
    searchVersion: z.literal("ranked-v2"),
    solverRepository: z.literal(
      "https://github.com/starknet-innovation/qsb-solver",
    ),
    solverCommit: z.string().regex(/^[a-f0-9]{40}$/),
    // Wire identity is separate from the external repository's release commit.
    kernelCommit: z.string().regex(/^[a-f0-9]{40}$/),
    image: z
      .string()
      .regex(/^ghcr\.io\/starknet-innovation\/qsb-solver@sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type SolverDescriptor =
  typeof archived | z.infer<typeof externalSolverDescriptorSchema>;
export function solverRegistry(descriptors: unknown[]) {
  const registry = new Map<string, string>([
    [archived.id, canonical(archived)],
  ]);
  for (const input of descriptors) {
    const descriptor = externalSolverDescriptorSchema.parse(input);
    if (registry.has(descriptor.id)) throw new Error("DuplicateSolverRelease");
    registry.set(descriptor.id, canonical(descriptor));
  }
  return registry;
}

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
const registry = solverRegistry(externalDescriptors);
export const currentSolverId = archived.id;
export function solverRelease(id: string): SolverDescriptor {
  const json = registry.get(id);
  if (!json) throw new Error("UnsupportedSolverRelease");
  return JSON.parse(json) as SolverDescriptor;
}
export function solverReleases(): SolverDescriptor[] {
  return [...registry.keys()].map(solverRelease);
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
export function pinSolver(
  v: VaultInput & { configuration?: unknown },
  solverId = currentSolverId,
) {
  const configuration = assertVaultConfiguration(v);
  if (v.config !== "A") throw new Error("UnsupportedVaultProtocol");
  const descriptor = solverRelease(solverId);
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
