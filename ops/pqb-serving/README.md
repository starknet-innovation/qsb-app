# Public PQB serving validation

The [qualified public assessment](../../docs/PQB-SERVING-VALIDATION.md) records the
exact native/checker identities, complete solve, Core checks and verified cleanup.
Each future campaign requires its own authorization, fresh directory and evidence.

This bounded operational assessment invokes the actual coordinator bundle through
its Step Functions state machine and AWS Batch transport. It uses only the
committed, never-funded public synthetic fixture. It creates no API, wallet,
credential, funded output, miner request or transaction submission path. The
production app's release, functions, table, queue settings and switches stay under
their ordinary reviewed deployment process.

`fixture.ts prepare EXTERNAL_DIRECTORY` derives the public vault locally and
writes only public vault/job rows and a public workflow event with fresh identifiers. It never writes the
fixture seed to its output. A native audit requires every successful Batch job’s immutable input, completed
output, the configured GPU model/driver and process-isolation startup logs. It re-derives all stage
packets from the public intent and CPU-checked predecessor hits, then rechecks every
emitted candidate, including superseded work.
`fixture.ts verify EXTERNAL_DIRECTORY` projects the
final coordinator result and rechecks all three full hits with the CPU reference.
No test verifier verdict or grinder transcript is substituted for native work.

Before cloud execution, record the clean pushed source, build manifest and bundle
hashes, exact published descriptor and original build attestation, matching ECR
index/platform digests, current Batch policy and zero active-work baseline. Keep
all configuration and original receipts outside Git. Preserve old descriptors and
the production deployment manifest for rollback. Enrollment and this assessment
do not select PQB on the production deployment.

Use two isolated fixture tables and a dedicated coordinator/workflow with bounded
runtime roles. The runtime has no miner secret or exact-submit API. The first
execution has a 900 GPU-second owner allowance: one ordinary complete work unit
through the real transport, accounting and CPU path. Require its completed result,
correct driver/image identities and terminal execution before the full execution.
The second execution uses the other fresh table, the same coordinator binary,
image and partition contract, and a separately recorded allowance. The first
reservation is retained in campaign accounting. Neither execution is resumed or
replayed after an unknown submission.

When the ordinary `g5.xlarge` pool has no capacity, `capacity.py` prepares an
isolated `qsb-gpu-validation` queue and compute environment using `g5.4xlarge`
NVIDIA A10G hosts. It copies the reviewed host AMI, immutable launch-template version,
network and instance profile. The pool uses `BEST_FIT_PROGRESSIVE`, minimum zero
and maximum 64 vCPUs. Its provider limits the coordinator to four single-GPU
hosts, within the existing global 16-slot ceiling. The production queue and pool
are never modified. Production work appearing during collection stops the public
assessment so it can release capacity. The larger host keeps the same A10G GPU and
enrolled image while requesting a different EC2 size in the existing subnets. It is a capacity option,
without a comparative performance claim or a change to production selection.
The worker still requests four vCPUs and 12,000 MiB; host vCPUs bound the number of
simultaneous single-GPU hosts.

An administrator-provisioned validation subnet in a new zone can be selected with
`capacity.py plan ... --validation-subnet SUBNET_ID`. It is used only by the
isolated pool; production subnets and routing are untouched. Planning requires the
`Project=qsb` and `PqbValidation=public-serving` subnet tags, an available public
subnet in the production VPC and a different zone, explicit association with the
same production internet route table and network ACL, an offered GPU instance type
and address headroom for the configured maximum host count plus a reserve. An offering is not a stock guarantee.
The plan freezes subnet, route and ACL identities and rechecks them before capacity
creation and runtime use. Allocation may consume free IPs without changing that
identity. The controller creates or deletes no network resources; the administrator
owns subnet creation and removal after independently verified pool cleanup.

The image remains the enrolled `sm_86` artifact on A10G. Require a fresh native
preflight on the selected hardware. The startup audit requires exactly one GPU
matching `server/aws-batch-validation.json`, its UUID/driver and the
process-isolation flags. Receipts remain bound to their exact source, bundle,
image and hardware identities.

