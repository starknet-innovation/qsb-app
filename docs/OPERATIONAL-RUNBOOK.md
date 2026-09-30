# Operational runbook

**This document defines procedures. It is not an activation decision, a deployment, or permission to spend.**

Publishing research source is not deployment or activation. Feature enablement is not authorization to spend. `release.mainnetEnabled` stays false. `broadcastAuthorized` is not set. No step below starts a worker, contacts a provider, or broadcasts a transaction.

The checked-in capability limit is `providerGpuLimit: 1` in `server/mainnet-capability.json`. It governs the supervised runtime: until a later reviewed decision changes that file, that runtime's cap is one concurrent search and one GPU worker. The AWS Batch coordinator's GPUs per withdrawal are `workersMax` in `server/gpu-spend.json` instead (see [Parallel GPU search](#parallel-gpu-search)). The minimum idle worker count is zero. This is not a measured production capacity plan.

## Concurrency and cost caps

- `maxConcurrentSearches`: 1
- `maxGpuWorkers`: 1 (supervised runtime; the coordinator uses `workersMax` below)
- `minIdleWorkers`: 0
- The coordinator path uses `server/gpu-spend.json`: `workersMax` (1–16; see [Parallel GPU search](#parallel-gpu-search)), `workersMin` 0, `executionTimeoutMs` 900000, and `maxJobGpuSeconds` 14745600 (4,096 GPU-hours per job, reserved across retries and all stages). A 64-hit output is not credited as a finished range. These checks do not start a worker, evaluate the USD ceiling, or authorize a spend.
- Optional per-owner limits (allowlist, active withdrawals, GPU seconds) are off by default; see [Per-owner limits](#per-owner-limits).
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

### Deterministic pinning failures

The combined optimized release can stop a pinning work unit on `QSB_RANGE_INCOMPLETE`, a hit-capacity overflow, or a repeatable publication or CUDA failure. How this app records it depends on what the worker published:
- **Paused, "Incomplete work unit"**, where the worker exited 2 without any CPU-valid candidate (no candidates, or only DER-only ones): the app offers resume, and a resume repeats the same bounded range as a new paid job. Treat it as a stopped work unit anyway.
  - Preserve the exact range, image and logs.
  - Resume only after the cause is diagnosed and corrected.
  - If the fix needs a new solver release, resume can't use it. The withdrawal keeps the release it pinned when it was created, and the next submission checks the image against that release, so it pauses again without submitting. There's no recovery path for that case yet, as with the failed case below.
  - The repaired pinning stops before publishing when a single batch overflows, so a genuine overflow normally lands here.
- **Paused, "GPU candidates failed independent CPU verification"**: `/api/jobs/:id/resume` refuses it, because it needs operator review. The repaired pinning publishes hits batch by batch, so a later batch can still fail after an earlier one has published. A candidate that passes CPU verification is credited as a hit as usual.
- **Failed, "GPU hit output exceeds supported capacity"**, where at least `HOST_HIT_CAPACITY` (64) records were published in total (checked in `server/coordinator.ts`): this is terminal in this app. `/api/jobs/:id/resume` accepts only paused jobs, and there is no reviewed recovery path.
  - The withdrawal's funding and helper outpoint reservations stay in place, because the app role can only create `OUTPOINT#` rows, never delete them. So that deposit can't be withdrawn through the app until a reviewed recovery change lands. The funds aren't lost: they stay in the vault.
  - Stop and preserve the evidence.
  - Don't work around it by hand. A recovery path needs its own reviewed change.

A failed or truncated range never receives completion credit.

The producer's guidance is "Deterministic pinning failures" in [`qsb-solver` `docs/promotion/COMBINED-RELEASE.md`](https://github.com/starknet-innovation/qsb-solver/blob/8fe127790397b6903640f8949219c1ef34a92db2/docs/promotion/COMBINED-RELEASE.md#deterministic-pinning-failures).

## Safe stop and rollback

Stop new submissions. Loss of a local process is not proof that remote GPU work stopped. Do not clear an unknown provider result by submitting it again.

Rollback cannot revive legacy writers, release consumed commitments, or duplicate paid work. Rollback does not authorize a spend and does not set `release.mainnetEnabled` or `broadcastAuthorized`.

### Rolling back past the index.html split

Commits from #96 on hold the frontend's `index.html` at `aws_s3_object.index`. Earlier commits hold it at `aws_s3_object.frontend["index.html"]` and have no `moved` block back.

**Don't apply an earlier commit directly over the current state.** Its plan deletes `aws_s3_object.index` and creates `aws_s3_object.frontend["index.html"]`, which is the same S3 key. Terraform deletes `index.html` first and uploads it again only after `terraform_data.release` is updated, so every visitor gets a 403 in between.

To roll back to such a commit:

1. Check that the commit is from before the split. This prints `0` for such a commit:
   ```sh
   git show COMMIT:terraform/data.tf | grep -c 'resource "aws_s3_object" "index"'
   ```
2. Build it as in [Updates and rollback](../terraform/README.md#updates-and-rollback): a clean checkout of that commit, `build.mjs`, and `TF_VAR_source_commit`.
3. As `qsb-operator`, in that working copy, initialized on the state backend, move the object's state address **before planning**. This changes state only, not the bucket:
   ```sh
   terraform -chdir=terraform state mv 'aws_s3_object.index' 'aws_s3_object.frontend["index.html"]'
   ```
4. Plan, then check what the plan does to `index.html`:
   ```sh
   terraform -chdir=terraform plan -out=rollback.tfplan
   terraform -chdir=terraform show -json rollback.tfplan > /tmp/qsb-rollback-plan.json
   python3 -c 'import json, sys; [print(r["address"], ",".join(r["change"]["actions"])) for r in json.load(open(sys.argv[1]))["resource_changes"] if r["address"] in ("aws_s3_object.index", "aws_s3_object.frontend[\"index.html\"]")]' /tmp/qsb-rollback-plan.json
   ```
   It must print exactly one line: `aws_s3_object.frontend["index.html"] update` or `... no-op`. If it prints a `create`, a `delete`, or `aws_s3_object.index` at all, stop and don't apply.

   **This check is required.** It is the only guard for this plan: that commit's own `check-single-pipeline.py` predates the rule that refuses a plan that creates and deletes one key. Still run that checker with `--deploy` as well, as for any deploy.
5. Apply `rollback.tfplan`. The files it drops were written by later commits with `create_before_destroy`, so they're deleted only after `index.html` is updated. But the earlier layout uploads `index.html` in parallel with the assets it names, so `index.html` can land first, and edges can briefly show a blank page.

Rolling forward needs no state command: the `moved` block in later commits moves the object back to `aws_s3_object.index`. That also applies if you ran the state move and then didn't apply the rollback.

The first forward apply after a rollback behaves like the first apply of #96, and deletes the files it drops at the start of the apply. That's because the rollback apply stores every frontend object without `create_before_destroy`, and stores `index.html` with no dependency on the other objects. The apply after that is protected again.

Between two commits that both have `aws_s3_object.index`, roll back as usual. `check-single-pipeline.py` in those commits refuses any plan that both creates and deletes one frontend object key. With `--deploy`, it also refuses any plan that replaces a frontend object or the bucket's public access block.

## Unknown paid outcomes

Treat `unknown`, `timeout`, and `http-ambiguous` as unpaid-or-paid until a provider or invoice record says which. The only action is reconcile. `reconcilePaidOutcome` returns `retry: false`. Requesting retry throws `BlindRetryRefused`. A known success is recorded once and is not submitted again.

## Withdrawal workflow failures

The withdrawal state machine's `CoordinateSearch` task invokes the coordinator Lambda (`terraform/workflow.tf`). When Lambda throttles that invoke with `Lambda.TooManyRequestsException`, for example because more withdrawals tick at once than the coordinator's reserved concurrency allows, Step Functions retries it up to 6 times with jittered exponential backoff (at most about 3 minutes in all). Lambda refuses a throttled invoke before the coordinator runs, so this retry can't repeat paid work. It is the only automatic retry.

Any failed execution needs an operator, and every failed execution raises the workflow-failures alarm. Most errors route through `NeedsOperatorAttention` (error `WorkflowInterrupted`): a task timeout, a Lambda service or client error, a coordinator error, and throttling that outlasts the retries. Some failures skip that state and fail the execution directly: `States.Runtime` and `States.DataLimitExceeded`, which the `States.ALL` catch can't catch, and reaching the 25,000-event execution history limit. So key on the failed execution, not on the state name or error. Either way the coordinator may have run, so don't restart the execution by hand. Reconcile durable intents and provider IDs first, as in [Reconcile an unknown AWS Batch submission](#reconcile-an-unknown-aws-batch-submission).

Each throttling retry adds events to the execution history. A pathological run of throttled polls could therefore reach the 25,000-event limit before the 1,000-poll continuation hands the search to a fresh execution. That fails closed: the execution fails and the alarm fires. Lowering the 1,000-poll handoff is a possible follow-up; this change doesn't touch it.

## Reconcile an unknown AWS Batch submission

Run this as `qsb-operator` against the deployed AWS Batch coordinator; see
[Reconciliation with the bootstrap operator profile](#reconciliation-with-the-bootstrap-operator-profile).
The Batch path needs no provider secret. The profile has broader deployment
privileges than this CLI uses; it is not a scoped reconciliation-only session.

An unknown POST is never retried automatically. The operator command requires an
explicit decision with an operator identifier and a public evidence reference.
Do not put credentials, wallet material, or raw logs in the evidence argument.
The identifier is an operator assertion; IAM/CloudTrail identifies the caller.

Required environment: `TABLE_NAME` (the CLI refuses MemoryStore), `AWS_REGION`,
`AWS_BATCH_JOB_QUEUE`, `AWS_BATCH_JOB_DEFINITION`, `AWS_BATCH_JOB_BUCKET`, `WORKFLOW_ARN` and `QSB_NETWORK`
(`mainnet` or `testnet4`). On mainnet, also set `QSB_MAINNET_ENABLED` explicitly to
`"true"` or `"false"`. It must match the deployed value: verify
`terraform output -raw transactions_enabled` or uncached `GET /api/config`
(`operationsEnabled`, with `network` equal to `mainnet`). Always set
`QSB_OWNER_MAX_ACTIVE_JOBS` to the deployment's `owner_max_active_jobs`: a positive
integer, or the literal `off` when that variable is null (check `ownerLimits.maxActiveJobs`
in uncached `GET /api/config`); see [Per-owner limits](#per-owner-limits). Missing or malformed
values refuse before application imports. Both modes validate the required values before application imports,
credentials, or database/provider reads and writes. The CLI needs GetItem on job/vault records, transactional PutItem
on the job, `RECONCILIATION#` and `RECONCILIATION_REQUEST#` audit rows (and, when a `--provider-id` decision claims an owner's withdrawal slot, Query on the owner's `JOB#` rows and PutItem on its `LIMIT#ACTIVE_JOBS` row) and the owner's `EVENT#` row, GetItem and PutItem on the owner's `WEBHOOK#<owner>` / `WEBHOOKS` row (to queue webhooks, never to send them), Batch DescribeJobs/ListJobs/DescribeJobQueues, S3 GetObject on the configured outputs prefix, and StartExecution on the configured workflow. The CLI never submits or cancels Batch jobs and does not broadcast; the `qsb-operator` session itself has broader deployment and data permissions.

To attach a known provider ID from AWS Batch's console and matching operator logs:

```
npx tsx scripts/reconcile-submission.ts OWNER JOB --provider-id PROVIDER_ID --operator OPERATOR --evidence audit://incident/reference
```

The command reads Batch job status and immutable S3 results, binding the queue, definition revision and input SHA256. The operator must bind live/terminal IDs to this exact
job, stage, range, endpoint and submission window using logs/console evidence.
Completed outputs additionally must match the stored manifest, stage, attempt,
kernel and exact range. Attachment grants no completion credit: the coordinator
still validates the output and CPU-checks hits. For an already-recorded ID on a `searching` job, reconciliation atomically increments
its revision and writes `RECONCILIATION#<jobId>#<priorRevision>` before restarting
polling as `<jobId>-r<newRevision>`. The provider ID, submission intent, spend
accounting and reservations are preserved; no paid request is submitted or cancelled.
Concurrent changes to the job reject the transaction, without starting polling.
An old execution exits on its next coordinator revision check.

This new name is necessary because [AWS Standard StartExecution semantics](https://docs.aws.amazon.com/step-functions/latest/apireference/API_StartExecution.html)
reject reuse of a closed execution's name with `ExecutionAlreadyExists` for 90 days.
Same-name idempotency only applies while the execution is running with identical input.
Each successful reconciliation, including rerunning after a workflow-start failure,
creates a fresh audited revision rather than reusing a possibly closed execution name. The CLI does not change deployment switches. Its explicit
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

### Job-definition revision changes and recovery

Do not change `batch_job_definition` or its container properties while any withdrawal
is `searching`, has an attached nonterminal provider job, or is paused with an
unknown submission. Keep admission/resume quiescent during the change; reconcile
outstanding intents and confirm all provider jobs are terminal and the queue is
drained first. A paused unknown request is outstanding even when the queue is empty.

The current adapter deliberately requires the configured revision to match the
saved `batchSubmission.definition` for discovery and polling. Updating container
properties creates a new revision; Terraform deregisters the previous revision by
default. [Terraform documents this revision behavior](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/batch_job_definition.html).
[AWS JobDetail](https://docs.aws.amazon.com/batch/latest/APIReference/API_JobDetail.html)
returns the definition ARN used by the job. Changing the configured ARN does not
migrate existing requests to the new revision.

If configuration already advanced, recover using the original binding:

1. Read the affected job's durable `batchSubmission` through the scoped operator
   role. Preserve its exact `definition`, `queue`, job name, input key/hash and
   provider ID; never edit them to match the new deployment.
2. Set `AWS_BATCH_JOB_DEFINITION` in the reconciliation CLI environment to that
   recorded revisioned ARN, and use the original queue and output bucket. This
   applies to explicit IDs, `--provider-id discover`, and
   `--not-submitted batch-window-elapsed`, including after seven days. The existing
   elapsed-window, exact-name discovery, queue-drain and one-replacement checks
   still apply; a revision mismatch is not evidence of rejection.
3. Before any command that restarts polling, restore the coordinator's
   `batch_job_definition` to the same recorded ARN through the reviewed deployment
   procedure below, and verify the live `AWS_BATCH_JOB_DEFINITION`. Changing only
   the CLI environment does not change Lambda. Keep new admissions/resumes
   quiescent and handle different outstanding revisions separately.
4. Reconcile and finish the original provider request before switching forward.
   A deregistered old definition is not eligible for new submissions: `prepareRun`
   requires `ACTIVE`. Do not resume a replacement against an inactive revision or
   re-register/re-submit the original paid request as a recovery shortcut. If more
   search work is needed, select an active, image-compatible reviewed definition
   only after the original request is terminal or its unknown outcome has been
   explicitly reconciled. Preserve reservations and all recorded GPU time.

This is an operator recovery procedure, not automatic revision migration or
permission to deploy. Image/release compatibility remains a separate admission
check. The documentation change has not exercised a live revision rollback.

## Commit before deploy

Never deploy code or infrastructure changes before committing them to Git. Verify that deployed source matches the recorded commit and contains no uncommitted changes. Push the commit to the project remote before deployment and report the commit or PR with the deployment target. Never commit secrets or ignored runtime configuration.

Local builds and source flags are not live-configuration evidence. A clean pushed commit is necessary and is not itself a deployment. Record the source-manifest sha256, the configuration hash, and, once an image exists, the image config digest, the OCI index digest, and the registry manifest digest as separate `sha256:` values. Do not relabel a source hash as an image digest.

## Spend authorization

Every proposed mainnet spend requires a separate exact-transaction authorization. The activation decision does not carry the transaction id, amount, or fee, and it does not set `broadcastAuthorized`. An exact spend record is still not a broadcast. This checkout grants neither.

### Parallel GPU search

`workersMax` in `server/gpu-spend.json` (1–16) is how many GPUs one withdrawal may use at once. Size it to the account's approved "Running On-Demand G and VT instances" quota in the stack's region: one `g5.xlarge` uses 4 vCPUs, so `workersMax` is at most quota ÷ 4. Both stacks follow the same value: the GPU stack sets the compute environment's `max_vcpus` to 4 × `workersMax`, and the coordinator refuses to submit ("nothing was submitted") unless the live compute environment matches exactly.

With `workersMax` 1 the single-submission path is unchanged. Above 1, the coordinator runs chunks of one stage side by side:

- **Each chunk is its own paid submission.** Its slot (stage, chunk, request identity) and its 900-second reservation are saved in one conditional write before its `SubmitJob`, exactly as for one GPU. Nothing is resubmitted automatically.
- **Credit is contiguous.** Chunks can finish out of order; `attempt` only moves past chunks that have all finished, and finished chunks above it are kept in `completedAttempts`.
- **A verified hit moves the whole withdrawal to the next stage.** Chunks still running for the old stage are cancelled and never credited; their reservations are not refunded.
- **Any interrupted or incomplete chunk pauses the withdrawal.** The other chunks keep running and their results are kept; resume repeats the interrupted chunk once.
- **A slot without a provider ID is an unknown outcome** and pauses the withdrawal, as on the single-GPU path.
- **The budget is unchanged per chunk:** N GPUs reserve N × 900 seconds at a time. Search finishes up to N times sooner, and the total reserved per chunk is the same.

A single-GPU job that is resumed after `workersMax` is raised has its running submission adopted as a slot and stays on the parallel path from then on, even if `workersMax` later returns to 1.

**Changing `workersMax`** is a capacity change: never while a chunk is running.
1. Pause each running withdrawal in the app and wait until its GPU jobs have stopped (the queue is empty).
2. Confirm the quota covers 4 × `workersMax` vCPUs; request an increase first if not.
3. Change `server/gpu-spend.json` through a reviewed PR, then apply the GPU stack and the app stack from that commit. Either order fails closed until both match.
4. Resume the withdrawals.

**Reconciling a parallel search** uses the same CLI. The decision applies to the single chunk whose POST outcome is unknown (more than one unknown chunk is refused): discovery and `--provider-id` attach to that chunk, the 35-minute window is measured from that chunk's own start, and the queue must be drained, so pause the withdrawal first and wait for its other chunks to stop. A `not-submitted` decision returns just that chunk to the pool, and resume submits it once more with a new intent.

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

### Per-owner limits

Three Terraform variables, all off by default, limit one owner for the partner
phase. They reach the API and coordinator Lambdas only and only add refusals: the
per-job cap above always applies. See [docs/API.md](API.md#per-owner-limits) for the
routes and error codes.

**Every limit is per address.** An owner is the address string exactly as the wallet
signed in, with no normalisation: a differently spelled form of the same wallet
address is another owner, with its own `OWNER#` partition, slots and GPU budget.
Without an allowlist, a fresh address gets fresh limits; with one, a partner with N
listed addresses gets N of each.

**`owner_allowlist`** (`QSB_OWNER_ALLOWLIST`): only listed addresses may register
vaults, deposit, create or resume withdrawals, or register webhooks. Terraform refuses a list over 2500
characters (joined with commas), so both Lambdas keep room under their 4 KB
environment limit and an apply can't update one and fail the other. Before setting or
shrinking it:
- **Inventory owners with a confirmed vault or a live withdrawal.** An unlisted owner
  with a funded vault can't create a withdrawal at all (403), and only that owner's
  withdrawal can spend the vault, so the funds wait until the owner is listed.
  Leaving `POST /api/jobs/:id/submit` open only helps an owner whose withdrawal is
  already solved.
- **Unlisted owners' live withdrawals pause at their next coordinator tick**, and their
  executions end. Their running AWS Batch jobs aren't cancelled: that time is already
  reserved, and they run to completion with nothing polling them. Resume stays
  refused (403) until the owner is listed again; then resume polls the saved provider
  IDs. Re-list promptly, while AWS Batch still holds the results (verify its
  retention).

**`owner_max_active_jobs`** (`QSB_OWNER_MAX_ACTIVE_JOBS`): a withdrawal holds a slot
only while queued or searching. Pausing it, or its reaching failed,
awaiting_authorization, submitted or confirmed, frees the slot on that status write.
The only ways back to queued or searching claim a slot again, in the same transaction
as that write, through the owner's `LIMIT#ACTIVE_JOBS` row: creation, resume (429
`owner_active_withdrawal_limit` at the limit, nothing written or started) and an
operator's provider-id reconciliation of a paused job. The fence row also names the
last claimant, so a half-visible concurrent claim still counts. Of two claims racing
for the last slot, one gets a conflict and writes nothing. Withdrawals created before
the limit was set count too. The coordinator never un-pauses a job, and pause stays
unrestricted.
- **Some pauses leave GPU work running.** The limit caps concurrent claims, not
  instantaneous GPU use. A pause from a disabled deployment, allowlist removal, missing
  compute configuration or, on the parallel path, a stopped chunk, a failed CPU check
  or a failed preparation frees the slot but doesn't cancel the chunks already running;
  they finish with nothing polling them, and the owner may create or resume another
  withdrawal meanwhile. The overlap is bounded by the chunks in flight at the pause,
  each at most one `executionTimeoutMs`, and each was charged to the owner's GPU
  budget before its POST, so total spend stays capped. A user pause cancels them.
- **Reconciliation.** The reconcile CLI refuses before any write unless
  `QSB_OWNER_MAX_ACTIVE_JOBS` is the deployed value, a positive integer, or `off`, as
  above. A `--provider-id` decision on a paused job claims a slot with the attachment;
  at the limit it refuses with `OwnerActiveWithdrawalLimit` and writes nothing, so pause
  another of the owner's withdrawals or raise the limit, then retry. With `off` it
  refuses with `OwnerActiveJobLimitRecorded` if the owner has a `LIMIT#ACTIVE_JOBS`
  row, since a limit has been in force: check the deployment's value again. If the limit
  really is off now, delete that row (it only fences claims) and retry. A
  `--not-submitted` decision leaves the job paused and claims nothing; its resume
  claims. The claim needs Query, which `qsb-operator` has but the dormant scoped
  reconcile role (`terraform/policies/operator-reconcile-records.json`) doesn't.
  Activating that role for reconciliation would need an `OWNER#`-conditioned
  `dynamodb:Query` added: an IAM change, so warn the AWS administrator first.

**`owner_max_gpu_seconds`** (`QSB_OWNER_MAX_GPU_SECONDS`), at least one submission's
reservation (`executionTimeoutMs` in `server/gpu-spend.json`, 900 seconds today);
Terraform refuses less, and the Lambdas treat less as invalid:
- **IAM sandbox check first.** With this set, the coordinator writes the job row and
  the owner's `LIMIT#GPU_SECONDS` row in one `TransactWriteItems` of two conditional
  `OWNER#` Puts. Its `PutItem` grant requires `dynamodb:LeadingKeys`, and whether AWS
  sets that key for each item of a transaction is unverified; the live sandbox
  ([APP-ROLE-SANDBOX.md](APP-ROLE-SANDBOX.md)) has only run the API role. Before this
  variable is ever set, run that transaction as the coordinator role in the sandbox.
  If it's denied, every paid submission would fail with AccessDenied: nothing is
  written or sent, but all GPU work stops. Don't set the variable then. The fix is an
  IAM change, which goes to the AWS administrator first.
- **Charging.** Before each paid POST, on the one-GPU and the parallel path, the
  coordinator charges the owner in the same conditional write as the job's
  reservation: what the job has reserved beyond its `ownerGpuChargedSeconds`. A job
  that started before the limit was set is charged its earlier reservations at its
  next submission; withdrawals that finished earlier are never charged. Charges are
  never refunded, whatever the outcome.
- **At the budget** the coordinator behaves as at the per-job cap: it starts no new
  paid submission, lets running chunks finish, and pauses with "Owner GPU-time budget
  reached". It never touches or resubmits in-flight work. Job creation is refused
  once less than one submission's reservation is left, and fails with a 409 if
  another withdrawal charges the budget in between, so no inputs are reserved to a
  withdrawal that can't search.

To give an owner more GPU time, raise the variable and apply, then resume their
paused withdrawals. Lowering a limit below current use refuses new work only. Record
any change in the deployment record, as for the mainnet switches.

### App-role IAM merge gate

See [APP-ROLE-SANDBOX.md](APP-ROLE-SANDBOX.md) for the reproducible 60-decision
read-only simulation and exact regional transaction/batch requests, expected
responses and consistent-read checks. The live sandbox portion remains pending
operator confirmation; simulator output alone does not release the merge hold.

### Reconciliation with the bootstrap operator profile

This profile procedure requires #54's Batch CLI and deployed coordinator. The
older Runpod version requires secret access that `qsb-operator` does not have;
it fails closed. Do not use it or add secret permissions as a workaround.
For both provider-submission and TX# reconciliation, use the MFA-backed
`qsb-operator` profile from [the access runbook](../ops/github-aws/README.md#use-them).
The user may assume only the two bootstrap roles, and the roles cannot chain.
Do not configure a `qsb-reconcile-mfa` profile pointing at the runtime reconcile
role: those explicit denies make it unreachable. Terraform's separately scoped
`operator_reconcile_role_arn` remains dormant for this bootstrap user.

The actual `qsb-operator` session has deployment privileges, including
`dynamodb:*` on QSB tables. It is not restricted to OWNER partitions and can
Query/Scan/Update/Delete and access SYSTEM/OUTPOINT records. The reconciliation
CLI's exact-record, conditional-version and audit checks provide the operational
restriction here; the session's IAM policy does not enforce the narrower CLI
scope. Do not describe this profile as a least-privilege reconciliation identity.

Have the human establish the MFA session first. Run inside a subshell to keep
exported credentials out of the parent shell; never print or share credentials:

```sh
(
  set +x
  set -e
  aws sts get-caller-identity --profile qsb-operator
  session_exports="$(aws configure export-credentials --profile qsb-operator --format env)" || exit 1
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
  # Set explicitly to the verified deployed switch; false refuses mainnet polling.
  export QSB_MAINNET_ENABLED='false'
  # Set explicitly to the deployed owner_max_active_jobs, or off when it is null.
  export QSB_OWNER_MAX_ACTIVE_JOBS='off'
  npx tsx scripts/reconcile-submission.ts OWNER JOB --provider-id PROVIDER_ID --operator OPERATOR --evidence audit://incident/reference
)
```

Use the intended deployment's values, including the recorded Batch definition
revision for recovery of an older request. Verify the deployed coordinator uses
that revision before restarting polling; changing local environment does not
change Lambda. The CLI makes no paid submission and does not broadcast, though
the operator identity has broader capabilities. This example is not permission
to attest non-submission, resume paid work or activate mainnet. All existing
reconciliation evidence requirements and exact-spend authorization still apply.
No secret retrieval is needed by the Batch path. Live profile/MFA behavior remains
a post-bootstrap check in the linked access runbook.

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
2. Under the bootstrap qsb-operator session above (with its broader deployment privileges), set `TABLE_NAME`,
   `AWS_REGION` and `QSB_NETWORK=mainnet` for the intended deployment, then run:

   ```sh
   npx tsx scripts/reconcile-withdrawal.ts OWNER JOB \
     --operator OPERATOR --evidence audit://incident/reference
   ```

   This command records a conditional observation of the existing original
   intent. It performs chain/miner GETs and OWNER-row database writes only:
   transactional PutItem on the `TX#` and `JOB#` rows and the owner's `EVENT#`
   row, then GetItem and PutItem on the owner's `WEBHOOK#<owner>` / `WEBHOOKS` row to queue
   webhooks (they are sent by the API or coordinator, never from the operator's
   machine).
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

Each transactional Put is authorized as `dynamodb:PutItem` with its own leading
key, so the `EVENT#` row needs no grant beyond `OWNER#*` PutItem. That is AWS's
per-item authorization of TransactWriteItems; verify it against the current AWS
documentation before relying on a narrower policy.

The withdrawal API Lambda has a 120-second timeout; API Gateway still returns
a timeout after its 30-second integration budget. A caller timeout does not stop
an already running Lambda or prove the miner never received the POST. Treat it as
an uncertain withdrawal and follow the TX# observation procedure above. Do not
retry the POST or reset its durable intent.

## Webhook signing secrets

Each owner's `WEBHOOK#<address>` / `WEBHOOKS` row holds the signing secret of each
registered webhook in plaintext, because HMAC signing needs it (see
[API.md](API.md)). The row has its own partition, apart from the owner's `OWNER#`
rows, so a role can be granted webhook rows alone. Handle it as a credential:

- Readers: the API role, the coordinator role (its GetItem is not
  prefix-restricted), the webhook dispatcher's role when it is enabled (GetItem on
  `WEBHOOK#` keys only; see [Scheduled webhook dispatcher](#scheduled-webhook-dispatcher))
  and any operator session with table read access. The due-delivery index is keys
  only, so a query of it returns no secret.
- Backups: point-in-time recovery is on for the table, so a secret stays in its
  backups until they age out of the recovery window (35 days unless the table is
  configured shorter; check the table's setting). Deleting a webhook doesn't purge
  backups. Treat a restore or backup export as containing live secrets.
- Exports: `npm run inventory:storage` drops `hooks[].secret` before it checks a
  snapshot for credentials. Any other export or copy of the table must drop that
  field too. Never paste a `WEBHOOKS` row into an issue or log.
- Rotation: the owner deletes the webhook and registers it again.
- Follow-up, not built: envelope encryption with KMS or a Secrets Manager key
  would keep plaintext secrets out of the table and its backups. It needs new IAM
  grants for every role that signs or seals: the API, the coordinator, and the
  [webhook dispatcher](#scheduled-webhook-dispatcher) (decrypt to sign, encrypt to
  re-seal, a key-policy entry, and the key's `SecretBox` wired into the dispatcher's
  delivery). So it needs the AWS admin's heads-up first. Without the dispatcher's
  part, the dispatcher can't sign sealed webhooks: it defers their rows hourly in
  the index, and only the API sends them.

## Scheduled webhook dispatcher

Queued webhook deliveries are sent at the end of API requests and coordinator
ticks for the same owner. Once a withdrawal's last tick has run, a retry that falls
due later waits for that owner's next activity. The dispatcher closes that gap:
every 5 minutes EventBridge Scheduler invokes the `<name>-webhooks` Lambda
(`server/webhook-dispatcher.ts`), which asks the due-delivery index which owners
have a delivery due and runs the same delivery round as the API and coordinator
(`deliverDue`: SSRF checks, HMAC signing, leases, backoff, the failing state).

- **Index.** `webhook-due` is a sparse, keys-only global secondary index of the
  records table on `webhookQueue` and `webhookDueAt`. Every write of a `WEBHOOKS`
  row sets those two attributes from the row's own queue, in the same PutItem, so
  the index adds no request and can't disagree with the row. A row written by older
  code is corrected on its owner's next delivery round. The index is on the table
  whatever the switch: the provider keeps an index whose block is removed, so it
  couldn't be switched off cleanly, and unused it costs next to nothing.
- **Bounds.** One run takes at most 50 owners, most overdue first, serves 4 at a
  time with up to 5 rounds of 10 deliveries each, and stops starting rounds after
  40 seconds. The Lambda times out at 60 seconds and runs one at a time (reserved
  concurrency 1, taken from the account's unreserved pool). Neither Scheduler nor
  Lambda retries a failed run (`maximum_retry_attempts = 0` on both), since the
  next run finds the same due deliveries; one failure counts one error.
- **Stuck owners.** If an owner's row is still due on a consistent read but its
  first round claims nothing, because it holds deliveries the dispatcher can't
  send, the dispatcher pushes the row back an hour in the index
  (`webhookDeferredUntil`). Such owners can't hold the head of every run's query
  and starve the others. Only the index moves; the API and coordinator still send
  the row's deliveries.
- **Isolation.** It runs no coordinator, API, payment or reconcile code, and its
  bundle contains none (a test checks the bundle's inputs). Its role may query the
  index and GetItem and PutItem on `WEBHOOK#` keys only, the owners' webhook
  partitions. So it can't read or write a job, vault, intent, event, reservation or
  system row. The schedule's role may only invoke it.
- **Switch.** `webhook_dispatcher_enabled`, default `false`. Off, Terraform plans
  no dispatcher Lambda, invoke settings, role or schedule, and deliveries behave as
  before.

**What any apply of this version changes, switch on or off.** The table gains the
`webhook-due` index (an in-place update that backfills it). The coordinator's
record policy (`terraform/policies/coordinator-records.json`) also lets it PutItem
`WEBHOOK#` keys, because `settle()` now queues and delivers through the owner's
`WEBHOOK#` row. Webhooks weren't deployed anywhere before this, so no row moves.

**The dormant reconcile role.** The scoped reconcile role
(`operator-reconcile-records.json`) still allows only `OWNER#` keys. Reconciliation
through it records the owner event but can't queue its webhooks; the enqueue is
best-effort and logged. Reconciliation runs as `qsb-operator`, which can.

**Admin steps, before the first enable.** The switch needs an IAM update that only
the AWS administrator can install:

1. From a clean `main` that includes this change, run
   `ops/github-aws/update_installed.py` in plan mode as `qsb-viewonly`. Expect
   `differs` for `qsb-github-deploy/qsb-terraform-deployment` and the
   `qsb-operator-N` policies, and nothing else: `PassRuntimeRoles` also names
   `scheduler.amazonaws.com`, and a new `QsbSchedules` statement allows
   Create/Get/Update/DeleteSchedule on `schedule/default/qsb-*`. The runtime
   boundary is `identical`: it already allows everything the two new roles use.
   If the plan shows a different number of operator policies, stop: that needs a
   separately reviewed step.
2. Review it, then `--apply` as the administrator, confirmed or with
   `--yes --plan-hash`.
3. Run `verify.py --role-arn` against `qsb-github-deploy`; it includes the new
   schedule, PassRole, tagging and invoke-settings cases.

**Enable.** Then, as `qsb-operator`, set `webhook_dispatcher_enabled = true` and
plan. The plan adds one Lambda with its log group, error alarm and async-invoke
settings, the two roles, three role policies and the schedule, and changes nothing
else. Run `check-single-pipeline.py --deploy` on it, then apply.

**Check.** Within 10 minutes the dispatcher's log group shows one
`{"webhookDispatch": {...}}` line of counts per run and no errors, and the
`<name>-webhooks-errors` alarm stays quiet.

**Back out.** Set the switch to `false` and apply. That removes the schedule,
Lambda, its invoke settings and the two roles. The index and the rows' index
attributes stay and do nothing on their own; deliveries go back to requests and
ticks only.

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

It requires at least 35 minutes since the durable submission start (30-minute watchdog ceiling plus its 5-minute interval), with no maximum age. Exact-name discovery must return no job across all pages/statuses, and the QSB queue must have zero submitted, pending, runnable, starting and running jobs. Discovery failure or multiple matches refuses recovery. A discovered job is attached through the normal identity-checked provider-ID path instead. After seven days, an absent discovery result is no longer evidence that the job never existed; a drained queue after the required wait still permits the explicitly accepted bounded replacement. Positive discovery still attaches one match and multiple matches or a service error still refuse recovery. Old jobs without saved identity cannot use this path.

This is an explicitly accepted bounded duplicate risk, not proof of non-acceptance. One such replacement is allowed per uncertain request, keyed by its saved Batch job name in an immutable `RECONCILIATION_REQUEST#<jobId>#<jobName>` audit row. The row and pending `batchReplacementFor` marker are recorded atomically with the normal revision audit. Resume consumes the one-shot allowance; the next paid-intent write clears the pending marker while recording a new request identity. The immutable request audit prevents granting the same old request another replacement. A later, separate uncertain submission in that withdrawal has its own single replacement under the same checks. Neither prior spend nor reservations are cleared; the replacement consumes the normal 15-minute budget reservation. The recorded-4xx fast path is unchanged. This command never submits GPU work itself. `ttl-expired` remains invalid for AWS Batch.

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
