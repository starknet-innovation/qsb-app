# QSB GPU backend on AWS Batch

This stack runs the qsb-solver pinning and subset worker on On-Demand A10G instances in `var.region` (eu-west-2; see [REGION-MIGRATION.md](../../docs/REGION-MIGRATION.md)), one GPU per host. Its state is separate from the app stack's, and provisioning compute does not turn mainnet on.

Capacity is derived from `server/aws-batch-capacity.json` and `server/gpu-spend.json`: automatic fallback across the allowed A10G sizes, minimum zero, and a nominal maximum that reserves one largest-host allowance inside the configured total vCPU ceiling. Verify that the operator account's On-Demand G/VT quota supports the 112-vCPU ceiling, plus any other G/VT usage in the region. Job definitions require one GPU, 4 vCPUs, 12 GB RAM, one attempt and a 900-second running timeout. An independent five-minute EventBridge/Lambda watchdog terminates jobs older than 30 minutes, including startup/queue time. It never submits replacements. Capacity scales to zero after AWS Batch's idle cooldown; this is not an instantaneous stop or a hard dollar budget. Idle startup/termination and storage are chargeable.

The worker image is the served release's image, copied by digest into this account's private `qsb-solver` ECR repository ([serving a release](../../docs/SOLVER-REPOSITORY.md#serving-a-release)). The repository's `scan_on_push` is basic scanning, which runs once at push; enhanced scanning, which rescans as new vulnerabilities are published, is a registry setting the AWS administrator turns on and which then replaces it ([image scanning](../../ops/github-aws/README.md#what-stays-with-the-aws-administrator)). Inputs and outputs contain public search data only, live in encrypted private S3 and expire after 30 days. Jobs run without privileged mode, drop all capabilities and have a read-only root filesystem with writable /tmp. Their task role can only read inputs and write outputs. Network HTTPS is required for S3/ECR/Batch; no inbound ports are open. The host uses IMDSv2 and encrypted delete-on-termination EBS.

## Deploy

Use an operator-configured AWS profile and explicitly supply the expected `aws_account_id` and `region` (eu-west-2; see [docs/REGION-MIGRATION.md](../../docs/REGION-MIGRATION.md)). Commit and push source first and verify `git status --porcelain` is empty. Initialize a separate encrypted backend:

```
terraform init -backend-config="bucket=${QSB_STATE_BUCKET:?Set the operator state bucket}" -backend-config=key=qsb/gpu/terraform.tfstate -backend-config=region=eu-west-2 -backend-config=encrypt=true -backend-config=use_lockfile=true
```

Supply `release_manifest_path` (the generated app `terraform/.build/manifest.json` built with `--solver-release=RELEASE_ID`), `source_commit` (that clean pushed app commit), `region`, `gpu_ami` (the ECS GPU-optimised AL2023 AMI pinned for that region; AMI IDs differ per region, see [REGION-MIGRATION.md](../../docs/REGION-MIGRATION.md)), `image` (verified ECR digest in that region), `vpc_id` and public `subnets` with an Internet gateway. Also supply the required `gpu_permissions_boundary_arn`:

```hcl
gpu_permissions_boundary_arn = "arn:aws:iam::123456789012:policy/qsb/bootstrap/qsb-gpu-boundary"
```

Replace the example account with `aws_account_id`; other accounts, policy names and paths are rejected. All four GPU roles (`qsb-gpu-instance`, `qsb-gpu-job`, `qsb-gpu-execution`, `qsb-gpu-watchdog`) keep `/qsb/runtime/` and use this same boundary. There is no unbounded default, including when applying as an administrator. The boundary must already exist from the [access bootstrap](../../ops/github-aws/README.md); this stack references it and can't create or modify its policy, and the operator's grant requires that exact boundary. Supplying an ARN doesn't establish that its live policy document matches reviewed source: check that with `update_installed.py` before applying.

First build the app with the served release (`--solver-release`); this creates the generated manifest without an ECR repository or GPU deployment. On an account's first deployment only, supply that manifest and target the ECR repository, verify the published GHCR release and its build-provenance attestation, then use a digest-preserving registry copy into ECR. Verify that both registry manifest digests are identical before a full plan/apply; do not substitute a Docker load/push or an unattested workflow tarball for the attested release. The GPU plan reads the same generated app manifest and requires an enrolled schema-3 descriptor with matching ID, image and solver commit, binds the CPU reference identity, and verifies every listed artifact hash relative to the manifest directory. These are local consistency checks, not independent build attestation. Never use a mutable tag or substitute the Docker config digest for the registry manifest digest. Save plans, source/build receipt, outputs and smoke-test records outside Git.

Bind outputs `queue`, `definition`, and `bucket` to the application stack's `batch_job_queue`, `batch_job_definition`, and `batch_job_bucket`. A new image means a new job-definition revision: follow "Job-definition revision changes and recovery" in the [runbook](../../docs/OPERATIONAL-RUNBOOK.md#job-definition-revision-changes-and-recovery). The coordinator refuses a changed image, retry count, timeout, instance type or capacity before paid submission.

Image updates retain previous job-definition revisions as `ACTIVE`
(`deregister_on_new_revision = false`). Staging a PQB revision therefore leaves
the currently served Config A revision usable. The app keeps its recorded
revision until a separate reviewed app deployment changes it. Confirm the exact
new revision and image, run its bounded public-input preflight, and require the
queue and durable submission intents to be reconciled before switching the app.
Retaining a revision does not migrate pinned requests or make an old image
compatible with PQB. Deregister superseded revisions explicitly only after
reconciliation and the rollback decision; destroying the managed job-definition
resource deregisters every active revision with that job-definition name.

After a new revision, run one bounded preflight through it (driver visible, image pulled by digest); never retry an uncertain SubmitJob response (the API has no idempotency token). Verify the job is terminal and EC2 capacity returns to zero. Don't use a wallet operation or a transaction as a GPU test.

Jobs store the Batch job ID in the legacy `runpodId` field, and `computeProvider=aws-batch` marks them. A job from the earlier Runpod provider pauses for operator reconciliation instead of being polled or replayed on AWS; nothing calls Runpod.

## Local boundary validation (no AWS calls)

```sh
terraform -chdir=terraform/gpu init -backend=false -input=false
terraform -chdir=terraform/gpu validate
node --import tsx terraform/scripts/review-fixtures.mjs
terraform -chdir=terraform/gpu test
```

These mocked-provider plans assert the boundary on every GPU role, the retained
role path and zero minimum capacity, and reject empty, cross-account or wrong-path
boundary values. They do not certify live operator authorization, bootstrap policy
contents or deployment success.


## Automatic A10G capacity fallback

The shared catalog `server/aws-batch-capacity.json` allows `g5.xlarge`, `g5.2xlarge` and `g5.4xlarge`, each with one A10G. Both stacks and the runtime derive their capacity policy from it and `workersMax`; no operator host-size override is needed. `BEST_FIT_PROGRESSIVE` lets AWS choose another allowed size when capacity is unavailable. It prefers cost per vCPU, so larger hosts can be selected even when a smaller size is offered, and each larger host costs more per GPU-hour. A type offering is not a stock guarantee.

AWS can exceed a progressive pool's nominal maximum by one instance. With the shipped 16-worker budget, the nominal maximum is 96 vCPUs and the largest allowed host is 16 vCPUs: the resulting total remains within the 112-vCPU ceiling. The coordinator permits six simultaneous chunks, each of which fits on the largest host. The pool's reviewed total vCPU budget is 112, so six chunks fit even when every host is a `g5.4xlarge`. The remaining largest-host allowance bounds AWS's possible overshoot. When a reduced worker budget admits only one safe host type, the policy uses `BEST_FIT` with its ordinary vCPU ceiling instead.

`AwsBatch.prepareRun` checks the exact allowed type set, strategy and nominal ceiling before uploading inputs or submitting paid work. Duplicates, missing types, unreviewed types and raised ceilings are refused. GPU seconds, per-job and owner reservations, independent verification, worker image and immutable release descriptors are unchanged. More expensive hosts do not reduce the amount of GPU work. Both stacks expose the derived policy as `gpu_capacity`.

### Replacing an installed BEST_FIT pool

`BEST_FIT` does not support instance-type infrastructure updates. Its migration to progressive fallback requires replacing the drained compute environment while keeping one `qsb-gpu` queue and one withdrawal pipeline:

1. Commit and push the reviewed source, then build clean artifacts. Record the deployment commit and plans for both stacks. Preserve previous manifests and capacity settings for rollback.
2. Quiesce job creation and resume, pause all withdrawals, and confirm every attached provider job is terminal, no submission outcome is unknown, the queue is drained and GPU hosts have terminated. Preserve IDs, reservations and attempts. Do not replace capacity while live work can still arrive.
3. Disable the drained queue and review a GPU Terraform plan with explicit replacement of both `aws_batch_job_queue.gpu` and `aws_batch_compute_environment.gpu` (`-replace=aws_batch_job_queue.gpu -replace=aws_batch_compute_environment.gpu`). The old queue must be deleted before its attached compute environment can be deleted. Preserve the queue and environment names, job-definition revision and bindings; do not create another pipeline or hand-edit Batch-managed Auto Scaling groups or launch templates.
4. Apply that exact GPU plan, creating the replacement environment and its single queue in dependency order, then apply the app stack from the same commit. A mismatched live policy refuses new paid submissions. Verify both `gpu_capacity` outputs, live environment strategy/types/nominal ceiling, solver image, source and artifact hashes. In the shipped configuration verify 96 nominal vCPUs, a 112-vCPU total bound and six parallel slots.
5. Run a bounded public-data native preflight on the selected host size, exact image and runtime, and independently CPU-check its result before resuming funded work. The same A10G does not turn evidence from another host size into a fresh preflight. Restore admission, then explicitly resume paused withdrawals. Resume retains earlier accounting and observes old provider IDs before creating new intents.

For rollback, drain again and use the recorded prior capacity policy and clean artifacts. Changing capacity never enables a mainnet or exact-submit switch.

### Increasing a progressive pool's concurrency

A change only to the reviewed vCPU budget can update an installed `BEST_FIT_PROGRESSIVE` environment in place. It does not require replacing its queue, cancelling paid chunks or changing the solver release.

1. Check that the regional On-Demand G/VT quota covers the new total ceiling plus other regional usage. If quota reads are denied, record that headroom is unverified and obtain explicit approval for a bounded capacity trial; AWS may refuse additional hosts. Confirm pricing and record the approved deployment target and saved plans. Pool vCPUs are not a dollar cap: startup, idle hosts and AWS's one-host overshoot are chargeable. More workers consume the same per-job and owner GPU-time allowances faster.
2. Commit and push the reviewed source, build clean artifacts, and plan both stacks from that commit. Require an in-place compute-resource maximum update: refuse queue, environment, job-definition, image or network replacement.
3. Save the API and coordinator reserved-concurrency values, set both to zero to stop new admission and coordinator invocations, and wait for in-flight invocations to finish. Keep every existing provider ID, intent, range, reservation and solver pin. Existing GPU chunks can continue and store their results while the coordinator is frozen.
4. Apply the exact GPU and app plans while admission remains frozen. Verify source/artifact hashes, both `gpu_capacity` outputs, the live 96-vCPU nominal maximum and 112-vCPU total bound, unchanged image/queue/definition and six parallel slots. Do not change any mainnet or exact-submit switch.
5. Restore the saved concurrency values and inspect each withdrawal execution. A coordinator freeze can exhaust the workflow's bounded throttle retries and leave an execution in `NeedsOperatorAttention` while its durable job still says `searching`; restoring concurrency does not restart it. Confirm the prior execution is terminal, inspect the durable job and every retained submission intent, and reconcile any unknown outcome first. Then start one operator recovery execution with the same owner, job ID and current revision under a new unique execution name. It polls retained provider IDs and applies normal result checks before filling free slots; never retry the failed task or resubmit a recorded paid intent. If the durable job is paused, reconcile its reason and explicitly resume using the normal revision/audit path instead. Confirm the recovered workflow is running and collecting existing results. Observe Batch and Auto Scaling launch activity for quota or capacity failures. If additional workers remain unallocated, stop the trial by freezing new coordinator invocations, drain/cancel retained IDs with confirmed terminal outcomes, and restore the previous coordinated policy. Do not replay paid submissions or automatically request more capacity.

Rollback uses the same coordinated procedure. Before lowering the pool ceiling or slot limit, drain excess work without replaying paid submissions; do not shrink capacity under active chunks.
