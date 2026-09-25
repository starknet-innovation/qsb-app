# Mainnet job pipeline

Mainnet job creation uses one pipeline: `createApp`, then `startWorkflow`, then the Step Functions coordinator.

1. The deployed API Lambda (`server/lambda.ts`) serves mainnet with `createApp`. It does not mount `installSupervisedCreation`.
2. `POST /api/jobs` in `createApp` (`server/app.ts`) is the job-creation route. After the release gate, it writes the job and calls `startWorkflow`.
3. `startWorkflow` starts the withdrawal state machine when `WORKFLOW_ARN` is set.
4. That state machine's `CoordinateSearch` task invokes the coordinator Lambda (`terraform/workflow.tf`).

`POST /api/jobs/supervised` is not a mainnet route. Supervised creation, dispatch, fresh-proof, activation, and miner-inclusion modules stay in the repository. Supervised tests remain and are off this path. Removing that code is a later step.

Terraform declares only this pipeline, with one records table and one existing Runpod secret reference. Supervised host, dispatch queue, evidence storage and watchdog infrastructure have been removed for the fresh-account deployment; there is no `provision_runtime` switch. See the [deployment instructions](../terraform/README.md).

## Still refused

`release.mainnetEnabled` and the capability `broadcastAuthorized` stay false. This page does not deploy, broadcast, or enable a withdrawal.

While those flags are false, this checkout refuses:

- vault funding (`POST /api/vaults/:id/fund`)
- job creation (`POST /api/jobs`), so `startWorkflow` is not called from a public request
- job resume (`POST /api/jobs/:id/resume`)
- job submission (`POST /api/jobs/:id/submit`) by default; #20 adds a separate, default-off `QSB_EXACT_SUBMIT_ENABLED` switch for a solved, exact signed withdrawal. See [EXACT-SUBMIT.md](EXACT-SUBMIT.md).

A refusal does not write a job, start the state machine, or contact a miner. Issue #22 (enable mainnet and complete a withdrawal) is not part of this change.
