# Terraform deployment (AWS application, AWS Batch GPUs)

This folder deploys the **single Step Functions application pipeline**: API Lambda → Step Functions → coordinator Lambda → AWS Batch, with CPU re-checks in the reference Lambda ([how a withdrawal runs](../README.md#how-a-withdrawal-runs)). GPU searches run on the separate AWS Batch stack in [`gpu/`](gpu/README.md). The GitHub OIDC deploy identity and the state bucket come from the [administrator bootstrap](../ops/github-aws/README.md).

Applying Terraform doesn't turn mainnet on and doesn't authorize a spend: the deploy-time switches do the first ([runbook](../docs/OPERATIONAL-RUNBOOK.md#deploy-time-mainnet-and-submit-switches)), and every withdrawal needs the user's approval.

## Resources

| Component | Resources |
| --- | --- |
| Web | Private versioned/encrypted S3 bucket, public-access block, CloudFront OAC, HTTPS distribution and security headers |
| API | Node.js 22 ARM64 Lambda behind a function URL (`AWS_IAM`) that only CloudFront can call, through origin access control; no direct address and no API Gateway |
| Persistence | On-demand DynamoDB table with `pk`/`sk`, `expiresAt` TTL, point-in-time recovery and deletion protection |
| Search control | Node.js 22 coordinator, Standard Step Functions loop and continuation; no generic retry around paid work (only a throttled coordinator invoke is retried) |
| CPU checks | Python 3.13 ARM64 reference Lambda; public inputs only |
| Operations | Separate service roles, resource-scoped data/compute grants, 30-day log retention, failure alarms and a stray-payment alarm |
| External | The GPU stack's AWS Batch queue, job definition and bucket, and an optional administrator-created `qsb/slipstream` secret (the API's MARA Slipstream credential); no secret values in Terraform |
| Webhook retries (off by default) | A keys-only `webhook-due` index on the table, always; with `webhook_dispatcher_enabled`, a Node.js 22 dispatcher Lambda that Lambda doesn't retry and an EventBridge Scheduler schedule every 5 minutes, each with its own bounded role (`webhooks.tf`); see [Scheduled webhook dispatcher](../docs/OPERATIONAL-RUNBOOK.md#scheduled-webhook-dispatcher) |

No custom DNS or certificates are needed for the default CloudFront hostname. Custom domains, WAF and rate policies aren't set up; the API Lambda's reserved concurrency caps the API. The API names its CloudFront origin in sign-in challenges and allows it for CORS, and reads it from the records table's `SYSTEM#DEPLOYMENT` / `APP_ORIGIN` row, which Terraform writes once the distribution exists (`terraform/web.tf`). Until that row exists, sign-in answers 503 `app_origin_unavailable`; a container reads the row again every five minutes.

## Prerequisites

- Terraform 1.11+ (less than 2; S3 state lockfiles need 1.11), Node.js 22+, npm, Python 3 and curl.
- An AWS account and an authenticated local AWS profile/session with deployment permissions. No access keys in `.tfvars`.
- A clean, committed and pushed checkout. The provider account allowlist prevents accidental account targeting.
- Enough regional Lambda reserved-concurrency quota for three functions (default two each), plus one for the webhook dispatcher when `webhook_dispatcher_enabled` is set.
- For a stack that searches, the GPU stack's outputs and an enrolled solver release ([serving a release](../docs/SOLVER-REPOSITORY.md#serving-a-release)). Leave all three Batch settings empty for a frontend/API preview.

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
terraform -chdir=terraform init -backend-config="bucket=${QSB_STATE_BUCKET:?Set the bootstrap state bucket}" -backend-config=region=eu-west-2
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
| `region` | `eu-west-2` | organisation requirement; required, with no default. A region move is a new stack, never an in-place change: see [REGION-MIGRATION.md](../docs/REGION-MIGRATION.md) |
| `name` | starts with `qsb-`, not `qsb-gpu` (for example `qsb-app`) | the deploy and operator grants match `qsb-*` Lambda, DynamoDB, Step Functions, alarm, log and bucket names; `qsb-gpu-*` roles may carry only the GPU boundary |
| `iam_role_path` | `/qsb/runtime/` | the scoped roles can read, change and pass only runtime roles there |
| `iam_permissions_boundary_arn` | the `qsb-runtime-boundary` ARN (`/qsb/bootstrap/`) | they can create or change runtime roles only with that boundary |
| `operator_principal_arns` | the `qsb-operator` role ARN | reconcile runs as `qsb-operator`; the reconcile role stays dormant |
| `solver_release_id`, `batch_job_queue`, `batch_job_definition`, `batch_job_bucket` | the enrolled release and the `terraform/gpu` outputs | the served solver and the GPU backend |
| `mainnet_enabled`, `exact_submit_enabled` | `false` by default | changed only with the user's explicit approval; see the [switch matrix](../docs/OPERATIONAL-RUNBOOK.md#deploy-time-mainnet-and-submit-switches) |
| `api_keys_enabled` | `false` | scoped API keys ([docs/API.md](../docs/API.md)); turned on only with the maintainer's explicit approval of third-party access |
| `slipstream_secret_arn` | empty, or the `qsb/slipstream` secret's ARN | the API's optional MARA Slipstream credential; see [MARA Slipstream credential](#mara-slipstream-credential) |
| `webhook_dispatcher_enabled` | `false` by default | the scoped roles need the installed Scheduler grants first; see [Scheduled webhook dispatcher](../docs/OPERATIONAL-RUNBOOK.md#scheduled-webhook-dispatcher) |

Getting the role path wrong on the first apply means replacing the roles later, which needs an administrator again. `check-single-pipeline.py --deploy` refuses a plan that breaks the name, path, boundary or reconcile-principal rule.

**First apply in an account.** It runs once as an administrator: in the current account, a temporary admin role for the day. The deploy role and `qsb-operator` can manage only CloudFront resources whose IDs are registered in the private inventory, and this stack creates new ones. Steps:
1. Use `qsb-viewonly` to check that nothing named `<name>-*` exists yet. IAM role names are unique across the account.
2. Check that the state key is empty, so `plan` must be create-only, then run `check-single-pipeline.py --deploy --first-apply`.
3. Start the apply with a fresh session. CloudFront can take over 15 minutes, and exported credentials last at most an hour. If they expire mid-apply, Terraform writes `errored.tfstate`. In that case:
   - run `terraform force-unlock` first if a lock remains, because `state push` takes the lock, then `terraform state push errored.tfstate`;
   - then plan again;
   - never re-apply blind.
4. Register the new IDs. Take them from the outputs `cloudfront_distribution_id`, `origin_access_control_ids` (the frontend's and the API's) and `response_headers_policy_id`, and put them in the inventory keys `distributions`, `origin_access_controls` and `response_headers_policies`. Until then the rendered deploy and operator policies name an `UNREGISTERED` placeholder, so registering the real IDs keeps the policies the same shape.
5. Run `ops/github-aws/update_installed.py`:
   - plan mode as `qsb-viewonly`;
   - review it;
   - then, from a clean `main`, `--apply` as the administrator, confirmed or with `--yes --plan-hash`.

   It refuses if the operator policies would need a different number of documents, or if a changed policy already has five versions. Either way, stop and handle it as a reviewed step.
6. From then on, run plans and applies as `qsb-operator`. On the first such plan, when every Lambda environment is known from state, run `check-single-pipeline.py --deploy` again: it then checks key names and constants that a first plan can only check through configuration references.

Replacing any registered resource later (the distribution, either origin access control or the response-headers policy) needs the administrator again, and so does creating a new one.

Terraform can't prompt for MFA or read an `aws login` session. Export the CLI session instead, as described in `ops/github-aws/README.md`.

`build.mjs` runs pinned upstream preparation, typecheck/frontend build, bundles the three Node Lambda entry points, API, coordinator and webhook dispatcher (including SDK dependencies), creates deterministic Lambda ZIPs and records file SHA256s/network/commit. The build is done **before** Terraform parses `fileset`/file hashes. It does not deploy anything. It packages the frontend assets, API, coordinator, CPU reference and the webhook dispatcher (`webhooks.zip`, deployed only with `webhook_dispatcher_enabled`). Pass `--network=mainnet`, the only network QSB runs on; an omitted or other network is refused. The Terraform `network` variable has no default, accepts only `mainnet`, and `terraform.tfvars.example` sets it. The normal builder refuses a dirty tree; `--allow-dirty` permits local inspection only and records `clean:false`, which the Terraform deployment gate rejects.

Artifacts must remain in `terraform/.build` through plan/apply. Terraform rejects mismatched commit/network, dirty builds, changed artifact hashes, changed frontend file membership and incomplete AWS Batch configuration. These checks are local consistency controls, not cryptographic provenance of a developer-controlled manifest. The operator must verify the commit is pushed before every apply. Never apply a stale saved plan after changing the checkout/configuration/artifacts.

### Deploy from GitHub

`.github/workflows/deploy.yml` runs the plan and apply above on GitHub as `qsb-github-deploy`. It runs on every push to `main` except docs-only ones, and on demand from the Actions tab:
1. **build**, with no AWS credentials: the build above, with `--solver-release` set from the `QSB_SOLVER_RELEASE_ID` repository variable.
2. **plan**: fetches the private tfvars, plans with `source_commit` set to the pushed commit, and writes a summary to the run page. Then it runs `check-single-pipeline.py --deploy` and keeps the saved plan in the state bucket.
3. **approve**: waits for a reviewer on the `qsb-deploy` environment. Read the summary on the run page, then approve or reject.
4. **apply**: applies that exact plan, checked by digest, with the build the plan used. Terraform refuses the plan if the state has changed since. Re-running a failed apply job reuses its approval and plan.

Runs are one at a time. A newer push waits for the current run, and replaces any older run that's still waiting to start. Don't cancel a run while it's applying: GitHub may kill Terraform before it saves its state. If that happens, check for a leftover lock and `errored.tfstate` as in step 3 of "First apply in an account", then plan again. The workflow never runs a first apply, because `--deploy` needs existing state. It doesn't touch the GPU stack, and it can't change IAM beyond the runtime roles. Those stay with the administrator and the operator, as above.

**Setup, once per account,** after the first apply and the ID registration:
- **Tfvars.** As the operator, upload the tfvars to `qsb/main/app.tfvars.json` in the state bucket: `aws s3 cp app.tfvars.json s3://<state bucket>/qsb/main/app.tfvars.json --profile qsb-operator`. The workflow ignores its `source_commit`. To change a setting, such as a mainnet switch, `slipstream_secret_arn` or the Batch references, upload the new file and run the workflow from the Actions tab.
- **Environment.** Create the `qsb-deploy` environment with yourself as a required reviewer, and limit it to `main` (Settings → Environments). The workflow refuses to run unless the environment requires a reviewer, because GitHub would otherwise create it with no protection.
- **Secrets.** Set the repository secrets `QSB_AWS_ROLE_ARN` (the `qsb-github-deploy` role), `QSB_AWS_ACCOUNT_ID` and `QSB_TERRAFORM_STATE_BUCKET`. They're secrets rather than variables because GitHub prints each step's inputs and environment in the log, and masks only secrets.
- **Variables.** Set the repository variables `QSB_AWS_REGION` and `QSB_SOLVER_RELEASE_ID`. `QSB_SOLVER_RELEASE_ID` must equal the tfvars' `solver_release_id`, or Terraform refuses the plan. Then set `QSB_AWS_DEPLOY_ENABLED` to `true`; while it's anything else, the workflow does nothing.

**The logs are public.** This repository is public, so its Actions logs, step summaries and artifacts are too.
- Terraform and AWS CLI output goes to private log files, kept with the saved plan under `qsb/github-deploy/<run>/` in the state bucket.
- The role is used through an AWS profile whose `credential_process` is `github_deploy.py credential-process`, not `aws-actions/configure-aws-credentials`, because that action logs the role's unique ID. The AWS CLI, Terraform and its S3 backend each fetch fresh credentials from GitHub's OIDC token when they need them, so nothing stores or prints them, and a long apply doesn't outlast its session.
- The tfvars' identifying values and every Terraform output are masked as soon as they're read.
- The run page shows only redacted errors, and a summary of which resources and attributes change, without their values (`terraform/scripts/github_deploy.py`).
- The build artifact is public, because it holds only what the public source builds.
- If an apply fails and leaves `errored.tfstate`, that file is kept with the logs; push it as in step 3 of "First apply in an account". The deploy role can't delete these records. An administrator can add a lifecycle rule for the `qsb/github-deploy/` prefix.

**What the approval is.** It's a process gate, not an IAM boundary. The deploy role trusts any job on `main`. It doesn't trust jobs bound to an environment, because those carry a different OIDC subject. So the approval job holds no credentials, and the apply is a separate job that runs after it. Anyone who can merge a workflow change into `main` could therefore deploy without an approval; branch protection on `main` is what limits that.

### AWS Batch credentials

Supply all three `batch_job_queue`, `batch_job_definition` (revisioned ARN), and `batch_job_bucket` from the independently deployed [`gpu/`](gpu/README.md) stack, or leave all three empty. Only the coordinator can submit paid jobs; the reconcile CLI can inspect jobs and read output artifacts but never submits. No AWS Batch API key or Secrets Manager secret is used. Select the matching enrolled schema-v3 `solver_release_id`. Configuring compute doesn't enable mainnet or exact submission.

The coordinator Lambda environment and `gpu_limits` output publish `workersMax`, `workersMin` and `executionTimeoutMs` from `server/gpu-spend.json`, plus `MAX_JOB_GPU_SECONDS` (4,096 GPU-hours per job). Terraform doesn't duplicate those literals. Before each paid submission the coordinator verifies the AWS Batch job definition and compute environment limits and doesn't submit unless they match. The spend rules are in the runbook's [GPU capacity and spend](../docs/OPERATIONAL-RUNBOOK.md#gpu-capacity-and-spend). Applying Terraform doesn't call AWS Batch or start a workflow.

### State and configuration

For GitHub OIDC, follow [the separate administrator bootstrap](../ops/github-aws/README.md). The bounded deployment role cannot create CDN/API resources, so an administrator runs the first apply and registers the resulting IDs (see "First apply in an account" above).

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

**Upload order.** `index.html` is the only file that names the content-hashed `assets/*`. The apply uploads it last, as `aws_s3_object.index`, after every other built file (`aws_s3_object.frontend`). Those use `create_before_destroy`, so a file dropped from the build, such as the previous bundle's hashed assets, is deleted after the new `index.html` is uploaded rather than at the start of the apply. The bucket therefore never serves an `index.html` that names a missing or not-yet-uploaded asset. A `moved` block carries the existing `index.html` object over to `aws_s3_object.index`. `check-single-pipeline.py` refuses source that loses this order or that mapping, and `tests/frontend_migration.tftest.hcl` plans the stack against a state in the earlier layout to check the move. Two gaps remain:
- An edge may keep serving the previous `index.html` for up to the cache policy's 1-second minimum TTL after the upload, while its assets are already gone.
- A tab opened before the deploy asks for the old solver-worker file when it starts the worker, and that file is gone.

Also don't use `-target` on frontend objects: `-target=aws_s3_object.frontend` leaves out `aws_s3_object.index`, so the ordering is lost. And the non-hashed `qsb/*.py` files are updated in place before `index.html`, so a page loaded mid-apply can mix versions.

Terraform takes a removed file's `create_before_destroy` from state. So the first apply of this order still deletes the files it drops first, as before, and the order holds from the next apply on. On that first plan, check that `index.html` shows as moved to `aws_s3_object.index`, not destroyed.

**Never apply a plan that replaces a frontend object or the bucket's public access block.** Under `create_before_destroy`, Terraform writes the replacement and then deletes the old object under the same key. The provider deletes every version of that key, so the new upload goes too. For the access block, the bucket is left with none. Such a plan comes from `-replace`, a tainted instance or a future ForceNew attribute; ordinary deploys never replace these. To re-upload a file, delete its S3 object and let the next apply create it again. `check-single-pipeline.py --deploy` refuses such a plan. Every mode of it refuses a plan that both creates and deletes one frontend object key. Applying a pre-split commit directly produces such a plan, but that commit's checker predates the rule, so a rollback relies on the runbook's plan check (see the rollback link below).

For rollback, rebuild an approved prior clean pushed commit and review its plan against the current state. A commit from before the `index.html` split has no `aws_s3_object.index`. Never apply one directly: follow [Rolling back past the index.html split](../docs/OPERATIONAL-RUNBOOK.md#rolling-back-past-the-indexhtml-split). It moves the object's state address first, and its plan check is required, not optional. Don't roll back reservation semantics or replay old workflows without a reviewed reconciliation decision ([runbook](../docs/OPERATIONAL-RUNBOOK.md#rollback)). Bucket/table protection intentionally makes `terraform destroy` insufficient to discard durable data; removal is a separate explicit operator action. Logs have a 30-day retention policy. Alarm notifications require existing SNS topic ARNs in `alarm_actions`; empty means alarms exist without notifications.

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

The tests use a mocked AWS provider and never call AWS. They only plan, except `tests/frontend_migration.tftest.hcl`, which also applies against the mock provider to seed state for its migration and rollback checks. `check-single-pipeline.py` checks the expanded mocked plans (unconfigured preview, configured AWS Batch, configured miner credential, and the enabled webhook dispatcher) or a saved real plan: exactly three application Lambdas and four service roles (four Lambdas and six service roles with the webhook dispatcher), one MFA-required reconciliation role, one table, one state machine and one frontend bucket, with no supervised infrastructure or secret-value resources. The table's only secondary index must be the keys-only `webhook-due` index. With the webhook dispatcher it also requires its whole set (the Lambda, its no-retry invoke settings, schedule, schedule role and both policies); that the schedule sends an empty invoke to the dispatcher with its own role and no retry; that the dispatcher's grants are exactly its index query and GetItem/PutItem on `WEBHOOK#` keys; and that its environment has only `TABLE_NAME`. Counts exclude frontend objects and the separately bootstrapped GitHub OIDC/state infrastructure. They check persistence protection, that the only secret grant is the API's read of the `qsb/slipstream` miner credential, no generic paid-work retry (the coordinator task retries only `Lambda.TooManyRequestsException`, and every other catchable error ends in `NeedsOperatorAttention`), and rejection of network/commit/partial-provider mismatches. They don't call AWS or AWS Batch and don't certify a real deployment: live regional IAM and service behaviour and browser serving need real checks.

References: [restricting a Lambda function URL origin to CloudFront](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html), [fileset build-time semantics](https://developer.hashicorp.com/terraform/language/functions/fileset), [provider resource documentation](https://registry.terraform.io/providers/hashicorp/aws/latest/docs).

### Reconciliation operator role

Reconciliation runs as `qsb-operator` ([operator session](../docs/OPERATIONAL-RUNBOOK.md#operator-session)). Terraform still declares a separately scoped reconcile role (output `operator_reconcile_role_arn`) that trusts `operator_principal_arns`, which is required with no default: set it to the exact `qsb-operator` role ARN. `NoRoleChaining` keeps that principal from assuming the role, so it stays dormant. Account-root delegation and wildcards are rejected. The role uses the configured IAM path and permissions boundary and requires MFA; don't weaken those conditions.

Its inline policy is narrower than `qsb-operator`'s: GetItem/PutItem on present `OWNER#` partitions, StartExecution on the one workflow, and, when Batch is configured, regional Batch DescribeJobs/ListJobs/DescribeJobQueues plus GetObject on the configured outputs prefix. It has no provider-secret or KMS decrypt grant.

### MARA Slipstream credential

By default the API calls MARA Slipstream without credentials. To use MARA's privileged submission (a client code) or an API key, in this order:

1. **Boundary.** The installed `qsb-runtime-boundary` must match `main`: check with `ops/github-aws/update_installed.py` in plan mode, and an administrator applies any difference. Its `MinerCredential` statement allows `secretsmanager:GetSecretValue` on `qsb/slipstream` only, and only to runtime roles named `qsb-*-api`. Until then the API can't read the secret, whatever its own grant says.
2. **Secret.** Neither scoped role can call Secrets Manager, so the key holder creates the secret as the administrator. Create `qsb/slipstream` in this stack's account and region, encrypted with the default `aws/secretsmanager` key (runtime roles have no KMS grants). Its value is a JSON object with one or both of these fields, and no others:
   - `client_code`: the client code MARA issued for privileged submission (1–256 visible ASCII characters). The API adds it to the body of transaction submissions only, as MARA specifies: `{"client_code": "…", "tx_hex": "…"}`.
   - `authorization`: an `Authorization` header value, if MARA issues one (printable ASCII). The API sends it on every Slipstream request.

   Treat both as credentials. Enter them only in the AWS console or your own terminal: never in an issue, PR, chat, tfvars file or AI tool.
3. **Wire it.** Set `slipstream_secret_arn` to the secret's full ARN in the private tfvars, then plan and apply as `qsb-operator` while no deposit or withdrawal is in flight. The plan adds `aws_iam_role_policy.miner_credential` and the API's `SLIPSTREAM_SECRET_ARN`, and nothing else. The variable refuses any other secret, account or region. `check-single-pipeline.py` refuses any other Secrets Manager grant, `NotAction`, wildcard action, module, JSON Terraform file, unreviewed data source or file input in the source, and checks the planned grant against the API's reference. It's a review aid against ordinary mistakes, not a sandbox: the boundary is what limits the secret to API roles.
4. **Check.** Straight after the apply, `GET /api/rates` through the app should still return MARA's rates. If it doesn't, back out (below). This shows the API can read and parse the secret. It can't show that MARA accepts the credential: rates is a public read, and the client code is only sent with a submission. The first deposit or withdrawal is the first live test.

**Rolling back.** API code before `d0a1732` (#78) accepts only `authorization` and refuses a secret with any other field, which stops every MARA call. Never roll the API back past that commit while the secret holds `client_code`: first change the secret back to `{"authorization": …}`, or clear `slipstream_secret_arn`.

**Who can read the key.** Only API roles can read it at runtime. But anyone who can deploy runtime code can read it through such a role: `qsb-operator`, a workflow trusted by `qsb-github-deploy`, and the administrator. Share the key on that basis.

**Behaviour once configured.** Only requests to `https://slipstream.mara.com` use the credential. The client code goes only in the body of deposit and withdrawal submissions (`POST /api/transactions`), never in reads or headers. An `authorization` value, if set, goes as a header on every request (rates, status, submissions). The app's manual-submission link stays the plain Slipstream page, since a client code in the page would reach every visitor; an operator can use MARA's own client URL by hand. The API reads the secret on each request, so rotating a value the deployed code already supports needs no deploy.
- If the secret can't be read or is malformed, requests stop with "Miner API credential is unavailable" before anything is sent. Deposits and withdrawals read it before recording their intent and reuse that value for the POST, so such a failure leaves nothing recorded and the user can simply retry.
- If MARA answers 401 or 403, the request has already been sent, and it fails with "Miner API authorization is unavailable". Treat a deposit or withdrawal submission that fails this way as uncertain, not unsent: reconcile it, and never sign or submit a different transaction in its place.

To back out, set `slipstream_secret_arn = ""` and apply; the secret itself is left alone.

### Served solver release

Build with `node terraform/scripts/build.mjs --network=mainnet --solver-release=RELEASE_ID` and set `solver_release_id` to the same enrolled schema-v3 ID; Terraform rejects a selection different from the build and verifies the CPU artifact identity. The generated `.build/manifest.json` records the image digest, solver repository commit and descriptor hash alongside the CPU `reference.zip` digest and app commit (two repositories' commits, not one source tree). Without `--solver-release`, no solver is served and new withdrawals are refused before any reservation. See [serving a release](../docs/SOLVER-REPOSITORY.md#serving-a-release).

`mainnet_enabled` and `exact_submit_enabled` are the [deploy-time switches](../docs/OPERATIONAL-RUNBOOK.md#deploy-time-mainnet-and-submit-switches). `owner_allowlist`, `owner_max_active_jobs` and `owner_max_gpu_seconds` (default: off) set the [per-owner limits](../docs/OPERATIONAL-RUNBOOK.md#per-owner-limits) on the API and coordinator; they add no IAM grant and enable nothing.
