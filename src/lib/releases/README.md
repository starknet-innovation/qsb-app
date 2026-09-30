# Solver descriptors

Each JSON file here is one solver release's descriptor, copied verbatim from its qsb-solver release. [docs/SOLVER-REPOSITORY.md](../../../docs/SOLVER-REPOSITORY.md) lists the enrolled releases and how to enroll and serve one.

To add a release, copy the attested release's `solver.json` into this directory with a lowercase alphanumeric/hyphen filename. `scripts/generate-solver-registry.mjs` runs before tests, typechecking and builds, and writes the static imports in `registry.generated.ts`. Commit the descriptor and the regenerated registry; no coordinator change is needed. A schema-3 descriptor names the qsb-solver commit, an immutable image digest, the generator protocol and the `ranked-v2` search contract, and no CUDA source hashes. Unsupported search versions, mutable image tags, duplicate IDs and unknown fields are rejected.

Never edit a descriptor once it is enrolled. The archived `qsb-config-a-ranked-v2.json` is kept byte-identical for inspecting old jobs; its image is a placeholder and not deployable.

A new withdrawal pins the release the deployment serves (`SOLVER_RELEASE_ID`, `server/solver-deployment.ts`), and the job freezes the full descriptor and its fingerprint. There is no historical fallback: an unconfigured deployment serves no solver. Registering a descriptor doesn't configure AWS Batch or switch a job definition, and the CPU verifier in this app still checks every reported GPU hit.