An administrator installs two temporary additions, preserving all original policy
statements: an inline operator grant for create/update/delete/tag on exactly the
new queue and pool, and a runtime-boundary supplement for submit/tag on only the
new queue. The boundary supplement also restricts the principal to the dedicated
validation coordinator role pattern. Both additions require London and the same
absolute expiry. The controller reads them through the existing metadata-only
role; it never writes IAM or requests administrator credentials. The grant must
expire within 24 hours of planning, with at least five hours left before preparing
the four-hour campaign. Fresh readbacks precede capacity creation and workflow
starts. The administrator removes both additions after cleanup; their expiry is
fixed and is never extended during a campaign.

Queue creation also requires `batch:CreateJobQueue` on its referenced compute
environment, in addition to the queue itself. The operator grant and its readback
check require both permissions on the two exact validation resources. Simulate
each resource check; a queue-only allow does not authorize the complete request.

Set one absolute campaign deadline before resource creation; never extend it.
An independently scheduled `deadline.py` invocation pauses only the two public
fixture jobs and drains only the campaign's exact Batch job-definition revision.
The fixed deadline drain is unconditional. With isolated capacity, a separate
five-minute schedule invokes the same function and stops work whose total queue,
startup and running age exceeds 30 minutes. The ordinary Batch 900-second running
timeout also remains in force. Both schedules are read back before a workflow
start, along with the complete function configuration, runtime roles, trust and
inline policies, including after changing to the solve table.
[Scheduler has 60-second precision](https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html);
retain actual invocation and drain times separately from the deadline. A timeout,
unexpectedly failed/incomplete unit, unknown intent or CPU mismatch stops the
assessment for collection and reconciliation. Superseded units may be cancelled
and never receive completion credit; work is not retried automatically.

Retain both workflow histories, every revision-specific Batch job description,
public input/output S3 objects and hashes, native startup/result logs, assigned
ranges, durable reservations, CPU decisions and all allocated instance/volume
identities. Report cold startup and solve wall time separately from measured GPU
runtime. This is one public synthetic solve, not a performance distribution,
complete-domain proof, actual user withdrawal, Core acceptance or miner inclusion.
A solved synthetic spend may subsequently be checked offline without broadcasting.

On success or failure, pause both fixture jobs, drain/cancel only campaign work,
collect receipts and stop the dedicated workflow executions. Delete the dedicated
functions, schedules, tables, runtime roles and inactive definition after retaining
evidence. Verify zero campaign jobs, terminated campaign-used hosts and deleted
recorded volumes (or explain any independently verified host shared with unrelated
work). Never terminate a production host or delete shared resources. Release the
campaign's operational reservation only after independently verified cleanup;
estimated compute and reserved budget are not provider billing.

## Validate a staged permanent revision

Use `control.py prepare EXTERNAL_DIRECTORY --existing-definition EXACT_REVISION_ARN`
to run one public native preflight against a permanent staged revision in the
ordinary London pool. The controller requires an active permanent image-only
revision of the served runtime and freezes its complete definition, public fixture
and the exact first-unit input-envelope SHA-256. It uses the ordinary provider
checks; no validation hardware flag is enabled. This mode cannot start a solve.

The deadline drain, collector and monitor bind ownership to both the revision and
the frozen input hash in the Batch environment and tags. Unrelated work on the
same revision causes the monitor to yield without collecting or terminating it.
Removal deletes only dedicated campaign resources and public objects; it retains
the staged definition. Independently verify that definition remains active and
unchanged, the served Config A revision remains active, production selection is
unchanged, and recorded hosts and volumes are removed before releasing the
reservation. A passing preflight is one complete native unit, not a new full solve;
assess earlier full-pipeline evidence separately against the actual bundle bytes.

## Operator sequence

Use a fresh directory outside every checkout. Its `operator.json` contains only
`profile`, `account` and `region` (`eu-west-2` for the app-account operator), never credentials. The connected AWS
MCP session should be used when it targets the deployment account; the explicit
local profile is the SDK fallback when that connector is bound to another account.
Provisioning mutations use the SDK with one attempt and retain an exclusive intent
before dispatch. Explicit stop requests retain their intent before the conditional
pause and revision-scoped drain; the independent scheduled drain is logged in CloudWatch. A missing response or prior failure requires reconciliation, not replay.

