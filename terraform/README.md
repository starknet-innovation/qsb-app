# Terraform deployment (AWS application, AWS Batch GPUs)

This folder deploys the **single Step Functions application pipeline** into a fresh AWS account. GPUs run on an existing AWS Batch serverless endpoint. Mainnet job creation follows API Lambda → Step Functions → coordinator Lambda → AWS Batch, with CPU re-checks in the reference Lambda. See [mainnet pipeline](../docs/MAINNET-PIPELINE.md).

There is no supervised host, VPC/NAT, EBS/Backup, dispatch queue/DLQ, evidence bucket/table, watchdog, runtime installer or ECR repository in this application stack. Supervised source remains parked for removal under #23. GitHub OIDC deployment bootstrap remains separate and supported. Applying Terraform is not mainnet activation, wallet compatibility certification, or permission to spend funds. See [mainnet readiness](../docs/MAINNET-READINESS.md).

Recorded local evidence: [single-pipeline mock plan inventory](../docs/SINGLE-PIPELINE-PLAN.json). The configured plan has 43 infrastructure resources plus 21 frontend objects for this build, three Lambda functions, four service roles, one MFA-required reconciliation role and one table. Counts of frontend objects vary with the build. This is not a live regional plan or deployment.

## Resources

| Component | Resources |
| --- | --- |
| Web | Private versioned/encrypted S3 bucket, public-access block, CloudFront OAC, HTTPS distribution and security headers |
| API | HTTP API Gateway, throttled default stage, Node.js 22 ARM64 Lambda |
| Persistence | On-demand DynamoDB table with `pk`/`sk`, `expiresAt` TTL, point-in-time recovery and deletion protection |
| Search control | Node.js 22 coordinator, Standard Step Functions loop and continuation; no generic retry around paid work |
| CPU checks | Python 3.13 ARM64 reference Lambda; public inputs only |
| Operations | Separate service roles, resource-scoped data/compute grants, 30-day log retention and failure alarms |
| External | Existing AWS Batch endpoint and optional existing Secrets Manager ARN; no secret values in Terraform |

The `provision_runtime`, `runtime_*` and cleanup-endpoint settings have been removed. No EC2 GPUs, custom DNS or certificates are needed for the default CloudFront hostname. AWS-managed public networking reaches AWS Batch. Custom domains, WAF/rate policy beyond API throttling and regional IAM/cutover review remain separate work. This is the first-deploy layout for a new account, not a migration or teardown procedure. Do not apply it to an existing supervised state: removed resources would be scheduled for destruction. Preserve any old state and infrastructure until a separately reviewed migration and teardown is authorized.

## Prerequisites

- Terraform 1.7+ (less than 2), Node.js 22+, npm, Python 3 and curl.
- An AWS account and an authenticated local AWS profile/session with deployment permissions. No access keys in `.tfvars`.
- A clean, committed and pushed checkout. The provider account allowlist prevents accidental account targeting.
- Enough regional Lambda reserved-concurrency quota for three functions (default two each).
- Existing AWS Batch setup only if you need provider diagnostics/isolated operator validation. Omit both compute settings for a frontend/API preview.

The historical registry location in this public snapshot is deliberately a placeholder. You must build and review a compatible worker/release binding before an operator search; supplying an arbitrary leaderboard or optimized image to this historical coordinator is unsupported. Infrastructure provisioning does not repair or activate that binding.

## Build, plan, deploy

From the repository root:

```sh
npm ci
npm run vendor
npm test
# Commit and push any source changes before proceeding.
# No solver selected: valid unconfigured deployment, no new GPU jobs.
node terraform/scripts/build.mjs --network=mainnet
# For an explicitly selected solver, instead build with its enrolled ID:
# node terraform/scripts/build.mjs --network=mainnet --solver-release=RELEASE_ID
export TF_VAR_source_commit="$(git rev-parse HEAD)"
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# Edit terraform.tfvars: intended account, region/name; optional existing AWS Batch references.
terraform -chdir=terraform init -backend-config="bucket=${QSB_STATE_BUCKET:?Set the bootstrap state bucket}"
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=deployment.tfplan
terraform -chdir=terraform show -json deployment.tfplan > /tmp/qsb-plan.json
python3 terraform/tests/check-single-pipeline.py /tmp/qsb-plan.json --deploy
# First apply in an account only: also require a create-only plan.
# python3 terraform/tests/check-single-pipeline.py /tmp/qsb-plan.json --deploy --first-apply
# Review the complete plan. Verify git status is clean and HEAD is pushed to origin.
terraform -chdir=terraform apply deployment.tfplan
terraform -chdir=terraform output app_url
```

