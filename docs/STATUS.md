# Status

As of 2 October 2026. #8, the plan to a first mainnet withdrawal, is complete; what's open is listed below.

## Deployed

- **Account and region.** One app stack and one GPU stack in a dedicated AWS account in eu-west-2, reached through IAM Identity Center. They were built from scratch on 30 September 2026; no data was copied from the earlier eu-west-1 stack ([REGION-MIGRATION.md](REGION-MIGRATION.md)).
- **Pipeline.** API Lambda, Step Functions coordinator, AWS Batch GPUs and the CPU reference Lambda ([README](../README.md#how-a-withdrawal-runs)).
- **API.** CloudFront calls the API's Lambda function URL (`AWS_IAM` auth) through origin access control; there is no API Gateway (`terraform/web.tf`).
- **Solver.** `combined-aws-sm86-v0.3.0` (`qsb-ranked-v2-40b5d9f9f741-6b4ac63b897c`), the optimized subset kernel with the repaired pinning on a runtime with Ubuntu updates applied at build, served since 2 October 2026. `combined-aws-sm86-v0.2.0` stays enrolled for rollback ([SOLVER-REPOSITORY.md](SOLVER-REPOSITORY.md)).
- **GPUs.** On-Demand `g5.xlarge` (one A10G each), up to 16 per withdrawal (`workersMax` in `server/gpu-spend.json`), scaling to zero when idle.
- **Switches.** An uncached `GET /api/config` reports the mainnet and submit switches. Approvals and switch changes are recorded in the private deployment record, not in Git ([runbook](OPERATIONAL-RUNBOOK.md#deploy-time-mainnet-and-submit-switches)). API keys, the scheduled webhook dispatcher and the per-owner limits are off by default.
- **Deploys.** A `qsb-operator` applies a reviewed plan, or `.github/workflows/deploy.yml` plans each push to `main` and applies after an approval once `QSB_AWS_DEPLOY_ENABLED` is `true` ([terraform/README.md](../terraform/README.md#deploy-from-github)).

## Decisions

- One pipeline: the Step Functions coordinator. QSB runs on mainnet only.
- GPU work runs on AWS Batch. Runpod is neither the default nor a fallback.
- No test chains: testing happens on mainnet with small deposits. Before submit, an offline consensus check runs Bitcoin Core's script interpreter on the exact signed transaction (#20).
- One deposit per vault. The server flags a payment to a vault's script beyond its deposit, and no withdrawal spends it ([API](API.md#stray-payments)).

`AGENTS.md` lists these with the funds-safety invariants.

## Done

- The first mainnet deposit and withdrawal, on the earlier eu-west-1 stack (#22). The on-chain record is in [FIRST-MAINNET-WITHDRAWAL.md](FIRST-MAINNET-WITHDRAWAL.md).
- Phases 1 and 2 of the non-custodial API and SDK (#85): `/v1`, the OpenAPI spec, scoped API keys, per-owner limits, signed webhooks, and the TypeScript SDK and `qsb` CLI ([API](API.md)).
- Each deposit's QSB version, deposit outpoint, status and flagged stray payments, in the vault list and an export (#27).
- Each withdrawal's measured GPU usage: the AWS Batch run and queue time of its chunks, in the job's `usage` ([runbook](OPERATIONAL-RUNBOOK.md#measured-gpu-usage)).
- The move to the new eu-west-2 account (REGION-MIGRATION.md steps 1–11, and the GitHub part of step 12).

## Open

- **Legal:** confirm that the redistribution approval covers the served image `combined-aws-sm86-v0.3.0`, and `combined-aws-sm86-v0.2.0`, which stays enrolled for rollback. The earlier approval covered `aws-v0.1.0`. This needs legal review.
- **ECR enhanced scanning.** The `qsb-solver` repository has basic scanning only, which runs once at push, so served images aren't rescanned as new vulnerabilities are published. The AWS administrator turns on enhanced scanning with a lifetime rescan duration ([image scanning](../ops/github-aws/README.md#what-stays-with-the-aws-administrator)). Images pushed more than 14 days before that need pushing again to be scanned.
- **Solver image pull by digest.** #22 asked that the first bounded run confirm AWS Batch pulled the enrolled solver image by digest. No run has confirmed it yet: the first withdrawal's record ([FIRST-MAINNET-WITHDRAWAL.md](FIRST-MAINNET-WITHDRAWAL.md)) doesn't include it. Check the image that withdrawal's Batch jobs ran in eu-west-1 while AWS still keeps their records, or on the first eu-west-2 withdrawal.
- **Legacy supervised jobs.** Persisted jobs marked `execution.kind: "qsb-supervised-service-v1"` stay rejected by exact submission and by the solved-result, pause, resume and status routes, and the UI hides their pause and resume controls. These guards stay until the production inventory is complete and any matching rows are reconciled or quarantined; removing the old UI doesn't show the table holds none.
- **#122:** support more than one QSB generator version, with the first generator change.
- **#85 phase 3:** billing, terms of use, WAF and rate limits. This needs a separate decision.
- **#119:** the QSB author's answers on the security figure, SHA-256 Config A, re-authorization and the single output.
- **The old eu-west-1 stack's** services were retired on 30 September 2026 (REGION-MIGRATION.md step 11), and its data was kept. Deleting that data is the remaining cleanup.
- **Local operator profiles:** the local-profile part of REGION-MIGRATION.md step 12 (pointing `qsb-view` and `qsb-operator` at the new account) is still to do.

## Known gaps

- A "GPU hit output exceeds supported capacity" failure is terminal, and that withdrawal's deposit can't be withdrawn through the app until a reviewed recovery change lands ([runbook](OPERATIONAL-RUNBOOK.md#deterministic-pinning-failures)).
- A resume can't use a new solver release: a withdrawal keeps the release it pinned at creation.
- The GPU-time allowance (4,096 GPU-hours per withdrawal) is a planning figure from a code comment, not a measurement ([runbook](OPERATIONAL-RUNBOOK.md#gpu-time-allowance)). Measured `usage` from real withdrawals is the data to reassess it with.
- Measured GPU usage isn't a cost: there's no price table, instance idle time and the other AWS services aren't in it, and nothing reconciles it with the AWS bill. It also misses chunks still running when a tick pauses the search, until a resume polls them ([runbook](OPERATIONAL-RUNBOOK.md#measured-gpu-usage)).
