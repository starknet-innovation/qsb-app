# Solver descriptors

The archived `qsb-config-a-ranked-v2.json` is immutable historical evidence. Its old
source hashes are retained in that file, but app builds do not fetch or audit CUDA.
The default remains that historical release until an operator chooses another
registered compatible release at withdrawal.

For a new external release, copy the attested qsb-solver release's descriptor JSON
into this directory with a lowercase alphanumeric/hyphen filename. The generator
runs before tests, typechecking, builds and release packaging, producing static
imports in `registry.generated.ts`. Commit the descriptor and regenerated registry.
No coordinator code change is needed. The strict v3 descriptor identifies the
qsb-solver repository commit, immutable GHCR or enrolled QSB ECR image digest, generator protocol and
`ranked-v2` search contract; it contains no CUDA source hashes. Unsupported search
versions, mutable image tags, duplicate IDs and unknown fields are rejected.

The browser/API selects `solverReleaseId` at withdrawal. Omitting it preserves the
historical default. Each job freezes the full descriptor and its fingerprint;
resumed legacy jobs continue to identify the archived release explicitly. The CPU
verifier remains in this app and independently checks every reported GPU hit.

Before operating a selected release, configure the AWS Batch queue, revisioned job definition and S3 artifact bucket, and verify the release provenance and published range vectors. This is deployment configuration, separate from registering an app descriptor. The coordinator verifies the exact image digest, startup restrictions and compute limits before submission. A descriptor does not deploy or switch a job definition. Do not serve incompatible solver selections through one configured definition. Neither registration nor these tests enables mainnet or proves end-to-end mining.
