# App / solver boundary

GPU work is separate from custody and independent verification (#35). The solver source, image builds and provenance attestations live in [qsb-solver](https://github.com/starknet-innovation/qsb-solver). This app keeps the coordinator, the release registry, the QSB generator and the `worker/cpu` verifier. No CUDA source or compiler is needed by `npm run vendor`, the tests, the frontend or the Lambda packaging.

The GPU receives only public parameters, returns untrusted hits, and can waste compute by omitting work. The app verifies each hit independently with `worker/cpu`. A digest or provenance attestation identifies an image; it doesn't prove its arithmetic or complete range coverage.

## Enrolled releases

The descriptors in `src/lib/releases` (see [its README](../src/lib/releases/README.md)):

| Descriptor | Release | Use |
| --- | --- | --- |
| `qsb-solver-combined-aws-sm86-v0-2-0.json` | [`combined-aws-sm86-v0.2.0`](https://github.com/starknet-innovation/qsb-solver/releases/tag/combined-aws-sm86-v0.2.0), ID `qsb-ranked-v2-43c77084648a-e22afc720df1` | **Served.** The optimized subset kernel with the repaired pinning, from qsb-solver#2: the already tested image from source `43c77084…` (`candidate.yml`, tag `candidate-sm86-20260925-1`), not rebuilt. On an A10G, subset round 1 is about 31–32% faster than `aws-v0.1.0`, round 2 about 1.6–1.7%, and pinning unchanged. |
| `qsb-solver-aws-v0-1-0.json` | [`aws-v0.1.0`](https://github.com/starknet-innovation/qsb-solver/releases/tag/aws-v0.1.0) | The historical two-stage worker built for AWS (`sm_86`). Enrolled, not served. |
| `qsb-solver-v0-1-0.json` | [`v0.1.0`](https://github.com/starknet-innovation/qsb-solver/releases/tag/v0.1.0) | Schema 2, with no search-contract binding, so it is refused for new paid submissions. Kept byte-identical for inspecting jobs. |
| `qsb-config-a-ranked-v2.json` | archived | The descriptor from before the split. Its image names a placeholder account (`000000000000`) and is not deployable. Kept byte-identical; never edit it. |

Both AWS releases use the same protocol, generator commit and `ranked-v2` search contract, so vaults are unaffected by which one is served.

## Search contract

Both repositories carry `contracts/ranked-v2.json`. Their independent TypeScript and Python partitioners check every valid and rejected vector, and a solver release publishes the same file. A changed partition needs a new `searchVersion` and coordinated app support; it must never be presented as `ranked-v2`.

## Enrolling a release

A tagged qsb-solver release publishes a GHCR image by digest with GitHub build provenance, and attaches `solver.json` plus the contract. To enroll it:

1. Verify the provenance against `starknet-innovation/qsb-solver` and the exact tag commit, and that the release asset is the file you enroll (commands below).
2. Require `schemaVersion` 3 and `searchContract`: the SHA-256 of canonical sorted-key compact JSON of `contracts/ranked-v2.json`. The producer derives it after checking its vectors; the app registry independently compares it with `fingerprint()` of its own contract. Run both suites.
3. Copy `solver.json` verbatim as a new descriptor in `src/lib/releases`. Never edit an existing descriptor.
4. Run the registry generator (it runs before tests, typechecking and builds), the tests and a build, and commit the descriptor with the regenerated `registry.generated.ts`. No coordinator change is needed.

Enrolling a descriptor doesn't serve it, publish an image or change a job definition.

```sh
# combined-aws-sm86-v0.2.0
gh attestation verify "oci://$(node -p 'require("./src/lib/releases/qsb-solver-combined-aws-sm86-v0-2-0.json").image')" \
  --repo starknet-innovation/qsb-solver \
  --signer-workflow starknet-innovation/qsb-solver/.github/workflows/candidate.yml \
  --source-ref refs/tags/candidate-sm86-20260925-1 \
  --source-digest "$(node -p 'require("./src/lib/releases/qsb-solver-combined-aws-sm86-v0-2-0.json").solverCommit')" \
  --deny-self-hosted-runners
gh release download combined-aws-sm86-v0.2.0 -R starknet-innovation/qsb-solver -p solver.json -O - \
  | cmp - src/lib/releases/qsb-solver-combined-aws-sm86-v0-2-0.json

# aws-v0.1.0
gh attestation verify "oci://$(node -p 'require("./src/lib/releases/qsb-solver-aws-v0-1-0.json").image')" \
  --repo starknet-innovation/qsb-solver \
  --signer-workflow starknet-innovation/qsb-solver/.github/workflows/release.yml \
  --source-ref refs/tags/aws-v0.1.0 \
  --source-digest "$(node -p 'require("./src/lib/releases/qsb-solver-aws-v0-1-0.json").solverCommit')" \
  --deny-self-hosted-runners
gh release download aws-v0.1.0 -R starknet-innovation/qsb-solver -p solver.json -O - \
  | cmp - src/lib/releases/qsb-solver-aws-v0-1-0.json
```

## Serving a release

A deployment serves exactly one release, `SOLVER_RELEASE_ID` (Terraform `solver_release_id`), shared by the API and the coordinator:

1. Copy the image into the stack account's `qsb-solver` ECR repository with a digest-preserving registry copy, and check both registry digests match ([terraform/gpu/README.md](../terraform/gpu/README.md)).
2. Build the app with `--solver-release=RELEASE_ID`. The build records the image digest, solver commit and descriptor hash beside the CPU `reference.zip` digest in `terraform/.build/manifest.json`. Without `--solver-release`, no solver is served and new withdrawals are refused.
3. Apply the GPU stack with that manifest for a job-definition revision on the image, then set `solver_release_id` and `batch_job_definition` in the app stack and apply. Terraform rejects a `solver_release_id` that differs from the build. Serve each release through its own job-definition revision, never two releases through one.

Batch preflight accepts the descriptor's GHCR image, or the same digest in the `qsb-solver` ECR repository of the queue's own account and region. Different digests, accounts, regions, repositories and tags are refused before the public input is uploaded or anything is paid for. This is control-plane consistency, not runtime attestation, and index and platform digests are distinct: preserve the attested manifest digest when copying.

A withdrawal pins the served release when it is created, and the coordinator checks the image against that pin before each paid submission. A request that omits `solverReleaseId` gets the served release; a different ID is refused (`solver_not_served`) before any reservation. A vault binds only its protocol and generator, so a deposit can be made whatever is served. Don't change the served release or `batch_job_definition` while pinned withdrawals are still searching; see "Job-definition revision changes and recovery" in the [runbook](OPERATIONAL-RUNBOOK.md#job-definition-revision-changes-and-recovery).

## Checking hits locally

`ops/aws-gpu-migration/replay-positive-hits.ts` reads an external public signing bundle and passes mocked Batch/S3 completed results through the real Batch parser and the local CPU reference. Run `npm run vendor`, then:

```sh
npx tsx ops/aws-gpu-migration/replay-positive-hits.ts /path/to/public-signing-bundle.json
```

It never submits work, signs, broadcasts or credits ranges, and it doesn't copy the bundle into the repository. The recorded [replay evidence](../ops/aws-gpu-migration/positive-hit-replay.json) checks all three historical puzzle hits, malformed candidates, mismatched request and output hashes, and a changed subset locktime. Pinning candidates supply their own sequence and locktime, so that mutation isn't a pinning rejection test. These are real local cryptographic checks with mocked AWS transport, not a GPU search.

## Licensing

qsb-solver keeps the upstream notices and licenses that accompany its sources and images. The maintainer confirmed compiled-binary redistribution approval in the [25 September decision](https://github.com/starknet-innovation/qsb-app/pull/47#issuecomment-5829603150); that records the confirmation, not an independent legal opinion.