From a clean pushed checkout with locked dependencies installed:

```sh
QSB_NETWORK=mainnet node --import tsx ops/pqb-serving/fixture.ts prepare "$EVIDENCE"
python3 ops/pqb-serving/control.py inspect "$EVIDENCE"
release_id=$(node -p 'require("./src/lib/releases/qsb-solver-pqb-aws-sm86-v0-1-0.json").id')
node terraform/scripts/build.mjs --network=mainnet --solver-release="$release_id"
# Optional temporary pool: generate the baseline and scope it against the
# administrator-requested policy kept outside Git. AWS_ACCOUNT_ID comes from
# the explicitly selected operator profile, never from a different account.
DISABLE_IAM_POLICY_AUTOPILOT_TELEMETRY=true uvx iam-policy-autopilot@0.4.0 generate-policies \
  "$PWD/ops/pqb-serving/capacity.py" --region eu-west-2 --account "$AWS_ACCOUNT_ID" \
  --service-hints batch --tf-dir "$PWD/terraform/gpu" --pretty > "$EVIDENCE/autopilot-capacity.json"
python3 ops/pqb-serving/capacity.py plan "$EVIDENCE" \
  --generated-policy "$EVIDENCE/autopilot-capacity.json" \
  --requested-policy "$EVIDENCE/admin-operator-policy.json" \
  --boundary-baseline "$EVIDENCE/runtime-boundary-baseline.json"
# Planning and building allocate no hardware and start no campaign deadline.
# The plan retains the full boundary request for administrator review.
# Continue only when both installed administrator additions verify:
python3 ops/pqb-serving/capacity.py verify_grant "$EVIDENCE"
python3 ops/pqb-serving/control.py prepare "$EVIDENCE"
python3 ops/pqb-serving/control.py mirror "$EVIDENCE"
python3 ops/pqb-serving/capacity.py create "$EVIDENCE"
# If the recreated queue retains prior terminal jobs, reconcile every such
# campaign before deployment (repeat --previous-campaign as needed):
python3 ops/pqb-serving/capacity.py reconcile_history "$EVIDENCE" \
  --previous-campaign "$PREVIOUS_COMPLETED_EVIDENCE"
python3 ops/pqb-serving/control.py deploy "$EVIDENCE"
python3 ops/pqb-serving/control.py start "$EVIDENCE" --phase preflight
python3 ops/pqb-serving/control.py collect "$EVIDENCE"
# Only after the one-unit preflight is recorded as passed:
python3 ops/pqb-serving/control.py start "$EVIDENCE" --phase solve
python3 ops/pqb-serving/control.py collect "$EVIDENCE"
# Only after the real coordinator publishes awaiting_authorization:
QSB_NETWORK=mainnet node --import tsx ops/pqb-serving/fixture.ts verify "$EVIDENCE"
```

Omit the `capacity.py` and Autopilot commands when using the original pool.
Call `collect` regularly during each execution; it retains snapshots rather than
rewriting originals. Each campaign reserves $200 operationally and permits at most 900 + 540,000
reserved GPU-seconds across the two public jobs. The original and isolated pool
modes freeze four hours; the explicitly bound shared-pool replacement freezes six. The ordinary provider keeps its 16-slot cap; the isolated provider
keeps four. The account quota applies across both pools.
This is an assessment
reservation, not a guaranteed billing limit. Current regional pricing must be
recorded independently before preparing a new campaign.

