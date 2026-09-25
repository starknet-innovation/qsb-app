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
2. Compare the released range vectors with the app's contract and run both suites.
3. Copy solver.json as a new JSON descriptor in src/lib/releases; never edit the
   archived qsb-config-a-ranked-v2.json. It is retained byte-for-byte.
4. Run the registry generator, tests and package build. Generated imports support
   both Vite and the Lambda bundle; the app needs no CUDA source hashes.
5. Separately configure the existing Runpod endpoint with that exact image digest.
   This is deployment configuration, not a change to application code. Selecting
   a descriptor does not change the endpoint's image or attest its live filesystem.

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

The maintainer confirmed compiled-binary redistribution approval on 25 September
2026. This records that confirmation, not an independent legal opinion. The solver
repo retains upstream notices and licenses. No funded fixture, GPU allocation,
production deployment or mainnet submission is part of this extraction.
