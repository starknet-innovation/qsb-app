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
5. Separately register an immutable AWS Batch job-definition revision using the
   enrolled digest, and configure its exact ARN in the deployment. Before every
   paid submission, Batch preflight verifies the image, queue and compute limits.
   A canonical GHCR image may be mirrored at the same digest into the queue's
   account/region `qsb-solver` ECR repository. Different digests, tags or arbitrary
   aliases fail closed before input upload and the paid intent. Preserve the
   attested manifest digest when copying; index and platform digests are distinct.
   This is control-plane consistency, not runtime attestation. Selecting a
   descriptor does not reconfigure Batch or publish an image.

The browser shows the deployment-selected release. New withdrawal requests default
to that served ID; an explicit different ID is refused before reservations. The
server freezes that descriptor in the job. Existing vaults are bound to
protocol/generator, not a solver, and existing jobs retain their original pin.
Build with `--solver-release=RELEASE_ID` to record the producer image/source
identity alongside the CPU artifact in `terraform/.build/manifest.json`; deployment
must select the same ID. An unconfigured build serves no solver. Archived pins
continue to verify without being selected for new paid work. Imported optimized research remains HOLD and subset-only;
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

The schema 3 producer update is [qsb-solver PR #3](https://github.com/starknet-innovation/qsb-solver/pull/3). The verified AWS release is enrolled below; the earlier v0.1.0 descriptor remains inspection-only.

New job admission requires the explicit deployment `SOLVER_RELEASE_ID` (Terraform
`solver_release_id`) shared by API and coordinator. Requests omitting a solver
select that served release. A mismatched explicit request, missing configuration,
unbound external descriptor or archived placeholder refuses before reservations.
Historical pins remain readable. The enrolled AWS release below is available for explicit build/deployment selection. An unconfigured deployment still refuses new jobs before reservations.

## AWS release enrollment: aws-v0.1.0

The verbatim [producer release asset](https://github.com/starknet-innovation/qsb-solver/releases/tag/aws-v0.1.0)
is enrolled as `src/lib/releases/qsb-solver-aws-v0-1-0.json`. Its ID, canonical
image digest and solver source commit are read from that file, not duplicated in
deployment configuration. The historical descriptor and published v0.1.0 remain unchanged.
The producer's [tag build](https://github.com/starknet-innovation/qsb-solver/actions/runs/36139077364)
selects the AWS target and `sm_86`. GitHub CLI provenance verification passed against
that release workflow, source commit and tag on 25 September 2026. An anonymous GHCR manifest fetch also matched the enrolled digest, confirming public registry access:

```sh
gh attestation verify "oci://$(node -p 'require("./src/lib/releases/qsb-solver-aws-v0-1-0.json").image')" \
  --repo starknet-innovation/qsb-solver \
  --signer-workflow starknet-innovation/qsb-solver/.github/workflows/release.yml \
  --source-ref refs/tags/aws-v0.1.0 \
  --source-digest "$(node -p 'require("./src/lib/releases/qsb-solver-aws-v0-1-0.json").solverCommit')" \
  --deny-self-hosted-runners
gh release download aws-v0.1.0 -R starknet-innovation/qsb-solver -p solver.json -O - \
  | cmp - src/lib/releases/qsb-solver-aws-v0-1-0.json
```

Build the app with the descriptor's ID as `--solver-release` to generate the
CPU/solver deployment identities. This enrollment does not select a live solver,
copy an image to an operator account, enable mainnet, or certify a fresh full
search/withdrawal. Those remain separate deployment and execution steps.
