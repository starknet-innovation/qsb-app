# Mainnet job pipeline

Mainnet job creation uses one pipeline: `createApp`, then `startWorkflow`, then the Step Functions coordinator.

1. The deployed API Lambda (`server/lambda.ts`) serves mainnet with `createApp`. It does not mount `installSupervisedCreation`.
2. `POST /api/jobs` in `createApp` (`server/app.ts`) is the job-creation route. After the release gate, it writes the job and calls `startWorkflow`.
3. `startWorkflow` starts the withdrawal state machine when `WORKFLOW_ARN` is set.
4. That state machine's `CoordinateSearch` task invokes the coordinator Lambda (`terraform/workflow.tf`).

`POST /api/jobs/supervised` is not a mainnet route. Supervised creation, dispatch, fresh-proof, activation, and miner-inclusion modules stay in the repository. Supervised tests remain and are off this path. Removing that code is a later step.

`provision_runtime` is refused when `network` is `mainnet`. The supervised runtime Terraform is not the mainnet path and is not applied for that environment.

## Still refused

`release.mainnetEnabled` and the capability `broadcastAuthorized` stay false. This page does not deploy, broadcast, or enable a withdrawal.

While those flags are false, this checkout refuses:

- vault funding (`POST /api/vaults/:id/fund`)
- job creation (`POST /api/jobs`), so `startWorkflow` is not called from a public request
- job resume (`POST /api/jobs/:id/resume`)
- job submission (`POST /api/jobs/:id/submit`)

A refusal does not write a job, start the state machine, or contact a miner. Issue #22 (enable mainnet and complete a withdrawal) is not part of this change.
