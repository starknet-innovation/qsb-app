# Operational runbook

Procedures for the deployed stack. Operator commands run as `qsb-operator` (see [Operator session](#operator-session)); administrator steps stay with the AWS administrator ([ops/github-aws/README.md](../ops/github-aws/README.md#what-stays-with-the-aws-administrator)). Nothing here authorizes a spend: every mainnet withdrawal still needs the user's approval of its exact transaction, amount and fee.

## Deploy-time mainnet and submit switches

Two Terraform variables, both `false` by default:
- `mainnet_enabled` sets `QSB_MAINNET_ENABLED` on **both** the API and the coordinator. Only the exact string `"true"` enables mainnet funding, job creation and resume. The reconcile CLI also reads this variable and needs the deployed value set explicitly (see below).
- `exact_submit_enabled` sets `QSB_EXACT_SUBMIT_ENABLED`. Every miner submission needs both switches: relaying a signed deposit (`/fund/submit`, `/fund/resubmit`, and the manual-export bytes from `/fund/signed`) and submitting a withdrawal, which also needs the exact-spend, offline Core and approval checks ([EXACT-SUBMIT.md](EXACT-SUBMIT.md)). Otherwise these routes refuse with `submit_disabled`.

| mainnet_enabled | exact_submit_enabled | Result |
| --- | --- | --- |
| false | false | Mainnet funding, search and submission disabled |
| false | true | Mainnet operations and submission still disabled |
| true | false | Search and resume allowed; the signed withdrawal can be downloaded; nothing is sent to the miner, so neither deposits nor withdrawals can be submitted |
| true | true | Deposits can be relayed; a withdrawal is submitted only after explicit user approval and all exact-spend/Core/intent checks |

The browser reads the same setting through uncached `GET /api/config` (`operationsEnabled`, bound to `network`) and rechecks it before funding and search. Absent, malformed and cross-network config stays disabled. Default-off refusals write no jobs, start no workflows and contact no miner. Neither switch approves a transaction or resubmits uncertain work.

The source flags `release.mainnetEnabled` and `broadcastAuthorized` stay `false`: they are not the deployed switches, and `terraform/scripts/build.mjs` refuses a build where `release.mainnetEnabled` isn't `false`. Changing a switch changes only the Lambda environments, from the same clean committed build; no source edit or frontend rebuild is needed.

**Changing a switch** needs the user's explicit approval (`AGENTS.md`). Record the approved values in the private deployment record; never commit tfvars. After the apply, check `terraform output -raw transactions_enabled`, `terraform output -raw exact_submit_enabled` and an uncached `GET /api/config`. The Git commit alone does not establish the deployed values.

**Turning mainnet off** blocks new funding, search and submission, and pauses non-terminal coordinator jobs with a deployment-disabled error. Provider IDs, uncertain intents, spend accounting and reservations stay intact, and already submitted GPU jobs are not cancelled. After enabling again, resume a paused job to poll its existing provider ID. Never reset an intent or submit a replacement because the switch was toggled.

## GPU capacity and spend

`server/gpu-spend.json` is the bundled source of truth: `workersMax` (GPUs per withdrawal, 1–16), `workersMin` 0, `executionTimeoutMs` 900000 and `maxJobGpuSeconds` 14745600. Changing it needs a reviewed PR, then a build and deploy of both stacks.

### GPU-time allowance

Each withdrawal may reserve at most 14,745,600 GPU-seconds (4,096 GPU-hours), across retries and all stages. The user chose this on PR #36. The planning calculation takes Config A's upstream honest-work comment of roughly 2^47 candidates (`public/qsb/qsb_pipeline.py:255`), divided by the roughly 2^34 candidates per subset range in `server/search-ranges.ts`: 8,192 range-equivalents. Reserving 900 seconds each gives 2,048 GPU-hours; a 100% margin gives 4,096. This is a planning assumption from a code comment, not a measured runtime or a success guarantee, and pinning geometry differs. If the estimate is per round rather than total, the allowance must be reassessed through review.

Before every paid submission, the coordinator atomically saves the greater of cumulative reserved seconds and observed compute seconds, plus that submission's timeout (900 seconds), and pauses if this would exceed the budget. That permits 16,384 worst-case reservations from a fresh job.

Reservations are permanent: short runs, failed, cancelled or timed-out jobs, unknown POST outcomes, stage changes and resume requests never refund or reset them. `computeSeconds` is observed execution telemetry, not billing data. Jobs with a recorded legacy submission count reserve 900 seconds per historical submission; new jobs initialize their reservation at creation, and missing or invalid accounting pauses for reconciliation. The stage-local `attempt` is only a range index. A 64-hit output is never credited as a finished range.

Startup, idle time, storage and provider billing behaviour are not capped by this allowance. AWS Lambda concurrency is not a GPU spending cap either.

Before a paid claim, a preparation failure pauses with "Solver contract, compute provider configuration or public input upload unconfirmed; nothing was submitted" and leaves the reservation unchanged: fix the cause, then resume. A failure after the paid SubmitJob is an unknown submission: [reconcile it](#reconcile-an-unknown-aws-batch-submission), never retry it. The coordinator Lambda's 90-second timeout covers the CPU export, the compute-limits check, the SubmitJob call (20 seconds) and the database writes; it narrows timeout exposure but doesn't make the call and the write atomic.

### Measured GPU usage

Each job's `usage` records the AWS Batch time its GPU chunks took ([`server/gpu-usage.ts`](../server/gpu-usage.ts)). Each time a chunk is seen finished, its Batch record's times are added once:

- `runMs`, the total of `stoppedAt` − `startedAt`: the time the containers ran on a GPU. A failed or cancelled chunk with no start time never started and ran for none. A completed chunk did run, so a missing start time leaves its time unmeasured.
- `queueMs`, the total of `startedAt` − `createdAt`, or `stoppedAt` − `createdAt` for a chunk that never started: waiting for a GPU, starting the instance and pulling the image.

`chunks` and `failed` count the chunks by outcome. `unmeasured` counts chunks with a missing or out-of-order time for either interval; whatever times they do have still count. A chunk kept on the job, for resume or for an operator's CPU-check review, is marked so it's counted once.

Each tick saves a chunk's time as soon as it sees the chunk finished, before reading the next chunk's status or checking any output. So a tick that then stops for an operator still records it, whether it stops on a failed status call, a context or range mismatch, or a succeeded chunk whose output can't be read or checked. That save holds only the metering, on top of the job as last saved, never the tick's other unfinished changes. Each chunk is still acted on, including being cancelled, right after its own status is read.

A chunk is metered only once a tick sees it finished. These are seen:
- chunks the owner's pause or the end of the withdrawal stops: that tick keeps polling until none is active;
- chunks that finish while the job is searching.

These aren't seen: chunks still running when a tick pauses the job for a stopped chunk, a failed CPU check, a failed preparation or a deployment switch (see "Some pauses leave GPU work running" below). They finish with nothing polling them, and stay on the job, unmetered, until a resume polls them.

`usage` is a measurement, unlike the reservations above. It doesn't decide what is submitted, credited or cancelled, and it doesn't change the budget. It still isn't a bill:

- GPU instances are shared between chunks and stay up for a while after the last one, so idle and instance-boot time outside a chunk's own `createdAt`–`stoppedAt` isn't in it. Neither are Lambda, Step Functions, S3 or DynamoDB.
- It's recorded on the parallel search path, which every withdrawal takes while `workersMax` is above 1. `tests/parallel-search.test.ts` fails if `workersMax` is set to 1, because the single-GPU path isn't metered.
- Jobs created before metering have no `usage`, or only the chunks finished since.
- A slot on the job without `metered` is a chunk not yet seen finished. Before treating `usage` as complete, check that every slot is metered.

### Parallel GPU search

`workersMax` is how many GPUs one withdrawal may use at once. Size it to the account's approved "Running On-Demand G and VT instances" quota in the stack's region: one `g5.xlarge` uses 4 vCPUs, so `workersMax` is at most quota ÷ 4. Both stacks follow the same value: the GPU stack sets the compute environment's `max_vcpus` to 4 × `workersMax`, and the coordinator refuses to submit ("nothing was submitted") unless the live compute environment matches exactly.

With `workersMax` 1 there is one submission at a time. Above 1, the coordinator runs chunks of one stage side by side:

- **Each chunk is its own paid submission.** Its slot (stage, chunk, request identity) and its 900-second reservation are saved in one conditional write before its `SubmitJob`. Nothing is resubmitted automatically.
- **Credit is contiguous.** Chunks can finish out of order; `attempt` only moves past chunks that have all finished, and finished chunks above it are kept in `completedAttempts`.
- **A verified hit moves the whole withdrawal to the next stage.** Chunks still running for the old stage are cancelled and never credited; their reservations are not refunded.
- **Any interrupted or incomplete chunk pauses the withdrawal.** The other chunks keep running and their results are kept; resume repeats the interrupted chunk once.
- **A slot without a provider ID is an unknown outcome** and pauses the withdrawal.
- **The budget per chunk is unchanged:** N GPUs reserve N × 900 seconds at a time. Search finishes up to N times sooner for the same total reservation.

A single-GPU job that is resumed after `workersMax` is raised has its running submission adopted as a slot and stays on the parallel path from then on, even if `workersMax` later returns to 1.

**Changing `workersMax`** is a capacity change: never while a chunk is running.
1. Pause each running withdrawal in the app and wait until its GPU jobs have stopped (the queue is empty).
2. Confirm the quota covers 4 × `workersMax` vCPUs; request an increase first if not.
3. Change `server/gpu-spend.json` through a reviewed PR, then apply the GPU stack and the app stack from that commit. Either order fails closed until both match.
4. Resume the withdrawals.

### Per-owner limits

Three Terraform variables, all off by default, limit one owner. They reach the API and coordinator Lambdas only and only add refusals: the per-job allowance above always applies. See [API.md](API.md#per-owner-limits) for the routes and error codes.

**Every limit is per address.** An owner is the address string exactly as the wallet signed in, with no normalisation: a differently spelled form of the same wallet address is another owner, with its own `OWNER#` partition, slots and GPU budget. Without an allowlist, a fresh address gets fresh limits; with one, a partner with N listed addresses gets N of each.

**`owner_allowlist`** (`QSB_OWNER_ALLOWLIST`): only listed addresses may register vaults, deposit, create or resume withdrawals, or register webhooks. Terraform refuses a list over 2500 characters (joined with commas), so both Lambdas keep room under their 4 KB environment limit and an apply can't update one and fail the other. Before setting or shrinking it:
- **Inventory owners with a confirmed vault or a live withdrawal.** An unlisted owner with a funded vault can't create a withdrawal at all (403), and only that owner's withdrawal can spend the vault, so the funds wait until the owner is listed. Leaving `POST /api/jobs/:id/submit` open only helps an owner whose withdrawal is already solved.
- **Unlisted owners' live withdrawals pause at their next coordinator tick**, and their executions end. Their running AWS Batch jobs aren't cancelled: that time is already reserved, and they run to completion with nothing polling them. Resume stays refused (403) until the owner is listed again; then resume polls the saved provider IDs. Re-list promptly, while AWS Batch still holds the results (verify its retention).

**`owner_max_active_jobs`** (`QSB_OWNER_MAX_ACTIVE_JOBS`): a withdrawal holds a slot only while queued or searching. Pausing it, or its reaching failed, awaiting_authorization, submitted or confirmed, frees the slot on that status write. The only ways back to queued or searching claim a slot again, in the same transaction as that write, through the owner's `LIMIT#ACTIVE_JOBS` row: creation, resume (429 `owner_active_withdrawal_limit` at the limit, nothing written or started) and an operator's provider-id reconciliation of a paused job. The fence row also names the last claimant, so a half-visible concurrent claim still counts. Of two claims racing for the last slot, one gets a conflict and writes nothing. Withdrawals created before the limit was set count too. The coordinator never un-pauses a job, and pause stays unrestricted.
- **Some pauses leave GPU work running.** The limit caps concurrent claims, not instantaneous GPU use. A pause from a disabled deployment, allowlist removal, missing compute configuration or, on the parallel path, a stopped chunk, a failed CPU check or a failed preparation frees the slot but doesn't cancel the chunks already running; they finish with nothing polling them, and the owner may create or resume another withdrawal meanwhile. The overlap is bounded by the chunks in flight at the pause, each at most one `executionTimeoutMs`, and each was charged to the owner's GPU budget before its POST, so total spend stays capped. A user pause cancels them.
- **Reconciliation.** The reconcile CLI refuses before any write unless `QSB_OWNER_MAX_ACTIVE_JOBS` is the deployed value, a positive integer, or `off`, as described below. A `--provider-id` decision on a paused job claims a slot with the attachment; at the limit it refuses with `OwnerActiveWithdrawalLimit` and writes nothing, so pause another of the owner's withdrawals or raise the limit, then retry. With `off` it refuses with `OwnerActiveJobLimitRecorded` if the owner has a `LIMIT#ACTIVE_JOBS` row, since a limit has been in force: check the deployment's value again. If the limit really is off now, delete that row (it only fences claims) and retry. A `--not-submitted` decision leaves the job paused and claims nothing; its resume claims. The claim needs Query, which `qsb-operator` has but the dormant scoped reconcile role (`terraform/policies/operator-reconcile-records.json`) doesn't. Activating that role for reconciliation would need an `OWNER#`-conditioned `dynamodb:Query` added: an IAM change, so warn the AWS administrator first.

**`owner_max_gpu_seconds`** (`QSB_OWNER_MAX_GPU_SECONDS`), at least one submission's reservation (`executionTimeoutMs`, 900 seconds today); Terraform refuses less, and the Lambdas treat less as invalid:
- **IAM sandbox check first.** With this set, the coordinator writes the job row and the owner's `LIMIT#GPU_SECONDS` row in one `TransactWriteItems` of two conditional `OWNER#` Puts. Its `PutItem` grant requires `dynamodb:LeadingKeys`, and whether AWS sets that key for each item of a transaction is unverified: the live [IAM sandbox](APP-ROLE-SANDBOX.md) has only run the API role. Before this variable is ever set, run that transaction as the coordinator role in the sandbox. If it's denied, every paid submission would fail with AccessDenied: nothing is written or sent, but all GPU work stops. Don't set the variable then. The fix is an IAM change, which goes to the AWS administrator first.
- **Charging.** Before each paid POST, on the one-GPU and the parallel path, the coordinator charges the owner in the same conditional write as the job's reservation: what the job has reserved beyond its `ownerGpuChargedSeconds`. A job that started before the limit was set is charged its earlier reservations at its next submission; withdrawals that finished earlier are never charged. Charges are never refunded, whatever the outcome.
- **At the budget** the coordinator behaves as at the per-job cap: it starts no new paid submission, lets running chunks finish, and pauses with "Owner GPU-time budget reached". It never touches or resubmits in-flight work. Job creation is refused once less than one submission's reservation is left, and fails with a 409 if another withdrawal charges the budget in between, so no inputs are reserved to a withdrawal that can't search.

To give an owner more GPU time, raise the variable and apply, then resume their paused withdrawals. Lowering a limit below current use refuses new work only. Record any change in the deployment record, as for the mainnet switches.

## Alarms and incidents

The app stack raises an alarm on any error of each Lambda (`<name>-api-errors`, `<name>-coordinator-errors`, `<name>-reference-errors`, and `<name>-webhooks-errors` when the dispatcher is on), on any failed withdrawal execution (`<name>-workflow-failures`) and on a newly flagged stray payment (`<name>-stray-payments`). They notify the SNS topics in `alarm_actions`; with none set, the alarms exist without notifications. The AWS administrator owns that routing and its delivery test. In the GPU stack, a watchdog Lambda runs every five minutes and terminates any `qsb-gpu` job older than 30 minutes, queue and startup time included; it never submits a replacement.

On an incident:
1. Stop new work: turn the mainnet switches off (above), or pause the affected withdrawals.
2. Preserve unknown paid outcomes and reconcile them from the provider record. Never retry blindly, and never treat the loss of a local process as proof that remote GPU work stopped.
3. Keep backups, passphrases and credentials out of the incident record. Record public identifiers only.

### Stray payments

`<name>-stray-payments` fires when the API flags more confirmed payments to a vault's script beyond its recorded deposit than it had recorded ([API](API.md#stray-payments)). A metric filter on the API's log group counts its `{"strayPayment": {"vaultId": …, "count": …, "newCount": …, "sats": …, "outputs": ["<txid>:<vout>"]}}` lines (`terraform/workflow.tf`). `count` and `sats` cover all the vault's stray outputs; `outputs` names those newly listed, and the record lists at most 20. The line names the vault, not the owner. The owner sees the payment in the vault list and gets a `deposit.stray_payment` event. A payment is flagged when the funding route next runs for that vault. The webapp runs it on its own for each funded or withdrawn vault about once an hour while it's open ([API](API.md#stray-payments)), so an owner who never opens the app isn't flagged until an SDK or API call makes that request.

- Don't try to spend it, and don't build a transaction that does. No withdrawal the app builds includes it. Spending it would reuse the vault's one-time material, and whether that could ever be safe is a question for the QSB author, outside the app.
- The vault's own deposit is unaffected and withdraws as usual.
- Record the vault id and outpoints in the incident record, and nothing else about the owner.

### Withdrawal workflow failures

The withdrawal state machine's `CoordinateSearch` task invokes the coordinator Lambda (`terraform/workflow.tf`). When Lambda throttles that invoke with `Lambda.TooManyRequestsException`, for example because more withdrawals tick at once than the coordinator's reserved concurrency allows, Step Functions retries it up to 6 times with jittered exponential backoff (at most about 3 minutes in all). Lambda refuses a throttled invoke before the coordinator runs, so this retry can't repeat paid work. It is the only automatic retry.

Any failed execution needs an operator, and every failed execution raises the workflow-failures alarm. Most errors route through `NeedsOperatorAttention` (error `WorkflowInterrupted`): a task timeout, a Lambda service or client error, a coordinator error, and throttling that outlasts the retries. Some failures skip that state and fail the execution directly: `States.Runtime` and `States.DataLimitExceeded`, which the `States.ALL` catch can't catch, and reaching the 25,000-event execution history limit. So key on the failed execution, not on the state name or error. Either way the coordinator may have run, so don't restart the execution by hand. Reconcile durable intents and provider IDs first, as in [Reconcile an unknown AWS Batch submission](#reconcile-an-unknown-aws-batch-submission).

Each throttling retry adds events to the execution history. A pathological run of throttled polls could therefore reach the 25,000-event limit before the 1,000-poll continuation hands the search to a fresh execution. That fails closed: the execution fails and the alarm fires.

### Deterministic pinning failures

The served release can stop a pinning work unit on `QSB_RANGE_INCOMPLETE`, a hit-capacity overflow, or a repeatable publication or CUDA failure. How the app records it depends on what the worker published:
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

A failed or truncated range never receives completion credit. The producer's guidance is "Deterministic pinning failures" in [`qsb-solver` `docs/promotion/COMBINED-RELEASE.md`](https://github.com/starknet-innovation/qsb-solver/blob/8fe127790397b6903640f8949219c1ef34a92db2/docs/promotion/COMBINED-RELEASE.md#deterministic-pinning-failures).

## Reconcile an unknown AWS Batch submission

A withdrawal pauses with an unknown submission when the outcome of its paid `SubmitJob` isn't recorded: a timeout, a connection error, a 5xx, or a crash between saving the intent and saving the result. The coordinator never retries it. An operator reconciles it with `scripts/reconcile-submission.ts`, which needs an explicit decision with an operator identifier and a public evidence reference. Don't put credentials, wallet material or raw logs in the evidence argument. The identifier is an operator assertion; IAM and CloudTrail identify the caller.

Before any paid intent is saved, `prepareRun` uploads the public input and returns its job name, SHA256, input key, queue and exact definition revision. The coordinator saves this `batchSubmission` identity together with `searching` and its spend reservation. An upload failure occurs before this marker and can be resumed without an unknown paid outcome.

**Environment.** `TABLE_NAME` (the CLI refuses MemoryStore), `AWS_REGION`, `AWS_BATCH_JOB_QUEUE`, `AWS_BATCH_JOB_DEFINITION`, `AWS_BATCH_JOB_BUCKET`, `WORKFLOW_ARN` and `QSB_NETWORK=mainnet`. Also set `QSB_MAINNET_ENABLED` explicitly to `"true"` or `"false"`. It must match the deployed value: verify `terraform output -raw transactions_enabled` or uncached `GET /api/config` (`operationsEnabled`, with `network` equal to `mainnet`). Always set `QSB_OWNER_MAX_ACTIVE_JOBS` to the deployment's `owner_max_active_jobs`: a positive integer, or the literal `off` when that variable is null (check `ownerLimits.maxActiveJobs` in uncached `GET /api/config`); see [Per-owner limits](#per-owner-limits). Missing or malformed values refuse before application imports, credentials, or database or provider reads and writes. The CLI needs GetItem on job/vault records, transactional PutItem on the job, `RECONCILIATION#` and `RECONCILIATION_REQUEST#` audit rows (and, when a `--provider-id` decision claims an owner's withdrawal slot, Query on the owner's `JOB#` rows and PutItem on its `LIMIT#ACTIVE_JOBS` row) and the owner's `EVENT#` row, GetItem and PutItem on the owner's `WEBHOOK#<owner>` / `WEBHOOKS` row (to queue webhooks, never to send them), Batch DescribeJobs/ListJobs/DescribeJobQueues, S3 GetObject on the configured outputs prefix, and StartExecution on the configured workflow. It never submits or cancels Batch jobs and does not broadcast; the `qsb-operator` session itself has broader permissions.

**Decisions.** Pick the one the evidence supports:

1. **The job exists.** Attach its provider ID, either from AWS Batch's console and matching operator logs, or by discovery:

   ```sh
   npx tsx scripts/reconcile-submission.ts OWNER JOB --provider-id PROVIDER_ID --operator OPERATOR --evidence audit://incident/reference
   npx tsx scripts/reconcile-submission.ts OWNER JOB --provider-id discover --operator OPERATOR --evidence audit://incident/reference
   ```

   Discovery searches every status and results page for the saved exact job name, and needs exactly one match. Both discovery and an explicit ID are checked against the saved name, request and project tags, input key and hash, queue and definition before any queued, running, failed or completed job is attached. Completed outputs must also match the stored manifest, stage, attempt, kernel and exact range. Attaching grants no completion credit: the coordinator still validates the output and CPU-checks the hits. Save incident evidence promptly: Batch guarantees terminal retention only for at least seven days.
2. **Batch rejected it before acceptance,** with a retained HTTP 400–499 response from this job's paid SubmitJob request (not the limits preflight, a timeout, a connection error or a 5xx). Authorize exactly one replacement:

   ```sh
   npx tsx scripts/reconcile-submission.ts OWNER JOB --not-submitted rejected-before-acceptance --http-status 429 --operator OPERATOR --evidence audit://incident/rejection
   ```

   `--http-status` must be an integer from 400 through 499; it is stored in the job decision and the audit row. The tool validates the recorded code, not the external truth of the evidence reference. This path also requires the queue to be drained.
3. **No response was recorded** (a timeout, connection error or 5xx), and the job can't be found. After a bounded wait, authorize one replacement:

   ```sh
   npx tsx scripts/reconcile-submission.ts OWNER JOB --not-submitted batch-window-elapsed --operator OPERATOR --evidence audit://incident/window-and-drain
   ```

   It requires at least 35 minutes since the durable submission start (the GPU watchdog's 30-minute limit plus its 5-minute interval), with no maximum age. Exact-name discovery must return no job across all pages and statuses, and the QSB queue must have zero submitted, pending, runnable, starting and running jobs. A discovery failure or multiple matches refuses; a discovered job is attached through decision 1 instead. After seven days an absent discovery result is no longer evidence that the job never existed, but a drained queue after the required wait still permits the bounded replacement. Old jobs without a saved identity can't use this path. `ttl-expired` is refused: AWS Batch has no submission TTL.

   This accepts a bounded duplicate risk (at most one extra job of 15 minutes or less); it is not proof of non-acceptance. A list miss or an empty queue by itself never authorizes a replacement.

**What a decision writes.** The decision and the job change are one conditional transaction with a permanent `RECONCILIATION#JOB#REVISION` audit row, so repeated or racing decisions can't grant multiple allowances. For an already recorded ID on a `searching` job, reconciliation increments the job's revision and writes `RECONCILIATION#<jobId>#<priorRevision>` before restarting polling as `<jobId>-r<newRevision>`; the old execution exits on its next revision check. The new name is needed because [Step Functions Standard](https://docs.aws.amazon.com/step-functions/latest/apireference/API_StartExecution.html) rejects reuse of a closed execution's name for 90 days. The provider ID, submission intent, spend accounting and reservations are preserved.

A replacement is allowed once per uncertain request, keyed by its saved Batch job name in an immutable `RECONCILIATION_REQUEST#<jobId>#<jobName>` audit row, recorded atomically with a pending `batchReplacementFor` marker. `/resume` requires the matching audited revision and consumes the allowance in the same write that advances the revision; the next paid-intent write clears the marker. A later, separate uncertain submission in that withdrawal gets its own single replacement under the same checks. Time accounting is never cleared or refunded.

`PollingNotAllowed` means the CLI's local mainnet setting or another polling prerequisite refused; it is not proof of the Lambda's configuration. If the deployment is switched off after your check, the coordinator pauses the job with the attached provider ID preserved. A polling-start refusal prints its reason and exits non-zero, and an ID already saved stays attached: correct the prerequisite and rerun the same decision. Never submit a replacement as a workaround.

**Parallel search.** The decision applies to the single chunk whose POST outcome is unknown; more than one unknown chunk is refused. Discovery and `--provider-id` attach to that chunk, the 35-minute window runs from that chunk's own start, and the queue must be drained, so pause the withdrawal first and wait for its other chunks to stop. A `not-submitted` decision returns just that chunk to the pool, and resume submits it once more with a new intent.

References: [SubmitJob](https://docs.aws.amazon.com/batch/latest/APIReference/API_SubmitJob.html) and [ListJobs](https://docs.aws.amazon.com/batch/latest/APIReference/API_ListJobs.html). `JOB_NAME` filtering includes all job statuses; absence from the list is not evidence that the paid request was rejected.

### Job-definition revision changes and recovery

Don't change `batch_job_definition` or its container properties while any withdrawal is `searching`, has an attached nonterminal provider job, or is paused with an unknown submission. Keep admission and resume quiescent during the change; reconcile outstanding intents and confirm all provider jobs are terminal and the queue is drained first. A paused unknown request is outstanding even when the queue is empty.

The adapter requires the configured revision to match the saved `batchSubmission.definition` for discovery and polling. Updating container properties creates a new revision, and Terraform deregisters the previous one by default ([Terraform](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/batch_job_definition.html); [JobDetail](https://docs.aws.amazon.com/batch/latest/APIReference/API_JobDetail.html) returns the definition a job used). Changing the configured ARN does not migrate existing requests.

If the configuration already advanced, recover with the original binding:

1. Read the affected job's durable `batchSubmission`. Preserve its exact `definition`, `queue`, job name, input key and hash, and provider ID; never edit them to match the new deployment.
2. Set `AWS_BATCH_JOB_DEFINITION` in the reconcile CLI environment to that recorded revisioned ARN, with the original queue and output bucket. This applies to explicit IDs, `--provider-id discover` and `--not-submitted batch-window-elapsed`, including after seven days. The elapsed-window, exact-name discovery, queue-drain and one-replacement checks still apply; a revision mismatch is not evidence of rejection.
3. Before any command that restarts polling, restore the coordinator's `batch_job_definition` to the same recorded ARN through a reviewed deploy, and verify the live `AWS_BATCH_JOB_DEFINITION`. Changing only the CLI environment doesn't change Lambda. Handle different outstanding revisions separately.
4. Reconcile and finish the original provider request before switching forward. A deregistered definition can't take new submissions: `prepareRun` requires `ACTIVE`. Don't resume a replacement against an inactive revision, or re-register or re-submit the original paid request as a shortcut. If more search work is needed, select an active, image-compatible reviewed definition only after the original request is terminal or explicitly reconciled. Preserve reservations and all recorded GPU time.

This is an operator procedure, not automatic revision migration. It has not been exercised on a live revision rollback.

## Reconcile an uncertain withdrawal (TX#)

This is separate from AWS Batch reconciliation. Never use the compute `--not-submitted` action for a signed withdrawal. Keep **both the vault funding and helper outpoints reserved** and tell the user to keep the helper UTXO unspent while the result is uncertain: spending it elsewhere makes the withdrawal unable to confirm. Never request another signature or accept replacement bytes for the vault. [EXACT-SUBMIT.md](EXACT-SUBMIT.md) describes how the intent binds the bytes.

1. Inspect `GET /api/transactions/:originalTxid/status` and its miner observation. Confirmation is established from the funding outpoint's actual spender and expected spend, not solely from the original txid. An unspent funding outpoint is not proof the miner never received the POST. Investigate a foreign-spend alert immediately; it is not a successful withdrawal.
2. In an [operator session](#operator-session), set `TABLE_NAME`, `AWS_REGION` and `QSB_NETWORK=mainnet`, then run:

   ```sh
   npx tsx scripts/reconcile-withdrawal.ts OWNER JOB \
     --operator OPERATOR --evidence audit://incident/reference
   ```

   This command records a conditional observation of the existing original intent. It performs chain/miner GETs and OWNER-row database writes only: transactional PutItem on the `TX#` and `JOB#` rows and the owner's `EVENT#` row, then GetItem and PutItem on the owner's `WEBHOOK#<owner>` / `WEBHOOKS` row to queue webhooks (they are sent by the API or coordinator, never from the operator's machine).
   It takes no transaction bytes, new signature, provider ID, retry or submit option. It checks owner and job identity, the exact signed-byte hash and the stored spend binding, then observes the funding outpoint and the original txid with the same status logic as the API, and saves the observation conditionally against both the intent and job versions. An alternate valid mined txid (a scriptSig re-encoding) is recorded separately; an alert exits non-zero. If a later observation no longer confirms a previously confirmed intent, it downgrades the job to submitted and clears its inclusion identifier, keeping the original txid, bytes and reservations. Miner status authentication, if the deployment uses it, comes from the service's configured runtime credential; don't paste keys into the command. If the session can't read the miner, that is not proof the miner never received the transaction.
3. An `uncertain` result stays locked. A saved POST acknowledgement may report `submitted`; only matching canonical chain inclusion reports `confirmed`. Unspent funding plus unknown miner status **does not permit another POST**. Any re-POST needs new explicit user approval and a separate reviewed operation; this CLI can't perform it.
4. Database-version conflicts and failed observations are safe to investigate and rerun, because the command never submits. Don't delete the `TX#` row, clear `job.txid`, release reservations or alter the original bytes to get around it. A spent or expired helper is a re-authorization question under #8, not permission to accept a different transaction.

Each transactional Put is authorized as `dynamodb:PutItem` with its own leading key, so the `EVENT#` row needs no grant beyond `OWNER#*` PutItem. That is AWS's per-item authorization of TransactWriteItems; verify it against the current AWS documentation before relying on a narrower policy.

The withdrawal API Lambda has a 120-second timeout, but API Gateway returns a timeout after its 30-second integration budget. A caller timeout doesn't stop an already running Lambda or prove the miner never received the POST: treat it as uncertain and follow the steps above. Never retry the POST or reset its intent.

## Operator session

Reconciliation and plans run as `qsb-operator`. In the current account it is assumed from the Identity Center permission set; see the profiles in [ops/github-aws/README.md](../ops/github-aws/README.md#human-access-without-root). Sessions last at most an hour. The scoped runtime reconcile role Terraform declares (`operator_reconcile_role_arn`) stays dormant: `qsb-operator` is denied role chaining, so don't configure a profile for it.

The `qsb-operator` session has deployment privileges, including `dynamodb:*` on QSB tables. It is not restricted to `OWNER#` partitions and can Query, Scan, Update and Delete, and read `SYSTEM#` and `OUTPOINT#` records. The reconcile CLIs' exact-record, conditional-version and audit checks restrict what they do; the session's IAM policy doesn't. Don't describe it as a least-privilege reconciliation identity.

The human signs in first; agents use the cached session and never handle the MFA code. Run inside a subshell to keep exported credentials out of the parent shell, and never print them:

```sh
(
  set +x
  set -e
  aws sts get-caller-identity --profile qsb-operator
  session_exports="$(aws configure export-credentials --profile qsb-operator --format env)" || exit 1
  eval "$session_exports"
  unset session_exports
  unset AWS_PROFILE AWS_DEFAULT_PROFILE
  export TABLE_NAME='your-records-table'
  export AWS_REGION='eu-west-2'
  export AWS_BATCH_JOB_QUEUE='arn:aws:batch:eu-west-2:123456789012:job-queue/qsb-gpu'
  export AWS_BATCH_JOB_DEFINITION='arn:aws:batch:eu-west-2:123456789012:job-definition/qsb-gpu-solver:1'
  export AWS_BATCH_JOB_BUCKET='qsb-gpu-123456789012-eu-west-2-jobs'
  export WORKFLOW_ARN='arn:aws:states:eu-west-2:123456789012:stateMachine:qsb-app-withdrawal'
  export QSB_NETWORK='mainnet'
  # Set explicitly to the verified deployed switch; false refuses mainnet polling.
  export QSB_MAINNET_ENABLED='false'
  # Set explicitly to the deployed owner_max_active_jobs, or off when it is null.
  export QSB_OWNER_MAX_ACTIVE_JOBS='off'
  npx tsx scripts/reconcile-submission.ts OWNER JOB --provider-id PROVIDER_ID --operator OPERATOR --evidence audit://incident/reference
)
```

Use the deployment's values, including the recorded Batch definition revision when recovering an older request. This example is not permission to attest non-submission, resume paid work or change a switch.

## Webhook signing secrets

Each owner's `WEBHOOK#<address>` / `WEBHOOKS` row holds the signing secret of each registered webhook in plaintext, because HMAC signing needs it (see [API.md](API.md)). The row has its own partition, apart from the owner's `OWNER#` rows, so a role can be granted webhook rows alone. Handle it as a credential:

- Readers: the API role, the coordinator role (its GetItem is not prefix-restricted), the webhook dispatcher's role when it is enabled (GetItem on `WEBHOOK#` keys only; see [Scheduled webhook dispatcher](#scheduled-webhook-dispatcher)) and any operator session with table read access. The due-delivery index is keys only, so a query of it returns no secret.
- Backups: point-in-time recovery is on for the table, so a secret stays in its backups until they age out of the recovery window (35 days unless the table is configured shorter; check the table's setting). Deleting a webhook doesn't purge backups. Treat a restore or backup export as containing live secrets.
- Exports: any export or copy of the table must drop `hooks[].secret`. Never paste a `WEBHOOKS` row into an issue or log.
- Rotation: the owner deletes the webhook and registers it again.
- Not built: envelope encryption with KMS or a Secrets Manager key would keep plaintext secrets out of the table and its backups. It needs new IAM grants for every role that signs or seals: the API, the coordinator, and the dispatcher (decrypt to sign, encrypt to re-seal, a key-policy entry, and the key's `SecretBox` wired into the dispatcher's delivery). So it needs the AWS administrator's heads-up first. Without the dispatcher's part, the dispatcher can't sign sealed webhooks: it defers their rows hourly in the index, and only the API sends them.

## Scheduled webhook dispatcher

Queued webhook deliveries are sent at the end of API requests and coordinator ticks for the same owner. Once a withdrawal's last tick has run, a retry that falls due later waits for that owner's next activity. The dispatcher closes that gap: every 5 minutes EventBridge Scheduler invokes the `<name>-webhooks` Lambda (`server/webhook-dispatcher.ts`), which asks the due-delivery index which owners have a delivery due and runs the same delivery round as the API and coordinator (`deliverDue`: SSRF checks, HMAC signing, leases, backoff, the failing state).

- **Index.** `webhook-due` is a sparse, keys-only global secondary index of the records table on `webhookQueue` and `webhookDueAt`. Every write of a `WEBHOOKS` row sets those two attributes from the row's own queue, in the same PutItem, so the index adds no request and can't disagree with the row. The index is on the table whatever the switch: the provider keeps an index whose block is removed, so it couldn't be switched off cleanly, and unused it costs next to nothing.
- **Bounds.** One run takes at most 50 owners, most overdue first, serves 4 at a time with up to 5 rounds of 10 deliveries each, and stops starting rounds after 40 seconds. The Lambda times out at 60 seconds and runs one at a time (reserved concurrency 1, taken from the account's unreserved pool). Neither Scheduler nor Lambda retries a failed run (`maximum_retry_attempts = 0` on both), since the next run finds the same due deliveries; one failure counts one error.
- **Stuck owners.** If an owner's row was due when its first round started but that round claims nothing, because it holds deliveries the dispatcher can't send, the dispatcher pushes the row back an hour in the index (`webhookDeferredUntil`). It defers only the row version that round read, judged against the round's start, so a row another path rewrote meanwhile, or one that fell due during the round, isn't deferred. Such owners can't hold the head of every run's query and starve the others. Only the index moves; the API and coordinator still send the row's deliveries.
- **Isolation.** It runs no coordinator, API, payment or reconcile code, and its bundle contains none (a test checks the bundle's inputs). Its role may query the index and GetItem and PutItem on `WEBHOOK#` keys only, the owners' webhook partitions. So it can't read or write a job, vault, intent, event, reservation or system row. The schedule's role may only invoke it.
- **Switch.** `webhook_dispatcher_enabled`, default `false`. Off, Terraform plans no dispatcher Lambda, invoke settings, role or schedule.

The coordinator's record policy (`terraform/policies/coordinator-records.json`) allows PutItem on `WEBHOOK#` keys whatever the switch, because `settle()` queues and delivers through the owner's `WEBHOOK#` row. The dormant scoped reconcile role (`operator-reconcile-records.json`) allows only `OWNER#` keys, so reconciliation through it would record the owner event but not queue its webhooks (the enqueue is best-effort and logged); reconciliation runs as `qsb-operator`, which can.

**Before the first enable.** The switch needs deploy-role and operator grants for EventBridge Scheduler: `PassRuntimeRoles` naming `scheduler.amazonaws.com`, and `QsbSchedules` allowing Create/Get/Update/DeleteSchedule on `schedule/default/qsb-*`. `render.py` and `access.py` on `main` include them. Run `ops/github-aws/update_installed.py` in plan mode as `qsb-viewonly` and check that everything is `identical`; if not, the AWS administrator applies the update first, then runs `verify.py --role-arn` against `qsb-github-deploy`.

**Enable.** As `qsb-operator`, set `webhook_dispatcher_enabled = true` and plan. The plan adds one Lambda with its log group, error alarm and async-invoke settings, the two roles, three role policies and the schedule, and changes nothing else. Run `check-single-pipeline.py --deploy` on it, then apply.

**Check.** Within 10 minutes the dispatcher's log group shows one `{"webhookDispatch": {...}}` line of counts per run and no errors, and the `<name>-webhooks-errors` alarm stays quiet.

**Back out.** Set the switch to `false` and apply. That removes the schedule, Lambda, its invoke settings and the two roles. The index and the rows' index attributes stay and do nothing on their own; deliveries go back to requests and ticks only.

## Rollback

Rebuild an approved earlier clean, pushed commit and review its plan against the current state ([terraform/README.md](../terraform/README.md#updates-and-rollback)). A rollback never releases consumed commitments or reservations, never duplicates paid work, and doesn't authorize a spend. Don't roll back reservation semantics or replay old workflows without a reviewed reconciliation decision. Never roll the API back past `d0a1732` (#78) while the `qsb/slipstream` secret holds `client_code` ([MARA Slipstream credential](../terraform/README.md#mara-slipstream-credential)).

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
