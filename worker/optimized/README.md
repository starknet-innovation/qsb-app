# Build the optimized subset worker from this repository

From a clean checkout, with Docker on a native x86_64 Linux build host:

```sh
npm run build:optimized
npm run test:optimized-image
npm run build:optimized:queue
```

Compilation needs CPU, disk and network downloads, **not a GPU or Runpod account**. Docker Desktop x86 emulation on Apple Silicon may crash NVIDIA's compiler (observed exit139); use a native x86_64 builder for the compilation gate. Running the solver successfully still needs a compatible NVIDIA GPU/driver.

The multi-stage Dockerfile compiles `research/optimized-subset/subset/subset.cu` with CUDA12.8.1 and the exact generic sm89 flags recorded in `source-lock.json`. It rejects missing, additional or changed solver files. Both NVIDIA base images are pinned to public linux/amd64 manifest digests. No private ECR base, supplied solver binary, historical archive, developer workspace, wallet material or fixture is a build input.

The runtime target includes the newly compiled subset binary, guarded adapter and public CPU reference. It accepts one JSON request per process. The queue target adds Runpod SDK1.7.13, its version- and wheel-hash-locked Python dependency environment and the bounded queue adapter. It does not create an endpoint. The original `worker/Dockerfile` remains the historical baseline.

`/opt/qsb-validation/build-receipt.json` records compiler version, flags, source lock, installed compiler/OpenSSL package versions and **new** binary/release/runtime hashes. `candidate/release.json` and `runtime-binding.json` bind the actual outputs. An operator must obtain the built image's immutable registry digest separately after publishing it; no image digest is fabricated inside the image.

The apt package repositories are not snapshot-locked, so this is a source-complete build recipe, **not a claim of universal bit-for-bit container reproducibility**. Record the generated receipt and OCI digest for each release. Historical speed/correctness evidence does not automatically certify the new binary. OS snapshotting remains a further reproducibility improvement.

The image remains HOLD and subset-only. The offline image checks verify description, wrong-identity rejection and real binary failure without a GPU. They do not certify successful GPU execution, complete range coverage, a withdrawal or mainnet readiness. The public-build worker, CPU-reference, supervisor, and local OCI identities are enrolled in `server/runtime/public-build-enrollment.ts`. That enrollment is not a pushed registry manifest, and a later source edit cannot inherit the recorded binary. The historical identity guards still reject a different build.

The reference code retains its MIT license in `reference/LICENSE`; the optimized source retains Apache-2.0 in `research/optimized-subset/LICENSE`.

A manually triggered [source-build workflow](../../.github/workflows/source-build.yml) performs the same clean-checkout builds on Linux and uploads the supervisor archive and public solver receipt. It has read-only repository permissions, no registry/provider credentials, and does not publish an image or deploy anything. It must be run explicitly; adding it does not imply that CI has passed.

Verified run: [24 September source-build report](../../docs/source-build/20260924/REPORT.md), including the tested commit and generated identities.
