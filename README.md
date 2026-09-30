# QSB application

A web app, API and SDK for quantum-safe Bitcoin (QSB) vaults: vault secrets are generated and kept on the user's machine, a GPU search on AWS Batch solves the withdrawal puzzle, an independent CPU verifier re-checks every hit, and the user signs the withdrawal locally.

**Not a production release.** It runs on Bitcoin mainnet without production hardening, and mainnet operations are off unless the deployment's switches turn them on. Do not use this repository to hold real funds. [Status](docs/STATUS.md) lists what's deployed and what's open.

## What is included

- `src/`: React application: encrypted local backups, wallet integration, and staged signing and recovery flows.
- `server/`: the API (`server/app.ts`), the Step Functions coordinator, storage, chain and miner clients, and the exact-submit checks.
- [`sdk/`](sdk/README.md): TypeScript SDK and `qsb` CLI for the same API. Recovery state, passphrases and keys stay on the caller's machine.
- `worker/cpu/`: the independent CPU parameter export and hit verifier. GPU images come from [qsb-solver](https://github.com/starknet-innovation/qsb-solver).
- [`consensus/`](consensus/README.md): the offline Bitcoin Core script check run before a withdrawal is submitted.
- `contracts/`: versioned search-range vectors shared with qsb-solver.
- [`terraform/`](terraform/README.md): the AWS app stack; [`terraform/gpu/`](terraform/gpu/README.md): the AWS Batch GPU stack.
- `ops/`: AWS identities and IAM tooling ([`github-aws`](ops/github-aws/README.md)), the [IAM sandbox](ops/iam-sandbox/README.md) and GPU tooling.
- `scripts/`: vendoring, OpenAPI generation, and the operator reconcile CLIs.
- `tests/`: unit, browser and reference tests.

## How a withdrawal runs

1. The browser (or the SDK) generates the vault locally and registers only its public record. The user signs the one deposit in their wallet, and the API relays it to MARA Slipstream.
2. `POST /api/jobs` in `createApp` (`server/app.ts`) checks the served solver release, reserves the vault's outpoints atomically, writes the job and calls `startWorkflow`, which starts the withdrawal state machine.
3. The state machine's `CoordinateSearch` task invokes the coordinator Lambda (`terraform/workflow.tf`). The coordinator submits GPU work to AWS Batch, polls it, and has the reference Lambda (`worker/cpu`) re-check every hit.
4. Once solved, the browser assembles and signs the withdrawal locally. `POST /api/jobs/:id/submit` checks the exact spend, runs the offline Core check and posts it once to MARA Slipstream ([exact submission](docs/EXACT-SUBMIT.md)).

The deployed API Lambda (`server/lambda.ts`) serves mainnet only. The deploy-time switches `mainnet_enabled` and `exact_submit_enabled` gate funding, search and submission ([runbook](docs/OPERATIONAL-RUNBOOK.md#deploy-time-mainnet-and-submit-switches)).

## Documentation

- [Status](docs/STATUS.md): what's deployed, what's done and what's open.
- [API](docs/API.md): prefixes, OpenAPI, errors, per-owner limits, events and webhooks, idempotency and API keys.
- [Operational runbook](docs/OPERATIONAL-RUNBOOK.md): switches, GPU capacity and spend, incidents, reconciliation and rollback.
- [Exact submission](docs/EXACT-SUBMIT.md): how a signed withdrawal reaches the miner once.
- [App / solver boundary](docs/SOLVER-REPOSITORY.md): enrolled solver releases and how to enroll and serve one.
- [Moving to eu-west-2](docs/REGION-MIGRATION.md): how a new account is built, and retiring the old stack.
- [App-role IAM validation](docs/APP-ROLE-SANDBOX.md) and the [browser safety check](docs/ci/BROWSER-SAFETY.md).

## Local development

Requires Node.js 22 or newer, npm, Python 3, and curl.

```sh
npm ci
npm run vendor
npm test
npm run typecheck
QSB_NETWORK=mainnet VITE_QSB_NETWORK=mainnet npm run build
```

The vendor step supplies the pinned sources the provenance tests and the browser's Python transaction builder need. Then start development. `mainnet` here is the network identity; it doesn't enable mainnet operations:

```sh
QSB_NETWORK=mainnet VITE_QSB_NETWORK=mainnet npm run dev
```

`vendor` downloads an allowlist of generator/reference Python files and their license from one pinned upstream commit, then applies the checked-in patch; review `scripts/vendor.py` and `scripts/patch_upstream.py` before running it. It doesn't require wallet secrets. The local API uses an in-memory store. Do not put a real backup, recovery phrase, or passphrase into an issue or pull request.

Unit and browser tests stub the wallet, chain, miner and GPU; they don't run a GPU search. Browser tests also need Playwright's browser installed ([browser safety check](docs/ci/BROWSER-SAFETY.md)).

## Licensing and provenance

See [third-party notices](THIRD_PARTY_NOTICES.md). No project-wide license has been selected for original application code yet. Existing third-party licenses remain in their respective directories. Public visibility alone does not provide a broad reuse license for the original application code.

Deployment settings, credentials, inventories, plans, customer data, signed transactions and wallet material are kept out of Git. The archived solver descriptor (`src/lib/releases/qsb-config-a-ranked-v2.json`) names a placeholder registry account, `000000000000`, and is not a deployable image. CUDA sources, image builds and image provenance belong to qsb-solver; this app consumes solver image digests through its release registry ([App / solver boundary](docs/SOLVER-REPOSITORY.md)).
