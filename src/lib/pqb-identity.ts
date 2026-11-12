import source from "../pqb-core/provenance.json";

export const PQB_PROTOCOL = "pqb-v1" as const;
export const PQB_GENERATOR_COMMIT = source.commit;
export const PQB_SEARCH_VERSION = "pqb-ranked-v2" as const;
