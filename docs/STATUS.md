# Status

As of 30 September 2026. The plan of record is #8.

## Deployed

- **Account and region.** One app stack and one GPU stack in a dedicated AWS account in eu-west-2, reached through IAM Identity Center. They were built from scratch on 30 September 2026; no data was copied from the earlier eu-west-1 stack ([REGION-MIGRATION.md](REGION-MIGRATION.md)).
- **Pipeline.** API Lambda, Step Functions coordinator, AWS Batch GPUs and the CPU reference Lambda ([README](../README.md#how-a-withdrawal-runs)).
- **Solver.** `combined-aws-sm86-v0.2.0` (`qsb-ranked-v2-43c77084648a-e22afc720df1`), the optimized subset kernel with the repaired pinning ([SOLVER-REPOSITORY.md](SOLVER-REPOSITORY.md)).
- **GPUs.** On-Demand `g5.xlarge` (one A10G each), up to 16 per withdrawal (`workersMax` in `server/gpu-spend.json`), scaling to zero when idle.
- **Switches.** An uncached `GET /api/config` reports the mainnet and submit switches. Approvals and switch changes are recorded in the private deployment record, not in Git ([runbook](OPERATIONAL-RUNBOOK.md#deploy-time-mainnet-and-submit-switches)). API keys, the scheduled webhook dispatcher and the per-owner limits are off by default.
- **Deploys.** A `qsb-operator` applies a reviewed plan, or `.github/workflows/deploy.yml` plans each push to `main` and applies after an approval once `QSB_AWS_DEPLOY_ENABLED` is `true` ([terraform/README.md](../terraform/README.md#deploy-from-github)).

## Decisions

- One pipeline: the Step Functions coordinator. QSB runs on mainnet only.
- GPU work runs on AWS Batch. Runpod is neither the default nor a fallback.
- No test chains: testing happens on mainnet with small deposits. Before submit, an offline consensus check runs Bitcoin Core's script interpreter on the exact signed transaction (#20).
- One deposit per vault.

`AGENTS.md` lists these with the funds-safety invariants.

## Done

- The first mainnet deposit and withdrawal, on the earlier eu-west-1 stack (#22).
- The move to the new eu-west-2 account (REGION-MIGRATION.md steps 1–10, and the GitHub part of step 12).

## Open

- **#22:** write the first withdrawal's evidence record under `docs/` (its acceptance), then close it.
- **#23:** remove the remaining unreachable code: the supervised UI paths and testnet4 support. `terraform/scripts/build.mjs` and the Terraform `network` variable still accept `testnet4`, but the API Lambda refuses to start on any network but mainnet (`server/lambda.ts`).
- **#24:** build-generated identities in place of in-repo self-hash pinning.
- **#27:** record each deposit's QSB version as data.
- **#85:** the non-custodial API and SDK. Phase 3 (billing, terms of use, WAF and rate limits) isn't done.
- **The old eu-west-1 stack** is still up. It is retired by REGION-MIGRATION.md step 11, then cleaned up.

## Known gaps

- A "GPU hit output exceeds supported capacity" failure is terminal, and that withdrawal's deposit can't be withdrawn through the app until a reviewed recovery change lands ([runbook](OPERATIONAL-RUNBOOK.md#deterministic-pinning-failures)).
- A resume can't use a new solver release: a withdrawal keeps the release it pinned at creation.
- The GPU-time allowance (4,096 GPU-hours per withdrawal) is a planning figure from a code comment, not a measurement ([runbook](OPERATIONAL-RUNBOOK.md#gpu-time-allowance)).
