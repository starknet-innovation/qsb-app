# QSB application and solver research

A research application for constructing and recovering quantum-safe Bitcoin vaults, with local wallet signing, a public-data GPU search worker, and independently checked search results.

**Research snapshot — not a production release. Mainnet operations are disabled by default.** GPU workers and optimized research are maintained in the separate qsb-solver repository; the app retains independent CPU verification. Do not use this repository to hold real funds.

## What is included

- `src/`: React application, encrypted local backups, wallet integration, and staged signing/recovery flows.
- `server/`: API, durable storage interfaces, search coordination, and transaction checks.
- `worker/cpu/`: independent public CPU parameter export and hit verification. GPU images live in [qsb-solver](https://github.com/starknet-innovation/qsb-solver).
- `tests/`: application unit tests, browser harnesses, and reference tests.
- [terraform/](terraform/README.md): single-pipeline AWS infrastructure: static site, API, Step Functions coordinator, CPU verifier, records table and MFA-required reconciliation role. GPUs remain on Runpod; transactions stay disabled.
- `contracts/`: versioned search-range vectors shared with qsb-solver.
- `docs/STATUS.md`: achieved evidence summary.
- [Mainnet readiness checklist](docs/MAINNET-READINESS.md): remaining tasks, dependencies and acceptance evidence.

This is a curated export, not the complete operational workspace. Cloud deployment settings, credentials, customer data, signed transactions, raw validation journals, compiled artifacts and one-off recovery scripts are excluded. The [Linux supervisor source package](supervised/runtime/README.md) remains parked research source; the application Terraform does not deploy it.

## Local development

Requires Node.js 22 or newer, npm, Python 3, and curl.

```sh
npm ci
npm run vendor
npm test
npm run typecheck
QSB_NETWORK=mainnet VITE_QSB_NETWORK=mainnet npm run build
npm run package:release -- --check
```

The preparation step supplies the pinned sources required by provenance tests and the browser Python transaction builder. Then start development. `mainnet` here is the network identity; it does not enable mainnet operations:

```sh
QSB_NETWORK=mainnet VITE_QSB_NETWORK=mainnet npm run dev
```

`vendor` downloads an allowlist of generator/reference Python files and their license from one pinned upstream commit, then applies the checked-in patch; review `scripts/vendor.py` and `scripts/patch_upstream.py` before running it. It does not require wallet secrets. The local API uses an in-memory store. Do not put a real backup, recovery phrase, or passphrase into an issue or pull request.

`package:release --check` rebuilds `release/source-manifest.json` from this checkout. That manifest is a source closure. It does not build the CUDA image, and the historical image name in the archived solver descriptor is not a deployable registry identity. CUDA sources and image builds belong to qsb-solver.

The build and unit tests do not establish successful GPU execution, a fresh end-to-end optimized withdrawal, or external miner acceptance. Browser tests also require Playwright browser installation and their configured local services.

## Publication and provenance

See [publication scope](docs/PUBLICATION.md) and [third-party notices](THIRD_PARTY_NOTICES.md). The historical private ECR account is replaced with a nonfunctional placeholder in the exported release descriptor; this snapshot is **not** an attestation of that deployable image. The Terraform folder provides a separate reviewed-plan deployment path for the research app; it does not activate mainnet or deploy the experimental supervised runtime.

No project-wide license has been selected for original application code yet. Existing third-party licenses remain in their respective directories. Public visibility alone does not provide a broad reuse license for the original application code.

## Solver releases

GPU sources, worker images and image provenance are maintained in
[qsb-solver](https://github.com/starknet-innovation/qsb-solver). This app fetches
only the QSB generator, retains its independent CPU verifier, and consumes solver
image digests through the release registry. See [the cross-repository contract](docs/SOLVER-REPOSITORY.md).
The archived descriptor remains unchanged and is not a deployable image.
