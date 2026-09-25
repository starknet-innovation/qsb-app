# App / solver boundary

Issue #35 separates GPU work from custody and independent verification.
The solver source and build pipeline are in https://github.com/starknet-innovation/qsb-solver.
The app retains its coordinator, release registry, QSB generator, and worker/cpu.
No CUDA fetch or compiler is needed by npm run vendor, tests, frontend or Lambda packaging.

The GPU receives only public parameters, returns untrusted hits, and can waste
compute by omitting work. The app independently verifies each hit with worker/cpu;
a digest or provenance attestation identifies an image but does not prove its
arithmetic or complete range coverage. Mainnet and broadcast flags are unchanged.

## Contract and enrollment

Both repos carry contracts/ranked-v2.json. Their independent TypeScript and Python
partitioners check every valid and rejected vector. The solver release publishes
that same file. A changed partition needs a new searchVersion and coordinated app
support; it must never be silently presented as ranked-v2.

A tagged solver release builds the historical two-stage worker on native Linux,
publishes its GHCR digest and GitHub provenance, and attaches solver.json plus the
contract. Before enrollment:

1. Verify provenance against starknet-innovation/qsb-solver and the exact tag commit.
2. Require schemaVersion 3 and `searchContract`, the SHA-256 of canonical sorted-key compact JSON from `contracts/ranked-v2.json`. The producer derives it after checking its valid/rejected vectors; the app registry independently compares it with `fingerprint()` of its imported contract before enrollment. Run both suites.
3. Copy solver.json as a new JSON descriptor in src/lib/releases; never edit the
   archived qsb-config-a-ranked-v2.json. It is retained byte-for-byte.
4. Run the registry generator, tests and package build. Generated imports support
   both Vite and the Lambda bundle; the app needs no CUDA source hashes.
5. Separately configure the existing Runpod endpoint with that exact image digest.
   This is deployment configuration, not a change to application code. Selecting
   a descriptor does not change the endpoint's image or attest its live filesystem.
   Before every paid submission, the coordinator passes the job's pinned image to
   the Runpod cap preflight. The REST v2 endpoint response must confirm that exact
   immutable `image` reference as well as limits. Missing, tagged or different
   images fail closed before the paid intent; equal kernelCommit is insufficient.
   This is control-plane consistency, not cryptographic runtime attestation: do not
   change endpoint configuration while jobs are active. Index versus platform
   manifest digests and registry aliases are not treated as equivalent.

Withdrawal selection can name solverReleaseId; the browser lists registered
releases and the server freezes the chosen descriptor in the job. Existing vaults
are bound to protocol/generator, not a solver. Existing jobs retain their original
pin. The historical descriptor remains the default until an operator deliberately
selects a new release. Imported optimized research remains HOLD and subset-only;
it cannot replace the two-stage pipeline through a descriptor.

## Historical evidence

Past reports may mention paths now moved to the solver repo. They record prior
source/build experiments, not current app prerequisites or new image attestations.
Parked supervised archives remain historical snapshots; their embedded wrappers
are not the live coordinator and are not a second solver build route.
CUDA sources and build/validation tooling moved to the solver repository.
Historical app source-audit checks were removed; their removal does not certify
the optimized candidate. App coverage-accounting tests and independent CPU
comparison tests remain here.

The maintainer confirmed compiled-binary redistribution approval in the [25 September decision](https://github.com/starknet-innovation/qsb-app/pull/47#issuecomment-5829603150). This records that confirmation, not an independent legal opinion. The solver
repo retains upstream notices and licenses. No funded fixture, GPU allocation,
production deployment or mainnet submission is part of this extraction.

## First external release

[v0.1.0](https://github.com/starknet-innovation/qsb-solver/releases/tag/v0.1.0)
was built by [release run 36113649324](https://github.com/starknet-innovation/qsb-solver/actions/runs/36113649324)
from commit `d72fb4fca0b684501f3db4038dcbc105ead6c117`.
The exact released descriptor is `src/lib/releases/qsb-solver-v0-1-0.json`.
Its image is:

```
ghcr.io/starknet-innovation/qsb-solver@sha256:badfcac297db6c242cf0e91e78fe294fa900d3c59f363258ec6d0d502162c755
```

GitHub build provenance verification passed with the repository, release workflow,
tag ref and exact source commit constrained:

```sh
gh attestation verify oci://ghcr.io/starknet-innovation/qsb-solver@sha256:badfcac297db6c242cf0e91e78fe294fa900d3c59f363258ec6d0d502162c755 \
  --repo starknet-innovation/qsb-solver \
  --signer-workflow starknet-innovation/qsb-solver/.github/workflows/release.yml \
  --source-ref refs/tags/v0.1.0 \
  --source-digest d72fb4fca0b684501f3db4038dcbc105ead6c117
```

The public OCI index, Linux amd64 manifest and config were anonymously readable
and their bytes matched their digests. Released range vectors matched the app's
contract byte-for-byte. The release builds the historical two-stage worker; it
is not an optimized-candidate promotion or a new GPU/end-to-end proof. Registration
leaves the default, deployed endpoint, mainnet and broadcast settings unchanged.

The published v0.1.0 schemaVersion 2 descriptor remains byte-identical for historical
job inspection. Its missing contract binding now refuses **new paid submissions**.
It is not silently upgraded. A new producer release and separately reviewed verbatim
enrollment are required before that external solver can run. The archived app
descriptor/default also remains byte-identical; its placeholder image is not a
deployable release and fails the endpoint image check against a real deployment.

The schema 3 producer update is [qsb-solver PR #3](https://github.com/starknet-innovation/qsb-solver/pull/3); it has not published a replacement release. No future digest or descriptor is invented here.