State is kept in the bootstrap state bucket under `qsb/main/terraform.tfstate`, fixed in `versions.tf`, next to the GPU stack's `qsb/gpu/terraform.tfstate`. It uses S3 lockfiles, so Terraform 1.11 or later is required. The deploy role and `qsb-operator` can read and write only under `qsb/` and delete only `.tflock` objects. Confirm this with `ops/github-aws/verify.py` ("state deletion").

**Settings the scoped roles depend on.** Set these in `terraform.tfvars` for every apply, including the first:

| Variable | Value | Why |
| --- | --- | --- |
| `name` | starts with `qsb-`, not `qsb-gpu` (for example `qsb-app`) | the deploy and operator grants match `qsb-*` Lambda, DynamoDB, Step Functions, alarm, log and bucket names; `qsb-gpu-*` roles may carry only the GPU boundary |
| `iam_role_path` | `/qsb/runtime/` | the scoped roles can read, change and pass only runtime roles there |
| `iam_permissions_boundary_arn` | the `qsb-runtime-boundary` ARN (`/qsb/bootstrap/`) | they can create or change runtime roles only with that boundary |
| `operator_principal_arns` | the `qsb-operator` role ARN | reconcile runs as `qsb-operator`; the reconcile role stays dormant |
| `solver_release_id`, `batch_job_queue`, `batch_job_definition`, `batch_job_bucket` | the enrolled release and the `terraform/gpu` outputs | the served solver and the GPU backend |
| `mainnet_enabled`, `exact_submit_enabled` | `false` | turned on only under #22 with explicit approval |

Getting the role path wrong on the first apply means replacing the roles later, which needs an administrator again. `check-single-pipeline.py --deploy` refuses a plan that breaks the name, path, boundary or reconcile-principal rule.

**First apply in an account.** It runs once as an administrator, today the account root, as a recorded exception to "no Terraform as root". The deploy role and `qsb-operator` can manage only CloudFront and API Gateway resources whose IDs are registered in the private inventory, and this stack creates new ones. Steps:
1. Use `qsb-viewonly` to check that nothing named `<name>-*` exists yet. IAM role names are unique across the account.
2. Check that the state key is empty, so `plan` must be create-only, then run `check-single-pipeline.py --deploy --first-apply`.
3. Start the apply with a fresh session. CloudFront can take over 15 minutes, and exported credentials last at most an hour. If they expire mid-apply, Terraform writes `errored.tfstate`. In that case:
   - run `terraform state push errored.tfstate`, and `terraform force-unlock` if a lock remains;
   - then plan again;
   - never re-apply blind.
4. Register the new IDs. Take them from the outputs `cloudfront_distribution_id`, `origin_access_control_id`, `response_headers_policy_id` and `api_id`, and put them in the inventory keys `distributions`, `origin_access_controls`, `response_headers_policies` and `apis`. Put them *in place of* the parked legacy stacks' IDs: those stacks are admin-only until they're torn down, and swapping keeps the rendered policies the same size.
5. Run `ops/github-aws/update_installed.py`:
   - plan mode as `qsb-viewonly`;
   - review it;
   - then, from a clean `main`, `--apply` as the administrator, confirmed or with `--yes --plan-hash`.

   It refuses if the operator policies would need a different number of documents, or if a changed policy already has five versions. Either way, stop and handle it as a reviewed step.
6. From then on, run plans and applies as `qsb-operator`.

Replacing any registered resource later (the distribution, origin access control, response-headers policy or API) needs the administrator again. So do changes to the API stage's access-log settings, which need account-wide log-delivery permissions. The API and stage ignore tag changes, so new commits don't need API Gateway tag permissions. **Verify** both behaviours on the first `qsb-operator` apply.

Terraform can't prompt for MFA or read an `aws login` session. Export the CLI session instead, as described in `ops/github-aws/README.md`.

`build.mjs` runs pinned upstream preparation, typecheck/frontend build, bundles both Node Lambda entrypoints (including SDK dependencies), creates deterministic Lambda ZIPs and records file SHA256s/network/commit. The build is done **before** Terraform parses `fileset`/file hashes. It does not deploy anything. The build packages only frontend assets, API, coordinator and CPU reference; it does not build a supervised dispatcher or host archive. Pass `--network=mainnet` or `--network=testnet4`; an omitted network is refused. The Terraform `network` variable has no default, and `terraform.tfvars.example` sets `mainnet`. The normal builder refuses a dirty tree; `--allow-dirty` permits local inspection only and records `clean:false`, which the Terraform deployment gate rejects.