`stop` pauses the two public fixture rows and drains only the test revision.
Run `final_collect` after work is terminal. It retains both fixture tables,
complete workflow event histories, native artifacts and resource configuration,
then seals their byte hashes. For temporary capacity, run
`capacity.py remove "$EVIDENCE"` next: it collects and seals a fresh snapshot,
disables/deletes only the owned isolated queue and pool,
and requires recorded hosts terminated, recorded volumes absent and its scaling
group absent. An invalid pool can still be cleaned up. AWS can retain terminal job history across queue deletion and recreation.
`reconcile_history` accepts only prior campaigns with released reservations, sealed
native inventories and hash-bound verified independent cleanup. It compares all
retained rows byte-for-byte with fresh provider descriptions, before deployment.
The binding is sealed in the current collection and checked again before deletion.
Prior jobs never enter the current submission ledger or receive completion credit.
Unrecognized, changed or active historical work blocks deployment and cleanup.
Every job in the isolated queue must be terminal and already recorded. Production
resources are never deleted. If asynchronous deletion is pending, `capacity.py verify_removed`
performs fresh reads. Rerunning `remove` can continue after a known asynchronous
delete using the original successful response; uncertain mutations require
separate reconciliation and are never replayed.
The normal `control.py remove` refuses to remove the deadline guard until this
capacity cleanup verifies. It requires the final collection receipt, checks that live work
and fixture rows have not changed, and removes only positively collected dedicated
resources and fixture objects. Failed/partial deployments use the same final
collection path; missing mutation responses must first be reconciled separately,
without relabeling a read-back as the original response. Never delete evidence to
get past an uncertain operation. Retain the verified ECR artifact for the reviewed adoption
handoff. Save an independent cleanup reconciliation after removal: all dedicated
resources absent, all campaign work terminal, recorded volumes deleted and the
shared fleet idle. Only that reconciliation closes the budget reservation.

When an operator IAM read cannot resolve a never-created runtime role, final
collection uses the existing metadata-only role to check it. Only an explicit
not-found response establishes absence; access denial still blocks collection.

Local checks (no AWS calls):

```sh
npm run typecheck
uv run --no-project --with-requirements ops/pqb-serving/requirements.txt python -m unittest discover -s ops/pqb-serving -p 'test_*.py' -v
```

## Offline solved-spend component check

After the actual solve, run
`QSB_NETWORK=mainnet node --import tsx ops/pqb-serving/consensus.ts "$EVIDENCE"`.
It uses only the committed public test seed and nonexistent outpoints, checks the
three full solutions again during real witness/co-signature assembly, and invokes
the exact packaged Bitcoin Core 27.2 interpreter/library in network-disabled,
read-only containers. It requires one accepted PQB spend and rejection of twelve
transaction/witness mutations, retaining binary, library and container identities.
The helper previous output is deliberately OP_TRUE: this tests the solved PQB
script, not a wallet signature, chain/UTXO acceptance, miner policy or broadcast.
Legacy signatures do not commit previous-output amounts; the production chain and
exact-spend checks retain that responsibility. No wallet material is accepted.

The co-signature mutation locates the final signature/key pair by the PQB stack
layout and checks the key against the lock's HASH160; other DER signatures may
legitimately occur earlier in the witness.

A checker-only follow-up may use
`consensus.ts "$EVIDENCE" --retained-transaction "$EVIDENCE/FRESH_FOLLOWUP"`.
It requires independently verified cleanup and a released reservation, verifies
every sealed file, binds the final solution to its sealed coordinator row and
requires unchanged application/build/fixture source and all original artifact
hashes. It checks the exact original positive transaction with the same Core
binary/library and immutable container identity. The output records native and
validation commits separately; it never grants new native execution credit.
Normal campaign verification still requires the original clean campaign commit.

The current-status collector pauses and drains the campaign immediately when it observes an unexpected failed unit or incomplete native output. Successful qualification separately requires provider-declared coordinator cancellation and an earlier CPU-verified winner for the same packet for every superseded failed job.

## Explicit SNF account isolation

`operator.json` may explicitly add `"snfIsolation": true` for a separately authorized
root session in an otherwise empty Ireland or London GPU/Batch account. This creates an isolated
consumer stack, not a production app deployment. Root credentials remain local; the
coordinator and workers receive only generated runtime roles. No API, wallet or miner
path is created. The same enrolled image, clean consumer bundle, workflow, public
fixture, native/CPU audit and offline Core check are used. Evidence applies to the
SNF transport and hardware, not to deployment or IAM in the app account.

