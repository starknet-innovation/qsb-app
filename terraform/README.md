# Terraform deployment (AWS application, Runpod GPUs)

This folder deploys the **public checkout's historical/research application stack** into a new AWS environment. GPUs remain on an existing Runpod serverless endpoint. It does not create GPU resources or reuse any existing validation environment. The optional [supervised runtime infrastructure](runtime/README.md) adds its CPU host, evidence storage/backups, dispatch transport, runtime permissions and independent cleanup watchdog; execution stays disabled.

**Scope:** working frontend/API infrastructure and historical coordinator/reference wiring, with all transaction activation disabled. The newer optimized long-running supervised runtime is not yet a self-contained public deployment; it cannot be hosted unchanged by these short-lived Lambdas. See [mainnet readiness](../docs/MAINNET-READINESS.md). Applying Terraform is not mainnet activation, wallet compatibility certification, or permission to spend funds.

## Resources

| Component | Resources |
| --- | --- |
| Web | Private versioned/encrypted S3 bucket, public-access block, CloudFront OAC, HTTPS distribution and security headers |
| API | HTTP API Gateway, throttled default stage, Node.js 22 ARM64 Lambda |
| Persistence | On-demand DynamoDB table with `pk`/`sk`, `expiresAt` TTL, point-in-time recovery and deletion protection |
| Search control | Node.js 22 coordinator, Standard Step Functions loop and continuation; no generic retry around paid work |
| CPU checks | Python 3.13 ARM64 reference Lambda; public inputs only |
| Operations | Separate service roles, resource-scoped data/compute grants, 30-day log retention and failure alarms |
| External | Existing Runpod endpoint and optional existing Secrets Manager ARN; no secret values in Terraform |

With the default `provision_runtime=false`, no VPC/NAT or CPU host is created. Opting into the supervised runtime adds its private CPU host and NAT network. No EC2 GPUs, custom DNS or certificates are needed for the default CloudFront hostname. AWS-managed public networking reaches Runpod. Custom domains, WAF/rate policy beyond API throttling and regional IAM/cutover review remain separate work. The runtime infrastructure is included; final dispatcher installation, runtime enrollment and activation remain unfinished software/release work. This is a new-environment stack: do not point it at production records or import existing infrastructure casually.

## Prerequisites

- Terraform 1.7+ (less than 2), Node.js 22+, npm, Python 3 and curl.
- An AWS account and an authenticated local AWS profile/session with deployment permissions. No access keys in `.tfvars`.
- A clean, committed and pushed checkout. The provider account allowlist prevents accidental account targeting.
- Enough regional Lambda reserved-concurrency quota for three functions (default two each).
- Existing Runpod setup only if you need provider diagnostics/isolated operator validation. Omit both compute settings for a frontend/API preview.

The historical registry location in this public snapshot is deliberately a placeholder. You must build and review a compatible worker/release binding before an operator search; supplying an arbitrary leaderboard or optimized image to this historical coordinator is unsupported. Infrastructure provisioning does not repair or activate that binding.

## Build, plan, deploy

From the repository root:

```sh
npm ci
npm run vendor
npm test
# Commit and push any source changes before proceeding.
node terraform/scripts/build.mjs --network=mainnet
export TF_VAR_source_commit="$(git rev-parse HEAD)"
cp terraform/terraform.tfvars.example terraform/terraform.tfvars
# Edit terraform.tfvars: intended account, region/name; optional existing Runpod references.
terraform -chdir=terraform init
terraform -chdir=terraform validate
terraform -chdir=terraform plan -out=deployment.tfplan
# Review the complete plan. Verify git status is clean and HEAD is pushed to origin.
terraform -chdir=terraform apply deployment.tfplan
terraform -chdir=terraform output app_url
```

`build.mjs` runs pinned upstream preparation, typecheck/frontend build, bundles both Node Lambda entrypoints (including SDK dependencies), creates deterministic Lambda ZIPs and records file SHA256s/network/commit. The build is done **before** Terraform parses `fileset`/file hashes. It does not deploy anything. The normal builder refuses a dirty tree; `--allow-dirty` permits local inspection only and records `clean:false`, which the Terraform deployment gate rejects.

Choose `--network=testnet4` and `network="testnet4"` together for a Testnet4-identity preview. Both mainnet operations and Testnet4 rehearsal remain disabled; this does not assert that the installed Xverse supports Testnet4. There is intentionally no `enable_mainnet` or rehearsal activation variable.

Artifacts must remain in `terraform/.build` through plan/apply. Terraform rejects mismatched commit/network, dirty builds, changed artifact hashes, changed frontend file membership and incomplete Runpod configuration. These checks are local consistency controls, not cryptographic provenance of a developer-controlled manifest. The operator must verify the commit is pushed before every apply. Never apply a stale saved plan after changing the checkout/configuration/artifacts.

### Runpod credentials

Optionally supply both `runpod_endpoint_id` and `runpod_secret_arn`. The existing secret must contain JSON shaped as `{"apiKey":"<privately provisioned value>"}`. Provision its value privately outside Terraform; do not send it to an assistant or commit it. Terraform neither creates a secret version nor reads its value. Only the coordinator gets the exact secret read permission. Add the exact customer-managed KMS key ARN only when needed; cross-account/key policies need separate review.

Endpoint capacity, zero minimum workers, worker image, TTL/deadlines, watchdogs, drain and deletion remain Runpod/operator responsibilities. AWS Lambda concurrency is **not** a GPU spending cap. Applying this stack does not start a workflow or change endpoint capacity. IAM-authorized direct validation invocations can use paid compute even while public transaction routes are gated: restrict operator access accordingly.

### State and configuration

The default Terraform backend is local. State/plans may contain operational metadata; keep them private and encrypted. `.gitignore` excludes state, plans, local tfvars and artifacts. For a team, configure a separately bootstrapped encrypted/locked remote state backend before applying; do not manage its bucket with the same state it stores. No backend credentials belong in source. Commit `.terraform.lock.hcl`.

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
terraform -chdir=terraform test
```

The tests use a mocked AWS provider and plan only. They check disabled activation, persistence protection, absence of API provider credentials, no generic paid-work retry, and rejection of network/commit/partial-provider mismatches. They do not call AWS or Runpod and do not certify a real deployment. Live regional IAM/service behavior, browser serving, provider compatibility and all mainnet acceptance gates still need actual validation.

References: [Lambda + HTTP API](https://developer.hashicorp.com/terraform/tutorials/aws/lambda-api-gateway), [fileset build-time semantics](https://developer.hashicorp.com/terraform/language/functions/fileset), [provider resource documentation](https://registry.terraform.io/providers/hashicorp/aws/latest/docs).
