# QSB GPU backend on AWS Batch

This stack runs the external qsb-solver pinning and subset worker on one On-Demand g5.xlarge A10G in Ireland. It is separate from the application state, so provisioning GPU compute cannot recreate the parked CDK stacks or activate mainnet.

Capacity: EC2 BEST_FIT, min 0/max 4 vCPUs, g5.xlarge only. Verify that the operator account's G/VT quota supports 4 vCPUs. Job definitions require one GPU, 4 vCPUs, 12 GB RAM, one attempt and a 900-second running timeout. An independent five-minute EventBridge/Lambda watchdog terminates jobs older than 30 minutes, including startup/queue time. It never submits replacements. Capacity scales to zero after AWS Batch's idle cooldown; this is not an instantaneous stop or a hard dollar budget. Idle startup/termination and storage are chargeable.

The worker image is a digest in private ECR, built from a clean pushed qsb-solver commit by its AWS worker workflow. Inputs and outputs contain public search data only, live in encrypted private S3 and expire after 30 days. Jobs run without privileged mode, drop all capabilities and have a read-only root filesystem with writable /tmp. Their task role can only read inputs and write outputs. Network HTTPS is required for S3/ECR/Batch; no inbound ports are open. The host uses IMDSv2 and encrypted delete-on-termination EBS. Mainnet and exact-submit switches remain false.

## Deploy

Use an operator-configured AWS profile and explicitly supply the expected `aws_account_id`, in eu-west-1. Commit and push source first and verify `git status --porcelain` is empty. Initialize a separate encrypted backend:

```
terraform init -backend-config="bucket=${QSB_STATE_BUCKET:?Set the operator state bucket}" -backend-config=key=qsb/gpu/terraform.tfstate -backend-config=region=eu-west-1 -backend-config=encrypt=true -backend-config=use_lockfile=true
```

Supply `release_manifest_path` (the generated app `terraform/.build/manifest.json` built with `--solver-release=RELEASE_ID`), `source_commit` (that clean pushed app commit), `image` (verified ECR digest), `vpc_id` and public `subnets` with an Internet gateway. Also supply the required `gpu_permissions_boundary_arn`:

```hcl
gpu_permissions_boundary_arn = "arn:aws:iam::123456789012:policy/qsb/bootstrap/qsb-gpu-boundary"
```

Replace the example account with `aws_account_id`; other accounts, policy names and paths are rejected. All four GPU roles (`qsb-gpu-instance`, `qsb-gpu-job`, `qsb-gpu-execution`, `qsb-gpu-watchdog`) retain `/qsb/runtime/` and use this same boundary. There is no unbounded default, including when applying as an administrator. The boundary must already exist from the separately reviewed [access bootstrap](../../ops/github-aws/README.md); this stack references it and cannot create or modify its policy. The #56 operator grant requires that exact boundary, and #57 separately tightens the access-role policies. Supplying an ARN does not establish that its live policy document matches reviewed source: verify that separately before apply. Existing roles receive an attachment update in the plan; this source change does not attach a boundary to live roles by itself.

First build the app with the enrolled public release; this creates the generated manifest without an ECR repository or GPU deployment. On first deployment only, supply that manifest and target the ECR repository, verify the published GHCR AWS solver release and its build-provenance attestation, then use a digest-preserving registry copy into ECR. Verify that both registry manifest digests are identical before a full plan/apply; do not substitute a Docker load/push or an unattested workflow tarball for the attested release. The GPU plan reads the same generated app manifest and requires an enrolled schema-3 descriptor with matching ID, image and solver commit, binds the CPU reference identity, and verifies every listed artifact hash relative to the manifest directory. These are local consistency checks, not independent build attestation. Never use a mutable tag or substitute the Docker config digest for the registry manifest digest. Save plans, source/build receipt, outputs and smoke-test records outside Git.

Bind outputs `queue`, `definition`, and `bucket` to the application stack's `batch_job_queue`, `batch_job_definition`, and `batch_job_bucket`. The migration smoke image was checksummed but not attested and remains absent from the release registry. The attested `aws-v0.1.0` producer asset is now enrolled as `src/lib/releases/qsb-solver-aws-v0-1-0.json`; provenance verification and anonymous GHCR digest verification passed. ECR mirroring and deployment remain pending. Copy the identical manifest into ECR with a digest-preserving registry copy. Verify both registry digests match; a local Docker load/push receipt is not a provenance attestation. Historical descriptors are immutable. The coordinator refuses a changed image, retry count, timeout, instance type or capacity before paid submission.

Run one bounded public fixture through the deployed revision; never retry an uncertain SubmitJob response (the API has no idempotency token). Record intent before submit, reconcile the original request name/tag through Batch/CloudTrail if uncertain, collect output/logs, CPU-check every candidate, and verify the job is terminal and EC2 capacity returns to zero. Do not activate wallet operations or broadcast a transaction as a migration test.

Legacy persisted `runpodId` is retained as a storage field for compatibility; `computeProvider=aws-batch` distinguishes new jobs. Existing legacy-provider jobs pause for operator reconciliation instead of being polled or replayed on AWS. No automatic fallback calls Runpod. The parked historical stacks remain paused until their separately authorized removal.

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