Keep `host-image.json` (`{"imageId":"..."}`) and a fresh read-only reference app
`reference-runtime.json` snapshot outside Git. The snapshot supplies the workflow
and compute-limit template; it is never presented as an existing SNF deployment.
`inspect` verifies the selected root identity, empty GPU/Batch baseline, pinned
Amazon ECS GPU AMI, public default subnets supporting the selected hardware, and
fresh quota. The quota may bound actual concurrency below the configured ceiling;
record both and never infer allocated GPUs from submitted jobs.

Use `uv run --no-project --with-requirements ops/pqb-serving/requirements.txt python` for this profile's AWS
login credential provider. Isolated mode permits `eu-west-1` or `eu-west-2`; ordinary
app-account mode remains London only. Select and freeze the region before preparation. After building and local public-fixture preparation:

```sh
python ops/pqb-serving/control.py inspect "$EVIDENCE"
python ops/pqb-serving/control.py prepare "$EVIDENCE"
python ops/pqb-serving/snf.py bootstrap "$EVIDENCE"
python ops/pqb-serving/control.py mirror "$EVIDENCE"
python ops/pqb-serving/capacity.py create "$EVIDENCE"
# If this queue ARN retains old terminal jobs, reconcile every contributing
# completed campaign now, before capture. Omit only for an empty inventory.
python ops/pqb-serving/capacity.py reconcile_history "$EVIDENCE" \
  --previous-campaign "$PREVIOUS_COMPLETED_EVIDENCE"
python ops/pqb-serving/snf.py capture "$EVIDENCE"
python ops/pqb-serving/control.py deploy "$EVIDENCE"
```

Preparation freezes one $200 reservation and four-hour deadline before infrastructure
creation. Bootstrap creates only named, tagged public-data resources: a private
TLS-only artifact bucket, no-ingress HTTPS-only host group, immutable host template,
worker roles/profile, initial definition/log group and a campaign runtime boundary.
The boundary expires one hour after the fixed deadline to allow scheduled draining.
The selected root session is not represented as an IAM-limited operator grant.
A newly created `qsb-solver` ECR repository is intentionally retained with the
verified immutable mirror. Existing default networking is reused without edits.

Use the ordinary preflight, solve, collection and runtime/fleet cleanup sequence.
Then `snf.py remove "$EVIDENCE"` removes the bootstrap definition, worker roles/profile,
boundary, template, group, empty artifact bucket and native log group. It verifies
resource identities against original successful responses and ownership tags.
Retain and independently reconcile every additional resource before releasing the
single operational reservation. Uncertain bootstrap calls are never replayed;
partial bootstrap failures require retained readback and scoped reconciliation
before another campaign.

The Batch job definition must bind exactly one `QSB_JOB_BUCKET` to the consumer’s
configured artifact bucket. The consumer checks this before uploading public input
or preparing a paid submission. SNF bootstrap sets that binding; request-specific
input keys and hashes remain ordinary submission overrides.

Log collection spaces initial `FilterLogEvents` page requests by at least 400 ms across pages and
groups. An explicit service/operation allowlist routes reads to a separate SDK
client with standard backoff and at most five total attempts for transient
connections, throttling and retryable service errors. Other operations retain a
one-attempt client, including callbacks used by the mutation journal. Only reviewed
read paginators and waiters may use the read client. Successful response metadata
retains SDK retry counts. Empty continuation pages are followed; repeated tokens
fail closed. SDK dependencies are pinned in `requirements.txt`. Loopback HTTP fault
injection verifies actual SDK recovery, exhaustion, immediate authorization-denial
failure and a lost mutation reply making only one request, without AWS access. Cloud mutations and paid
submissions retain their one-attempt journal and are never replayed. Complete
workflow histories remain mandatory before removal. See the [AWS log API quotas](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/cloudwatch_limits_cwl.html).

## Authorized replacement of an idle original pool

When the user explicitly authorizes temporary replacement of the idle `qsb-gpu`
pool using existing access, `shared_pool.py` retains its exact creation payload for
restoration. It supports only the London operator and the two existing subnets.
The candidate changes only allocation strategy and instance type to the committed
single-A10G validation profile. No IAM or networking change is made.