Choose `--network=testnet4` and `network="testnet4"` together for a Testnet4-identity preview. Both mainnet operations and Testnet4 rehearsal remain disabled; this does not assert that the installed Xverse supports Testnet4. There is intentionally no `enable_mainnet` or rehearsal activation variable.

Artifacts must remain in `terraform/.build` through plan/apply. Terraform rejects mismatched commit/network, dirty builds, changed artifact hashes, changed frontend file membership and incomplete AWS Batch configuration. These checks are local consistency controls, not cryptographic provenance of a developer-controlled manifest. The operator must verify the commit is pushed before every apply. Never apply a stale saved plan after changing the checkout/configuration/artifacts.

### AWS Batch credentials

Supply all three `batch_job_queue`, `batch_job_definition` (revisioned ARN), and `batch_job_bucket` from the independently deployed [`gpu/`](gpu/README.md) stack, or leave all three empty. Only the coordinator can submit paid jobs. The MFA reconciliation operator can inspect jobs and read output artifacts but cannot submit them. No AWS Batch API key or Secrets Manager secret is used by this pipeline. Select the matching enrolled schema-v3 `solver_release_id`. Configuring compute does not enable mainnet or exact submission.

The coordinator Lambda environment and `gpu_limits` output publish `workersMax=1`, `workersMin=0`, and `executionTimeoutMs=900000` from `server/gpu-spend.json`, plus `MAX_JOB_GPU_SECONDS=14745600` (4,096 GPU-hours per job). Before each paid submission the coordinator verifies the AWS Batch job definition and compute environment limits and does not submit unless they match. It atomically reserves the execution timeout before every paid POST and pauses if the cumulative time reservation would exceed that budget. Failed, cancelled, timed-out and uncertain submissions remain charged; stage changes and resume requests cannot reset it; it does not credit a 64-hit output as a finished range. Applying Terraform does not call AWS Batch, start a workflow, or authorize spend. `release.mainnetEnabled` and `broadcastAuthorized` stay false. AWS Lambda concurrency is **not** a GPU spending cap. The experimental GPU USD ceiling stays unevaluated. IAM-authorized direct validation invocations can use paid compute even while public transaction routes are gated: restrict operator access accordingly.

### State and configuration

For GitHub OIDC, follow [the separate administrator bootstrap](../ops/github-aws/README.md). Its identity trust and authentication-only workflow remain unchanged. The bounded deployment role cannot create CDN/API resources, so an administrator runs the first apply and registers the resulting IDs (see "First apply in an account" above).

State lives in the separately bootstrapped, encrypted and locked S3 backend described above; this stack never manages that bucket. Plans and any local `errored.tfstate` may contain operational metadata: keep them private and outside Git. `.gitignore` excludes state, plans, local tfvars and artifacts. No backend credentials belong in source. Commit `.terraform.lock.hcl`.

## Updates and rollback

1. Commit/push the reviewed source; build from that exact clean checkout.
2. Refresh `TF_VAR_source_commit`, review a new plan, then apply.
3. Invalidate CloudFront after assets change (AWS CLI is optional for this step):

```sh
aws cloudfront create-invalidation \
  --distribution-id "$(terraform -chdir=terraform output -raw cloudfront_distribution_id)" \
  --paths '/*'
```

Static assets use content hashes; other files use revalidation headers. CloudFront's managed static policy has its own minimum TTL, so explicit invalidation avoids stale entrypoint/runtime files. API requests are uncached and preserve authorization/cookies/query parameters. No global SPA error rewrite is configured, so API errors are never rewritten into a misleading HTML success.

For rollback, rebuild an approved prior clean pushed commit and review its plan against the current state. Do not roll back reservation semantics, restore conflicting legacy writers or replay old workflows without a migration/reconciliation decision. Bucket/table protection intentionally makes `terraform destroy` insufficient to discard durable data; removal is a separate explicit operator action. Logs have a 30-day retention policy. Alarm notifications require existing SNS topic ARNs in `alarm_actions`; empty means alarms exist without notifications.

## Validation without AWS changes

```sh
terraform -chdir=terraform fmt -check -recursive
terraform -chdir=terraform init -backend=false
terraform -chdir=terraform validate
# First build from the current clean committed checkout (mainnet identity for these tests).
export TF_VAR_source_commit="$(git rev-parse HEAD)"
node --import tsx terraform/scripts/review-fixtures.mjs
terraform -chdir=terraform test -json -verbose > /tmp/qsb-terraform-tests.jsonl
python3 terraform/tests/check-single-pipeline.py /tmp/qsb-terraform-tests.jsonl
```

