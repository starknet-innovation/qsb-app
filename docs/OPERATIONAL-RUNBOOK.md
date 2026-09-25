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

## Reconcile an unknown AWS Batch submission

An unknown POST is never retried automatically. The operator command requires an
explicit decision with an operator identifier and a public evidence reference.
Do not put credentials, wallet material, or raw logs in the evidence argument.
The identifier is an operator assertion; IAM/CloudTrail identifies the caller.

Required environment: `TABLE_NAME` (the CLI refuses MemoryStore), `AWS_REGION`,
`AWS_BATCH_JOB_QUEUE`, `AWS_BATCH_JOB_DEFINITION`, `AWS_BATCH_JOB_BUCKET`, `WORKFLOW_ARN` and `QSB_NETWORK`
(`mainnet` or `testnet4`). On mainnet, also set `QSB_MAINNET_ENABLED` explicitly to
`"true"` or `"false"`. It must match the deployed value: verify
`terraform output -raw transactions_enabled` or uncached `GET /api/config`
(`operationsEnabled`, with `network` equal to `mainnet`). Missing or malformed
values refuse before application imports. Both modes validate the required values before application imports,
credentials, or database/provider reads and writes. The operator role needs GetItem on job/vault records, transactional PutItem
on the job and `RECONCILIATION#` audit rows, Batch DescribeJobs/ListJobs/DescribeJobQueues, S3 GetObject on the configured outputs prefix, and StartExecution on the configured workflow. It cannot submit or cancel Batch jobs and does not broadcast.

To attach a known provider ID from AWS Batch's console and matching operator logs:

```
npx tsx scripts/reconcile-submission.ts OWNER JOB --provider-id PROVIDER_ID --operator OPERATOR --evidence audit://incident/reference
```

The command reads Batch job status and immutable S3 results, binding the queue, definition revision and input SHA256. The operator must bind live/terminal IDs to this exact
job, stage, range, endpoint and submission window using logs/console evidence.
Completed outputs additionally must match the stored manifest, stage, attempt,
kernel and exact range. Attachment grants no completion credit: the coordinator
still validates the output and CPU-checks hits. Existing attached IDs can restart
polling idempotently. The CLI does not change deployment switches. Its explicit
local mainnet setting gates provider-ID attachment before any read or write;
`PollingNotAllowed` means that local setting or another polling prerequisite
refused, not proof of the current Lambda configuration. Verify the deployed value
before running. If deployment is disabled after that check, the coordinator pauses
the job with its attached provider ID preserved. A polling-start
refusal prints its reason and exits non-zero; an ID already saved before a workflow
start failure remains attached for operator reconciliation. Correct the prerequisite
and rerun the same provider-ID decision; never submit a replacement as a workaround.

To authorize exactly one replacement after proving AWS Batch rejected SubmitJob
before acceptance with a retained HTTP 400–499 response from the paid SubmitJob request
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

For timeouts, connection errors, 5xx or no recorded HTTP response, first reconcile the saved request identity. The explicit `batch-window-elapsed` operator path below permits one bounded replacement only after the 35-minute window, exact-name absence and queue drain. AWS Batch has no submission TTL: `ttl-expired` remains refused. The recorded-4xx fast path also requires queue drain.
A list miss or an empty queue by itself never authorizes replacement.

The decision and job change are one conditional transaction with a permanent
`RECONCILIATION#JOB#REVISION` audit row. Repeated or racing decisions cannot grant
multiple allowances. `/resume` requires the matching audited revision and consumes
the allowance in the same write that advances the revision; the next unknown
pause has no allowance. Time accounting is never cleared or refunded.
This is an explicit operator attestation, not automatic verification of the cited
external evidence. No live provider incident has been exercised for this change.