Use a fresh external maintenance directory with `operator.json`, then run
`shared_pool.py capture DIRECTORY` from a clean pushed controller. Review the
retained plan before `shared_pool.py replace DIRECTORY`. The controller disables
new queue submissions, verifies no active jobs, production workflow executions,
hosts or pending scaling demand, deletes the idle queue, disables/deletes the original compute
environment, and recreates the same named environment enabled but unassociated,
with zero minimum and desired capacity. It verifies the candidate before recreating
the original queue disabled and enabling submissions. Batch uses the existing
service-linked role by default; the controller verifies that role exists and its
ARN matches, without explicitly passing it or changing IAM.
The queue name, ARN, priority and tags are restored; roles, AMI, launch template, subnets, tags and 64-vCPU limit stay
bound to the original snapshot. Each write has an exclusive intent and one attempt;
uncertain outcomes require reconciliation rather than replay.

After replacement, prepare a fresh campaign directory and run
`shared_pool.py bind DIRECTORY --campaign CAMPAIGN` before `control.py inspect` and
`prepare`. Omit the isolated `capacity.py` path. The dedicated coordinator receives
`QSB_BATCH_SHARED_POOL_VALIDATION=1` and accepts only this reviewed hardware and its
own tagged job definition. The production coordinator keeps its original checks
and fails closed against the temporary alternative hardware. Its bundle, settings
and release are not changed. This maintenance window is unsuitable for concurrent
production GPU work; any observed unrelated activity blocks replacement/restoration.

Run the normal fixed-deadline native preflight and full public synthetic solve.
Canceled containers may retain partial failure outputs. Collection waits for the
provider's terminal status; the final audit checks their input and range bindings,
requires an earlier CPU-validated winning completion for the same packet, and
retains them as cancellations without crediting their partial work or hits.
Stop, collect, remove and independently verify campaign cleanup; then wait for the
shared fleet and scaling demand to reach zero and run
`shared_pool.py restore DIRECTORY`. Independently read back the original pool and
queue settings, zero hosts and recorded-volume absence. This restores the original
Terraform-managed configuration, while retaining the actual Batch-generated pool, group and cluster identities
observed before and after maintenance. AWS may reuse an existing cluster ARN. Keep the maintenance plan, every request/response and fresh restoration
receipt; never apply Terraform concurrently with this maintenance operation.

The shared-pool `g5.4xlarge` assessment freezes a fresh six-hour deadline at
preparation, with four validation GPU slots and the same $200 reservation. The
additional preparation-time window accommodates the smaller GPU count; it never
extends an existing campaign. The original-pool and isolated-pool modes retain
four-hour deadlines. The workflow timeout and independent stop schedule use the
same frozen deadline. Five hosts (including a possible Batch overshoot) for six
hours at the recorded $2.06148/hour on-demand rate would be $61.8444 in VM time;
this excludes other services and is an estimate rather than provider billing.

## Committed campaign watcher

After deployment and before the first submission, run
`python3 ops/pqb-serving/monitor.py CAMPAIGN --check` with the pinned controller
requirements. This checks the active inventory and metadata collection path without
starting or stopping work. During each running phase, run
`python3 ops/pqb-serving/monitor.py CAMPAIGN` from the same clean pushed checkout.

Batch status queries are separate snapshots, so a transitioning job may appear in
several status pages. The watcher deduplicates identities before `DescribeJobs`,
requires the complete described inventory, and yields to unrelated work without
terminating it. Collector or inventory failures stop only this campaign through
the journaled controller and return a failing process status. `monitor-status.json`
records liveness and failures; a verified stop also marks `preflight-stopped` or
`solve-stopped` in the campaign ledger. Those states cannot restart paid work.

The watcher retains explicit instance-state receipts as well as SG-filtered
snapshots, preserving termination evidence before EC2 expires old instance
metadata. It never starts or retries a compute submission or extends a deadline.
A watcher holds an exclusive per-campaign lock. A second watcher exits without
stopping work. Each process is bound to its starting phase and exits promptly when
that phase completes; wait for its successful exit before starting the next phase
and its watcher. A lock file remaining after exit is harmless: the operating
system releases the lock when the process closes or exits.