The tests use a mocked AWS provider and plan only. `check-single-pipeline.py` checks both expanded mocked plans (unconfigured preview and configured AWS Batch) or a saved real plan: exactly three application Lambdas, four service roles, one MFA-required reconciliation role, one table, one state machine and one frontend bucket, with no supervised infrastructure or secret-value resources. Counts exclude frontend objects and the separately bootstrapped GitHub OIDC/state infrastructure. They check disabled activation, persistence protection, absence of API provider credentials, no generic paid-work retry, and rejection of network/commit/partial-provider mismatches. They do not call AWS or AWS Batch and do not certify a real deployment. Live regional IAM/service behavior, browser serving, provider compatibility and all mainnet acceptance gates still need actual validation.

References: [Lambda + HTTP API](https://developer.hashicorp.com/terraform/tutorials/aws/lambda-api-gateway), [fileset build-time semantics](https://developer.hashicorp.com/terraform/language/functions/fileset), [provider resource documentation](https://registry.terraform.io/providers/hashicorp/aws/latest/docs).

The coordinator AWS Batch credential must have permission to **update the configured
endpoint** as well as submit/status/cancel jobs. The control-plane PATCH happens
before a paid attempt is journaled. A failed check produces a resumable pause
without consuming a submission; successful confirmation yields a single-use POST.
The JSON file is the source of the reported limits; Terraform does not duplicate
its attempt/timeout literals. The bundled application schema validates its bounds.
See the operational runbook for sizing, worst-case execution allowance and limits
of cost estimates. The 90-second coordinator timeout includes the CPU export,
limits preflight, POST and database persistence. Applying this configuration does
not establish a strict physical startup-worker bound: extra INITIALIZING provider
records and idle/storage billing require separate operational observation.

### Reconciliation operator role

For the bootstrap human-access flow, run reconciliation directly as the
MFA-backed `qsb-operator`; follow [Reconciliation with the bootstrap operator
profile](../docs/OPERATIONAL-RUNBOOK.md#reconciliation-with-the-bootstrap-operator-profile).
That session has broader deployment and QSB data privileges, not merely the
CLI's exact-record scope. Do not configure a second assume-role hop: the bootstrap
user and its roles explicitly deny role chaining.

Terraform still declares the separately scoped `operator_reconcile_role_arn`.
`operator_principal_arns` is required with no default; for this bootstrap flow,
supply the exact `qsb-operator` role ARN in private tfvars. `NoRoleChaining` keeps
that principal from assuming the runtime reconcile role, so this role stays
dormant for the bootstrap identity. Account-root delegation and wildcards are
rejected. The role uses the configured IAM path and permissions boundary, and
requires MFA; do not weaken those conditions to bypass the bootstrap design.

Its inline policy remains distinct from the broader `qsb-operator` policy:
GetItem/PutItem on present OWNER partitions, StartExecution on the one workflow,
and, when Batch is configured, regional Batch DescribeJobs/ListJobs/DescribeJobQueues
plus GetObject on the configured outputs prefix. It has no provider-secret or
KMS decrypt grant. The administrator-managed boundary must also permit those
actions; this stack does not change its policy.

### Served solver release

Build with `node terraform/scripts/build.mjs --network=mainnet --solver-release=RELEASE_ID`, using the enrolled schema-v3 producer descriptor. The existing generated `.build/manifest.json` records its canonical image digest, solver repository commit and descriptor hash alongside the actual CPU `reference.zip` digest and app commit. These are two repository commits after the solver split; they are not claimed to be one source tree. Without `--solver-release`, the generated selection is null and no solver is served.

Set `solver_release_id` to that exact generated ID (or leave it empty for an unconfigured build). Terraform rejects a selection different from the build and verifies the CPU artifact identity. It reads the same generated `SOLVER_RELEASE_ID` for API
and coordinator. Empty, unsupported, unbound or mismatched releases refuse new
job admission before outpoint reservations. Omitted request IDs select this
deployment release, not the archived placeholder. The coordinator rechecks the
selection before paid work and still verifies the endpoint image before each POST.
Do not change the served release while pinned jobs remain active. Existing
historical descriptors remain available for inspection. Publication/enrollment
and live endpoint-response verification remain prerequisites before #22.

Mainnet funding/search is controlled by `mainnet_enabled` (default false), wired identically to API and coordinator. Exact submission additionally needs `exact_submit_enabled` (default false). Enablement requires explicit issue #22 approval; no source toggle or frontend rebuild is needed. See [switch matrix and deployment checks](../docs/OPERATIONAL-RUNBOOK.md#deploy-time-mainnet-and-submit-switches).
