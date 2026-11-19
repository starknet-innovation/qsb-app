import source from "../pqb-core/provenance.json";

export const PQB_PROTOCOL = "pqb-v1" as const;
/** The vendored generator. It builds every construction listed in `source.constructions`. */
export const PQB_GENERATOR_COMMIT = source.commit;
export const PQB_SEARCH_VERSION = "pqb-ranked-v2" as const;
export type PqbConstruction = keyof typeof source.constructions;
/** Vaults made before constructions were versioned carry no version: they are v0. */
export const PQB_LEGACY_CONSTRUCTION: PqbConstruction = "v0";
/**
 * The upstream commit whose construction each version reproduces. A PQB vault's
 * `configuration.generatorCommit` is the one for its construction.
 */
export const PQB_CONSTRUCTION_COMMITS: Readonly<Record<PqbConstruction, string>> = source.constructions;
/**
 * Generator commits whose PQB vaults the same search solves: every construction has the same
 * stage shapes, and the CPU re-checks each hit against the vault's own script. A PQB solver
 * release naming any of them serves vaults of every construction.
 */
export const isPqbGeneratorCommit = (commit: string) =>
  Object.values(PQB_CONSTRUCTION_COMMITS).includes(commit);
/** A PQB public state's construction: its `version`, or v0 when it has none. */
export function pqbConstructionOf(publicState: unknown): PqbConstruction {
  const version = (publicState as { version?: unknown } | null)?.version ?? PQB_LEGACY_CONSTRUCTION;
  if (typeof version !== "string" || !Object.hasOwn(PQB_CONSTRUCTION_COMMITS, version))
    throw new Error("Unsupported PQB construction");
  return version as PqbConstruction;
}
