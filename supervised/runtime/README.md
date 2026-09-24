# Repository-built Linux supervisor distribution

```sh
npm ci
npm run build:runtime
npm run test:runtime-build
```

This builds `supervised/runtime/runtime.tar.gz` and `dist/manifest.json` from the tracked source closure and the root npm lockfile. It no longer needs the private `18421ac0…` archive. The archive is an output, not a file that must be committed. Normal Terraform artifact preparation builds and hashes it alongside the dispatcher and stages both the archive and runtime manifest for optional S3 publication. Provisioning still leaves execution disabled.

`source-manifest.json` records the imported source files, their original hashes, public hashes and sanitizations. `source/work/` preserves internal relative imports; these are committed repository files, not reads from the operator's work directory. `source/outputs/` freezes the historical protocol/Store support used by this supervisor, while the application dispatcher still uses its current application Store. This is an isolated successor package, not an automatic migration or proof of identical cross-version semantics.

The builder bundles four Node entrypoints, copies the Python process-ownership/CPU adapters, regenerates nested enrollment hashes and the installation manifest, and writes a deterministic tar/gzip archive. It checks that bundling stays within the committed source closure and root npm dependencies. Exact installer verification and repeat-build archive equality are tested. Build outputs contain no credential values, user fixtures or recovery state.

This is **not byte-identical to the historical validated archive**. Private registry names and historical fixture identifiers are replaced with unenrolled placeholders. Existing image/runtime-hash constraints remain intentionally restrictive. The generated archive is HOLD; obtaining an archive does not authorize execution or attest that historical CPU images equal a newly built image. The public build's archive, worker, CPU reference, and local OCI layout are enrolled in `server/runtime/public-build-enrollment.ts` for that build only. A later change to this source manifest is not that archive. The isolated table prefix, private credentials, and watchdogs remain separate. The historical production host is not changed by this build.

Build the GPU worker and its CPU-reference entrypoint using [the public optimized Docker build](../../worker/optimized/README.md). No CUDA compilation is hidden in the supervisor builder: these are two distinct artifacts. The compatibility/enrollment gate between their newly generated identities remains explicit rather than silently accepting arbitrary hashes.

Only public code is exported. Preserve upstream licenses in the referenced research and worker directories. AWS/other npm dependencies retain their package licenses. No test fixtures, signed transactions, deployment credentials or generated archives are published here.
