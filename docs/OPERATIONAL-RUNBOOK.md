# Operational runbook

**This document defines procedures. It is not an activation decision, a deployment, or permission to spend.**

Publishing research source is not deployment or activation. Feature enablement is not authorization to spend. `release.mainnetEnabled` stays false. `broadcastAuthorized` is not set. No step below starts a worker, contacts a provider, or broadcasts a transaction.

The checked-in capability limit is `providerGpuLimit: 1` in `server/mainnet-capability.json`. Until a later reviewed decision changes that file, the concurrency cap is one concurrent search and one GPU worker. The minimum idle worker count is zero. This is not a measured production capacity plan.

## Concurrency and cost caps

- `maxConcurrentSearches`: 1
- `maxGpuWorkers`: 1
- `minIdleWorkers`: 0
- The coordinator path uses `server/gpu-spend.json`: `workersMax` 1, `workersMin` 0, `executionTimeoutMs` 900000, and `maxJobGpuSeconds` 14745600 (4,096 GPU-hours per job, reserved across retries and all stages). A 64-hit output is not credited as a finished range. These checks do not start a worker, evaluate the USD ceiling, or authorize a spend.
- `costUnit` is `operator-units`. `maxCostUnits` is a positive integer of those units. The operator cost field is not the experimental USD ceiling. A plan that labels the field as USD, or that supplies `vaultUsd`, `feeUsd`, or `gpuUsd` on the runbook, is refused with `CostFieldIsNotUsdCeiling`.
- The experimental USD limits are vault 10000, fee 1000, and GPU 1000. They are encoded only in `assertExperimentalUsdLimits`. That check cannot run while `release.mainnetEnabled` and `broadcastAuthorized` are false: it throws `UsdLimitCheckClosed` and does not compare amounts. It does not read `maxCostUnits`, approve activation, or authorize a spend.
- A missing or zero operator cost ceiling is refused. A plan above the concurrency cap is refused. `acceptOperationalRunbook` does not provision workers. `executed`, `provisioned`, and `usdLimitsEvaluated` stay false. `costFieldIsUsdCeiling` stays false.

## Deadlines

Every plan has a deadline later than the operator-supplied clock reading. When the deadline passes, stop new submissions and reconcile anything already paid or possibly paid. Do not start a replacement paid job to "finish" the deadline.

## Cleanup

The cleanup watchdog is a different identity from the worker. The worker is not its own watchdog. A cleanup failure raises the `cleanup-failure` alert and does not submit the job again.

## Alerts

The plan names all of these alerts: `cost-cap`, `deadline`, `uncertain-paid-outcome`, `cleanup-failure`, and `activation-attempt`. An activation attempt is an alert, not an approval.

## Incident handling

1. Stop new work.
2. Preserve unknown paid outcomes for reconciliation rather than retrying blindly.
3. Do not enable mainnet or authorize a spend as part of incident response.
4. Keep the backup, passphrase, and runtime credentials out of the incident record. Record public identifiers only.

## Safe stop and rollback

Stop new submissions. Loss of a local process is not proof that remote GPU work stopped. Do not clear an unknown provider result by submitting it again.

Rollback cannot revive legacy writers, release consumed commitments, or duplicate paid work. Rollback does not authorize a spend and does not set `release.mainnetEnabled` or `broadcastAuthorized`.

## Unknown paid outcomes

Treat `unknown`, `timeout`, and `http-ambiguous` as unpaid-or-paid until a provider or invoice record says which. The only action is reconcile. `reconcilePaidOutcome` returns `retry: false`. Requesting retry throws `BlindRetryRefused`. A known success is recorded once and is not submitted again.

## Reconcile an unknown Runpod submission

An unknown POST is never retried automatically. The operator command requires an
explicit decision with an operator identifier and a public evidence reference.
Do not put credentials, wallet material, or raw logs in the evidence argument.
The identifier is an operator assertion; IAM/CloudTrail identifies the caller.

Required environment: `TABLE_NAME` (the CLI refuses MemoryStore), `AWS_REGION`,
`RUNPOD_SECRET_ARN`, `RUNPOD_ENDPOINT_ID`, `WORKFLOW_ARN` and `QSB_NETWORK`
(`mainnet` or `testnet4`). Both modes validate all six before application imports,
credentials, or database/provider reads and writes. The operator role needs GetItem on job/vault records, transactional PutItem
on the job and `RECONCILIATION#` audit rows, access to the configured provider
credential (and its KMS key if applicable), and StartExecution on the configured
workflow. The agent must not retrieve those credentials; provision them for the
operator runtime. The CLI does not call `/run`, `/cancel` or broadcast.

To attach a known provider ID from Runpod's console and matching operator logs:

```
npx tsx scripts/reconcile-submission.ts OWNER JOB --provider-id PROVIDER_ID --operator OPERATOR --evidence audit://incident/reference
```

The command reads documented `/status/ID` fields; no `/requests` response shape or
echoed `input` is assumed. The operator must bind live/terminal IDs to this exact
job, stage, range, endpoint and submission window using logs/console evidence.
Completed outputs additionally must match the stored manifest, stage, attempt,
kernel and exact range. Attachment grants no completion credit: the coordinator
still validates the output and CPU-checks hits. Existing attached IDs can restart
polling idempotently. Mainnet switches remain unchanged, and disabled transaction
routes refuse provider-ID attachment before any read or write. A polling-start
refusal prints its reason and exits non-zero; an ID already saved before a workflow
start failure remains attached for operator reconciliation. Correct the prerequisite
and rerun the same provider-ID decision; never submit a replacement as a workaround.

To authorize exactly one replacement after proving Runpod rejected the call
before acceptance with a retained HTTP 400–499 response from the paid `/run` POST
(not the limits preflight, a timeout, connection error or 5xx):

```
npx tsx scripts/reconcile-submission.ts OWNER JOB --not-submitted rejected-before-acceptance --http-status 429 --operator OPERATOR --evidence audit://incident/rejection
```

The immediate path requires `--http-status` to be an integer from 400 through
499. Missing, malformed, non-HTTP and other status values are refused; the status
is stored in the job decision and immutable audit row alongside the operator,
evidence, time and revision. The operator must retain the actual response from
this job's paid POST. The tool validates the recorded code, not the external
truth of an operator's evidence reference.

For timeouts, connection errors, 5xx or no recorded HTTP response, use
`--not-submitted ttl-expired` only after the complete 24-hour provider TTL has
elapsed from durable `submissionStartedAt`. Legacy jobs without that timestamp
cannot use TTL expiry. This mode does not accept `--http-status`; it never
shortens the wait. Independently check the endpoint and billing/log window.
TTL expiry does **not** prove that the old job was never accepted and can incur
duplicate bounded work.
Both modes require current health to show zero queued/in-progress requests.
A list miss or an empty queue by itself never authorizes replacement.

The decision and job change are one conditional transaction with a permanent
`RECONCILIATION#JOB#REVISION` audit row. Repeated or racing decisions cannot grant
multiple allowances. `/resume` requires the matching audited revision and consumes
the allowance in the same write that advances the revision; the next unknown
pause has no allowance. Time accounting is never cleared or refunded.
This is an explicit operator attestation, not automatic verification of the cited
external evidence. No live provider incident has been exercised for this change.

Provider reference: https://docs.runpod.io/serverless/endpoints/send-requests

## Commit before deploy

Never deploy code or infrastructure changes before committing them to Git. Verify that deployed source matches the recorded commit and contains no uncommitted changes. Push the commit to the project remote before deployment and report the commit or PR with the deployment target. Never commit secrets or ignored runtime configuration.

Local builds and source flags are not live-configuration evidence. A clean pushed commit is necessary and is not itself a deployment. Record the source-manifest sha256, the configuration hash, and, once an image exists, the image config digest, the OCI index digest, and the registry manifest digest as separate `sha256:` values. Do not relabel a source hash as an image digest.

## Spend authorization

Every proposed mainnet spend requires a separate exact-transaction authorization. The activation decision does not carry the transaction id, amount, or fee, and it does not set `broadcastAuthorized`. An exact spend record is still not a broadcast. This checkout grants neither.

### Coordinator GPU-time allowance

`server/gpu-spend.json` is the bundled source of truth. The user chose
14,745,600 seconds (4,096 GPU-hours) per job on PR #36. The planning calculation
uses Config A's upstream honest-work comment of roughly 2^47 candidates
(`public/qsb/qsb_pipeline.py:255`), divided by the roughly 2^34 candidates per
subset range in `server/search-ranges.ts`: 8,192 range-equivalents. Reserving
900 seconds each gives 2,048 GPU-hours; a 100% margin gives 4,096 GPU-hours.
This is a planning assumption from a code comment, not measured expected runtime
or a success guarantee; pinning geometry differs. If that estimate is per round
rather than total, the allowance must be reassessed and raised through review.
Changing it requires review/build/deploy.
Before every paid POST, the coordinator atomically saves the greater of cumulative
reserved seconds and observed compute seconds, plus the submission's timeout
(currently 900 seconds). It pauses if this would exceed the budget. This permits
16,384 worst-case reservations from a fresh job; it does not guarantee a solution.

