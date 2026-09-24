# Public source build validation — 24 September 2026

The optimized solver and Linux supervisor can now be built from a clean public checkout. Neither the historical sealed archive `18421ac0…` nor an externally supplied solver binary is required as a build input.

Tested source commit: `4763c70dafa76c717f7d0a27e386523bab62049f`.
[Successful clean-checkout GitHub Actions run](https://github.com/starknet-innovation/qsb-app/actions/runs/35983194673).

## What passed

- Native Linux x86_64 compilation of the committed optimized CUDA source with NVIDIA nvcc 12.8.93, sm89, and the locked generic flags.
- Runtime image construction and four real offline checks: description, runtime identity rejection, solver identity rejection, and compiled solver failure without a GPU. Failure never receives completed-range credit.
- Runpod queue image construction with 90 exact Python 3.10 dependency wheels, SHA256 verification and `pip check`.
- Supervisor distribution built from tracked source and the npm lockfile; two builds produced identical archives. Installer verification accepted the package and rejected an altered file.
- Separately, 153 application tests, typecheck, Terraform artifact preparation and seven Terraform mock tests passed locally. These are not infrastructure deployment tests.

The supervisor archive also matched the same hash when built from the public GitHub source archive on the temporary native Linux validation host. That host was stopped after validation; its installed runtime was not replaced.

## Output identities

| Artifact | SHA256 |
| --- | --- |
| Optimized solver binary | `6d46cec4ddfebeb94993a9aad26a8506668b7b23b6d2d3f0214a6a77272586d6` |
| Supervisor archive | `4ed13bb96e5ce5118e2cddd0b895a73b3d33d90e4dbd2ce90e4c32641f4128eb` |
| Supervisor manifest | `2f389c54d15a1a30644fe8cbaca58e52ee0b1b1f8b6fb2b7bc77b44f2544635a` |

The [solver receipt](solver-build-receipt.json) records compiler, flags, OS package versions, source lock and newly generated runtime/release identities. The workflow uploads the supervisor archive, manifest and receipt as a temporary CI artifact; the repository retains the recipe and receipt. Generated archives are not committed.

## Build it

On native x86_64 Linux with Docker and Node 22:

```sh
npm ci
npm run build:runtime
npm run test:runtime-build
npm run build:optimized
npm run test:optimized-image
npm run build:optimized:queue
```

See [worker instructions](../../../worker/optimized/README.md) and [supervisor instructions](../../../supervised/runtime/README.md). Compilation does not require a GPU or Runpod credentials. Successful solver execution does require a compatible NVIDIA GPU/driver.

## Remaining boundaries

This validates public source packaging and CPU-host compilation, not a release rollout. No image was pushed, endpoint activated, GPU allocated or transaction spent in this build validation. The generated release remains HOLD and subset-only. Historical allowlists are not silently widened. Private Runpod credential provisioning remains separate.

Reviewed enrollment of this build's worker, CPU-reference, supervisor, and local OCI layout identities is `server/runtime/public-build-enrollment.ts`. It binds the hashes in this report, the CPU-reference files in the runtime binding, and the unpushed OCI index, config, and platform manifests from the `848751c` image export. It does not enroll archive `18421ac0…` or the historical solver pin. Commits after this build changed solver and supervisor source, so those identities are not a rebuild of that later tree. No registry manifest was pushed. Enrollment does not enable execution or close a fresh search.

The new binary is not the historically measured binary. Its successful compilation does not transfer earlier throughput, GPU correctness or full-withdrawal claims to it. Fresh GPU/integration and end-to-end gates remain on the [mainnet checklist](../../MAINNET-READINESS.md).

NVIDIA base manifests, CUDA flags, npm dependencies and Python wheels are pinned. Apt repositories are not snapshot-locked, so universal bit-for-bit OCI reproducibility is not claimed. Apple Silicon x86 emulation crashed nvcc in an earlier attempt; the successful native Linux run is the compilation evidence.
