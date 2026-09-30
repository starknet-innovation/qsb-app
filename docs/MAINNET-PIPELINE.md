# Mainnet job pipeline

Mainnet job creation uses one pipeline: `createApp`, then `startWorkflow`, then the Step Functions coordinator.

1. The deployed API Lambda (`server/lambda.ts`) serves mainnet with `createApp`, and refuses to start for any other network.
2. `POST /api/jobs` in `createApp` (`server/app.ts`) is the job-creation route. After the release gate, it writes the job and calls `startWorkflow`.
3. `startWorkflow` starts the withdrawal state machine when `WORKFLOW_ARN` is set.
4. That state machine's `CoordinateSearch` task invokes the coordinator Lambda (`terraform/workflow.tf`).

The parked supervised creation, dispatch, host, fresh-proof and activation code, and its tests, were removed under #23; there is no `POST /api/jobs/supervised`.

Terraform declares only this pipeline, with one records table and AWS Batch queue/job-definition and S3 artifact bindings. Supervised host, dispatch queue, evidence storage and watchdog infrastructure have been removed for the fresh-account deployment; there is no `provision_runtime` switch. See the [deployment instructions](../terraform/README.md).

## Deployment switches

`mainnet_enabled` and `exact_submit_enabled` default to false. Terraform passes
`QSB_MAINNET_ENABLED` to the API and coordinator; only the exact string `"true"`
enables mainnet funding, job creation and resume. Exact submission additionally
requires `QSB_EXACT_SUBMIT_ENABLED="true"` and the exact-spend, offline Core and
transaction-approval checks. See the [switch matrix](OPERATIONAL-RUNBOOK.md#deploy-time-mainnet-and-submit-switches)
and [exact submission](EXACT-SUBMIT.md).

The source metadata `release.mainnetEnabled` and capability `broadcastAuthorized`
remain false; they are not the deployed route
switches. Disabling mainnet pauses non-terminal coordinator jobs while preserving
provider IDs, submission intents, spend accounting and outpoint reservations.
It does not cancel already submitted GPU work. Resume requires mainnet to be
re-enabled; uncertain submissions still require operator reconciliation and must
never be blindly resubmitted.

Default-off route refusals do not write new jobs, start workflows or contact a
miner. Enabling a deployment remains issue #22 and requires explicit user approval.
