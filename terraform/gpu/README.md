# QSB GPU backend on AWS Batch

This stack runs the external qsb-solver pinning and subset worker on one On-Demand g5.xlarge A10G in Ireland. It is separate from the application state, so provisioning GPU compute cannot recreate the parked CDK stacks or activate mainnet.

Capacity: EC2 BEST_FIT, min 0/max 4 vCPUs, g5.xlarge only. The account's G/VT quota is also 4. Job definitions require one GPU, 4 vCPUs, 12 GB RAM, one attempt and a 900-second running timeout. An independent five-minute EventBridge/Lambda watchdog terminates jobs older than 30 minutes, including startup/queue time. It never submits replacements. Capacity scales to zero after AWS Batch's idle cooldown; this is not an instantaneous stop or a hard dollar budget. Idle startup/termination and storage are chargeable.

The worker image is a digest in private ECR, built from a clean pushed qsb-solver commit by its AWS worker workflow. Inputs and outputs contain public search data only, live in encrypted private S3 and expire after 30 days. Jobs run without privileged mode, drop all capabilities and have a read-only root filesystem with writable /tmp. Their task role can only read inputs and write outputs. Network HTTPS is required for S3/ECR/Batch; no inbound ports are open. The host uses IMDSv2 and encrypted delete-on-termination EBS. Mainnet and exact-submit switches remain false.

## Deploy

Use AWS profile snf, account 905846953990, eu-west-1. Commit and push source first and verify `git status --porcelain` is empty. Initialize a separate encrypted backend:

```
AWS_PROFILE=snf terraform init -backend-config=bucket=snf-qsb-terraform-state-905846953990-eu-west-1 -backend-config=key=qsb/gpu/terraform.tfstate -backend-config=region=eu-west-1 -backend-config=encrypt=true -backend-config=use_lockfile=true
```

Supply `source_commit` (the clean pushed app commit), `image` (verified ECR digest), `vpc_id` and public `subnets` with an Internet gateway. On first deployment only, target the ECR repository, import the checksummed solver workflow image, push it and record the resulting manifest digest before a full plan/apply. Never use a mutable tag or substitute the Docker config digest for the registry manifest digest. Save plans, source/build receipt, outputs and smoke-test records outside Git.

Bind outputs `queue`, `definition`, and `bucket` to the application stack's `batch_job_queue`, `batch_job_definition`, and `batch_job_bucket`. Enroll the same image and solver commit as a new schema-v3 release. Historical descriptors are immutable. The coordinator refuses a changed image, retry count, timeout, instance type or capacity before paid submission.

Run one bounded public fixture through the deployed revision; never retry an uncertain SubmitJob response (the API has no idempotency token). Record intent before submit, reconcile the original request name/tag through Batch/CloudTrail if uncertain, collect output/logs, CPU-check every candidate, and verify the job is terminal and EC2 capacity returns to zero. Do not activate wallet operations or broadcast a transaction as a migration test.

Legacy persisted `runpodId` is retained as a storage field for compatibility; `computeProvider=aws-batch` distinguishes new jobs. Existing legacy-provider jobs pause for operator reconciliation instead of being polled or replayed on AWS. No automatic fallback calls Runpod. The parked historical stacks remain paused until their separately authorized removal.