Provider references: [AWS Batch SubmitJob](https://docs.aws.amazon.com/batch/latest/APIReference/API_SubmitJob.html) and [ListJobs](https://docs.aws.amazon.com/batch/latest/APIReference/API_ListJobs.html). Discovery uses the saved exact job name and follows every results page. `JOB_NAME` filtering includes all job statuses; absence from the list is not evidence that the paid request was rejected.

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

Before a paid claim, endpoint-limit failures pause with `Compute provider limits unconfirmed;
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
  export AWS_BATCH_JOB_QUEUE='arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu'
  export AWS_BATCH_JOB_DEFINITION='arn:aws:batch:eu-west-1:123456789012:job-definition/qsb-gpu-solver:1'
  export AWS_BATCH_JOB_BUCKET='qsb-gpu-123456789012-eu-west-1-jobs'
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

### Reconcile an uncertain withdrawal (TX#)

This is separate from AWS Batch submission reconciliation above. Never use the
compute `--not-submitted` action for a signed withdrawal. Keep **both the vault
funding and helper outpoints reserved** and tell the user to keep the helper UTXO
unspent while the result is uncertain. Never request another signature or accept
replacement bytes for the vault.

1. Inspect `/api/transactions/:originalTxid/status` and its miner observation.
   Confirmation is established from the funding outpoint's actual spender and
   expected spend, not solely from the original txid. Investigate a foreign-spend
   alert immediately; do not treat it as successful inclusion.
2. Under the scoped reconciliation-role session above, set `TABLE_NAME`,
   `AWS_REGION` and `QSB_NETWORK=mainnet` for the intended deployment, then run:

   ```sh
   npx tsx scripts/reconcile-withdrawal.ts OWNER JOB \
     --operator OPERATOR --evidence audit://incident/reference
   ```

   This command records a conditional observation of the existing original
   intent. It performs chain/miner GETs and OWNER-row database writes only.
   It takes no transaction bytes, new signature, provider ID, retry or submit
   option. It does not need a Runpod endpoint or provider secret. Miner status
   authentication, if required by the deployment, uses the service's configured
   runtime authorization; do not paste keys into the command or fetch secret
   values manually. If the operator identity lacks that access, the miner read
   remains unavailable; it is not proof that the miner never received the tx.
3. An `uncertain` result remains locked. A saved POST acknowledgement may report
   `submitted`; only matching canonical chain inclusion reports `confirmed`.
   Evidence of unspent funding plus unknown miner status **does not permit
   another POST**. Any re-POST requires new explicit user approval and a separate
   reviewed operation. This CLI intentionally cannot perform it.
4. Database-version conflicts or failed observations are safe to investigate and
   rerun because this command never submits. Do not delete the TX# row, clear
   `job.txid`, release reservations, or alter the original bytes to bypass it.
   A spent helper requires resolving the #8 re-authorization question; there is
   no automatic replacement path.

See [EXACT-SUBMIT.md](EXACT-SUBMIT.md) for byte binding and uncertainty semantics.

The withdrawal API Lambda has a 120-second timeout; API Gateway still returns
a timeout after its 30-second integration budget. A caller timeout does not stop
an already running Lambda or prove the miner never received the POST. Treat it as
an uncertain withdrawal and follow the TX# observation procedure above. Do not
retry the POST or reset its durable intent.

## Deploy-time mainnet and submit switches

Both Terraform variables default to `false`; this PR does not enable a deployment.
`mainnet_enabled` sets `QSB_MAINNET_ENABLED` on **both** the API and coordinator.
The operator's reconcile CLI also reads this variable and requires an explicit
mainnet value matching the deployment, as described above.
Only the exact string `"true"` enables mainnet funding and the normal Step Functions
search pipeline. The browser reads the same API setting through uncached
`GET /api/config` (`operationsEnabled`, bound to `network`), and rechecks it before
funding/search. No source edit or frontend rebuild is needed to change the switch.
Absent, malformed and cross-network config stays disabled.

| mainnet_enabled | exact_submit_enabled | Result |
| --- | --- | --- |
| false | false | Mainnet funding, search and submission disabled |
| false | true | Mainnet operations and submission still disabled |
| true | false | Funding and search allowed; signed backup download allowed; no exact submit |
| true | true | Exact submit available only after explicit user approval and all exact-spend/Core/intent checks |

The exact submit API and miner transport require **both** switches; a submit flag
cannot bypass the mainnet gate. Neither switch grants transaction approval or
resubmits uncertain work. Existing committed source defaults `release.mainnetEnabled`
and `broadcastAuthorized` stay false; they are research metadata, not the deployed
route authority. Build artifacts are independent of these deployment values.
Changing Terraform variables updates Lambda environments using the same clean,
committed package; API config reports the resulting setting. Turning on a real
deployment remains issue #22 and requires Adrien's explicit approval. Commit and
push code before deployment. Record the approved `mainnet_enabled` and
`exact_submit_enabled` values in the #22 approval/deployment record; never commit
ignored tfvars, credentials or operator runtime configuration. After apply, verify
the deployed code commit separately from the runtime settings using
`terraform output -raw transactions_enabled`,
`terraform output -raw exact_submit_enabled`, and uncached `GET /api/config`.
The Git commit alone does not establish deployed switch values.

Disabling mainnet blocks new funding/search/submission and pauses non-terminal
coordinator jobs with a deployment-disabled error. Provider IDs, uncertain intents,
spend accounting and reservations remain intact; already submitted GPU jobs are
not cancelled. After enabling again, resume a paused job to poll its existing
provider ID. Reconcile uncertain submissions with the existing runbook; never
reset an intent or submit a replacement solely because the switch was toggled.
Reconcile outstanding jobs before changing capacity.

### AWS migration decision and request recovery

The user explicitly selected AWS for all QSB GPU work on 2026-09-25, superseding the earlier undecided-provider plan. Runpod is not the default or a fallback. This decision does not enable mainnet or enroll an unattested solver image.

Before any paid intent is saved, `prepareRun` uploads the public input and returns its job name, SHA256, input key, queue and exact definition revision. The coordinator saves this `batchSubmission` identity together with `searching` and its spend reservation. An upload failure occurs before this marker and can be resumed without an unknown paid outcome.

Use the existing reconciliation CLI with `--provider-id discover --operator ... --evidence ...` to search all statuses by the saved exact job name. Exactly one match is required. Both discovery and an explicitly supplied ID are checked against the saved name, request/project tags, input key/hash, queue and definition before attaching any queued, running, failed or completed job. Operator permissions need no access to input contents. Save incident evidence promptly: Batch guarantees terminal retention only for at least seven days.

For a timed-out, disconnected or 5xx submission, the user-approved bounded recovery command is:

```sh
npx tsx scripts/reconcile-submission.ts OWNER JOB --not-submitted batch-window-elapsed --operator OPERATOR --evidence audit://incident/window-and-drain
```

It requires at least 35 minutes since the durable submission start (30-minute watchdog ceiling plus its 5-minute interval), and less than seven days so terminal retention can support discovery. Exact-name discovery must return no job across all pages/statuses, and the QSB queue must have zero submitted, pending, runnable, starting and running jobs. Discovery failure or multiple matches refuses recovery. A discovered job is attached through the normal identity-checked provider-ID path instead. Old jobs without saved identity cannot use this path.

This is an explicitly accepted bounded duplicate risk, not proof of non-acceptance. One such replacement is allowed per withdrawal, recorded atomically with the reconciliation audit and a persistent `batchReplacementUsed` marker. The existing one-shot allowance is consumed before the paid call; a second ambiguous replacement is refused even after resume. Neither prior spend nor reservations are cleared; the replacement consumes the normal 15-minute budget reservation. The recorded-4xx fast path is unchanged. This command never submits GPU work itself. `ttl-expired` remains invalid for AWS Batch.

The migration smoke image is not a production release: it lacks a build-provenance attestation and has been removed from the enrollment registry. Follow the attested release/copy procedure in `terraform/gpu/README.md` before any production enrollment.

### Attested image mirror and local positive-hit replay

The producer descriptor retains its canonical immutable
`ghcr.io/starknet-innovation/qsb-solver@sha256:…` image. Batch preflight accepts
that exact image, or the same digest in the `qsb-solver` ECR repository in the
configured queue's AWS account and region. Different digests, accounts, regions,
repositories and tags are refused before public-input upload or paid submission.
Copy the manifest without changing its digest and verify the producer attestation
before enrollment; the registry alias check is only a consistency check and does
not itself prove build provenance. No account-specific mirror URL needs to appear
in the browser release descriptor.

`ops/aws-gpu-migration/replay-positive-hits.ts` reads an external public signing
bundle and passes mocked Batch/S3 completed results through the real Batch parser
and local CPU reference. Run `npm run vendor`, then:

```sh
npx tsx ops/aws-gpu-migration/replay-positive-hits.ts /path/to/public-signing-bundle.json
```

This command never submits work, signs, broadcasts, or credits ranges. It accepts
only public reference fields from the external bundle and does not copy the bundle
into the repository. The recorded [replay evidence](../ops/aws-gpu-migration/positive-hit-replay.json)
checks all three historical puzzle hits, malformed candidates, mismatched request
and output hashes, and changed subset locktime. Pinning candidates supply their
own sequence/locktime, so that context mutation is not a pinning rejection test.
These are real local cryptographic checks with mocked AWS transport, not a new GPU
search, live Lambda/Batch integration, Core proof or miner inclusion.