Reservations are permanent: short runs, failed/cancelled/timed-out jobs, unknown
POST outcomes, stage changes and resume requests do not refund or reset them.
`computeSeconds` remains observed execution telemetry, not complete billing data.
Legacy jobs with a recorded submission count reserve 900 seconds per historical
submission. New jobs explicitly initialize their reservation at creation; missing or invalid
accounting otherwise pauses for reconciliation (even at range zero). Stage-local `attempt` is only a
range index. The retained `gpuSubmissions` count is telemetry/migration evidence,
not the configured cap.

Startup, idle time, storage and provider retry/billing behavior are not an invoice
cap. No paid run is authorized by changing this configuration.

Before a paid claim, endpoint-limit failures pause with `Runpod limits unconfirmed;
nothing was submitted` and leave the time reservation unchanged. Fix the endpoint
permission/configuration, then resume normally. A failure after the paid POST
boundary remains an unknown submission and must be reconciled, never retried
blindly. The 90-second coordinator timeout budgets the CPU export (25 seconds),
endpoint check (20 seconds), paid POST (20 seconds), and persistence overhead;
it reduces timeout exposure but does not make a POST and database write atomic.

### App-role IAM merge gate

See [APP-ROLE-SANDBOX.md](APP-ROLE-SANDBOX.md) for the reproducible 60-decision
read-only simulation and exact regional transaction/batch requests, expected
responses and consistent-read checks. The live sandbox portion remains pending
operator confirmation; simulator output alone does not release the merge hold.

### Assume the reconciliation role

Terraform now exports `operator_reconcile_role_arn`. Only the exact IAM principals
in the required `operator_principal_arns` variable may assume it, and AWS must
see MFA. This role is separate from the parked reservation-authority operator.
It cannot access SYSTEM or OUTPOINT partitions, Query/Scan, Update/Delete/BatchWrite,
or alter reservation authority. Its GetItem and PutItem permissions use
`ForAllValues:StringLike` on `dynamodb:LeadingKeys = OWNER#*` and require the key
with `Null: false`. IAM authorizes transaction puts via `dynamodb:PutItem`, not a
fictitious `dynamodb:TransactWriteItems` action. Conditions restrict partition keys,
not sort keys; the CLI enforces the job/audit shapes and conditional versions.

Before invoking the CLI, the operator configures an MFA-capable source profile
and a role profile in their local AWS config (replace these public placeholders):

```ini
[profile qsb-reconcile-mfa]
role_arn = arn:aws:iam::123456789012:role/qsb/runtime/qsb-app-operator-reconcile
source_profile = your-approved-iam-user-profile
mfa_serial = arn:aws:iam::123456789012:mfa/your-device
region = eu-west-1
```

Use the actual Terraform output ARN, including its configured path. The source
identity also needs permission to assume that role. IAM Identity Center/federated
MFA does not automatically supply this condition; use an approved MFA-capable
identity, never weaken the trust policy. AWS CLI prompts for MFA and caches the
short-lived role credentials. Run inside a subshell so session credentials do
not remain in the parent shell; disable tracing and never print or share them:

```sh
(
  set +x
  set -e
  aws sts get-caller-identity --profile qsb-reconcile-mfa
  session_exports="$(aws configure export-credentials --profile qsb-reconcile-mfa --format env)" || exit 1
  eval "$session_exports"
  unset session_exports
  unset AWS_PROFILE AWS_DEFAULT_PROFILE
  # Verify the assumed-role ARN before proceeding; this prints no credentials.
  aws sts get-caller-identity
  export TABLE_NAME='your-records-table'
  export AWS_REGION='eu-west-1'
  export RUNPOD_SECRET_ARN='arn:aws:secretsmanager:eu-west-1:123456789012:secret:qsb-vault/runpod-EXAMPLE'
  export RUNPOD_ENDPOINT_ID='yourendpointid'
  export WORKFLOW_ARN='arn:aws:states:eu-west-1:123456789012:stateMachine:qsb-app-withdrawal'
  export QSB_NETWORK='mainnet'
  npx tsx scripts/reconcile-submission.ts OWNER JOB --provider-id PROVIDER_ID --operator OPERATOR --evidence audit://incident/reference
)
```

The six environment values must come from the intended deployment. Do not put a
provider key into any of them or manually fetch a secret value: the CLI obtains
the configured credential at runtime. The example attaches an already-known ID;
it is not permission to attest non-submission or spend again. Use the separate
reconciliation procedure and evidence requirements above for those decisions.
The role grants no broadcast permission and changes no mainnet activation flag.

Policy references: [DynamoDB LeadingKeys](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html)
and [AWS MFA-protected API access](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_mfa_configure-api-require.html).
Local policy/plan tests do not prove a live assumed-role session or regional IAM enforcement.
