# QSB GitHub deployment identity

The administrator bootstrap creates `qsb-github-deploy` under `/qsb/bootstrap/`,
`qsb-runtime-boundary`, and an encrypted, versioned, private Terraform state
bucket. It creates no IAM users or access keys and does not start the application.
The existing GitHub OIDC provider is reused.

The role trusts only the repository's exact OIDC `sub` for `main` and the
`sts.amazonaws.com` audience. Read the actual subject prefix with
`gh api repos/OWNER/REPO/actions/oidc/customization/sub`; newer repositories
include immutable owner/repository IDs. Do not replace it with a guessed name
or wildcard. Environment-bound jobs have different subjects and are not trusted.

## Access scope

The deployment role has Terraform control of QSB-named Lambda, DynamoDB,
Step Functions, alarms, logs and frontend buckets in the
configured account/region. The runtime role path is `/qsb/runtime/qsb-*`;
creating/changing runtime policies requires the fixed administrator-owned
boundary. It cannot modify its own identity, the boundary, other projects'
roles, or create static credentials. Runtime roles cannot manage IAM.

CloudFront distributions, origin controls, response-header policies and HTTP
APIs are restricted to explicitly registered QSB IDs. These identifiers do not
encode project ownership, and some CloudFront resources cannot be protected
with tags. **New CDN/API resources must first be allocated and registered by an
administrator.** The role can fully manage registered infrastructure, but cannot
create arbitrary new CDN/API resources or EC2/VPC/backup infrastructure. The removed supervised host, queue, watchdog and evidence stack has no
deployment or runtime grants. Roles can be passed only to Lambda and Step
Functions. The GitHub OIDC trust and authentication-only workflow are unchanged.

The runtime boundary allows QSB data access and the QSB Runpod secret. Workflow
log-delivery control APIs require regional wildcard resources; these are the
one runtime control-plane exception. Regional metadata discovery also requires
wildcard resources. Runtime identities have no S3, SQS or ECR grants. KMS customer keys require
separately reviewed grants. This is a project deployment role, not a read-only
role: deploying code also confers the runtime capabilities of that code.

## Provision and verify

`render.py` takes a private inventory containing `account`, `region`, `subject`,
`state_bucket` and arrays `distributions`, `apis`, `origin_access_controls`, and
`response_headers_policies`. Keep that inventory, policy renders, state, and
receipts outside Git. The initial permission review used IAM Policy Autopilot
against a private Terraform plan; the baseline's wildcard and unrelated
permissions were narrowed before installation.

1. Render with `python3 ops/github-aws/render.py INVENTORY OUTPUT_DIRECTORY`.
2. Validate both identity policies with IAM Access Analyzer and run
   `python3 ops/github-aws/verify.py --profile ADMIN --inventory INVENTORY`.
3. Commit and push; verify the checkout is clean and its remote branch matches.
4. Run `python3 ops/github-aws/bootstrap.py --profile ADMIN --inventory INVENTORY --apply`.
   It refuses to overwrite an existing role, boundary, or state bucket. If an
   AWS operation fails midway, inspect and reconcile the partial resources;
   do not delete persisted state to retry.
5. Repeat `verify.py` with `--role-arn ROLE_ARN` and compare the live trust and
   policies with the committed renderer. The simulator checks permissions;
   only a GitHub job can prove the OIDC exchange end to end.

The bootstrap state bucket uses S3-managed encryption, versioning, public
access blocking and an HTTPS-only policy. GitHub can read/write objects only
under `qsb/`, and delete only `.tflock` lock objects. It cannot administer the
bucket or delete state snapshots. Use Terraform's S3 backend with
`use_lockfile = true`, `encrypt = true` and a key such as
`qsb/main/terraform.tfstate`; configure the backend in a reviewed deployment
workflow before the first application apply. Do not assume the historical
CloudFormation deployments are already managed by Terraform or in this state.
A migration/import plan is required before Terraform takes ownership.

## GitHub usage

Repository variables:

- `QSB_AWS_ROLE_ARN`, `QSB_AWS_ACCOUNT_ID`, `QSB_AWS_REGION`
- `QSB_TERRAFORM_STATE_BUCKET`, `QSB_IAM_RUNTIME_BOUNDARY_ARN`
- `QSB_AWS_DEPLOY_ENABLED=false` while the application remains suspended

`aws-auth.yml` is a manual authentication-only check, runnable on `main` after
review/merge. It cannot deploy or resume the app. Add the same credential step
and `id-token: write` permission to a reviewed Terraform workflow. Pass
`iam_role_path=/qsb/runtime/` and `iam_permissions_boundary_arn` from the
repository variable. Keep application apply gated on explicit reactivation;
the deployment-enabled variable is a convention that the future workflow must
check, not an IAM enforcement mechanism. It does not restrict direct AWS API
calls made by another authorized workflow on `main`.

See [GitHub's AWS OIDC guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

## Local regression checks

Run `python3 -m unittest discover -s ops/github-aws -p "test_*.py"` to check
that the removed services stay absent while exact OIDC trust, state protection,
registered edge/API resources and required pipeline grants remain. These are
structural policy checks, not a live AWS authorization test. `verify.py` also
includes explicit denied-service and PassRole cases for a later IAM simulation.
Changing the renderer does not update already installed roles or boundaries;
review and apply that administrator-managed policy change separately.

## Human access without root

Day-to-day AWS work (checks, Terraform applies, GPU smoke runs, reconcile) must
not use the account root. `access.py` renders three administrator-owned
identities from the same private inventory, plus `operator_user` (the IAM user
name) and `gpu_vpc` (the VPC of the `terraform/gpu` security group):

| Identity | Path | Can | Cannot |
| --- | --- | --- | --- |
| IAM user `operator_user` | `/qsb/operators/` | sign in (console or `aws login`), change its password, assume the two roles | assume any other role, even one whose trust names it; any other action, even one a resource policy grants it; it has no access keys |
| `qsb-viewonly` | `/qsb/bootstrap/` | AWS `ViewOnlyAccess`, plus Batch/Scheduler/IAM describe, IAM simulation and Cost Explorer reads | read data: S3 objects, DynamoDB items, secrets, parameters, KMS decrypt, log events, Lambda code, execution input/output |
| `qsb-operator` | `/qsb/bootstrap/` | everything `qsb-github-deploy` can, plus the `terraform/gpu` stack and its smoke jobs | ingress rules, `RunInstances`, VPC/gateway creation, users, access keys or MFA devices, editing any `/qsb/bootstrap/` identity or policy, removing a boundary |

Both roles trust only that user, only with MFA (`aws:MultiFactorAuthPresent`),
and only when that MFA is under an hour old (`aws:MultiFactorAuthAge`). An older
sign-in session can't mint role sessions without a fresh code. Neither role can
assume other roles, so editing a runtime role's trust doesn't let the operator
become that role. Sessions last at most 1 hour for `qsb-operator` and 4 hours
for `qsb-viewonly`.
GPU runtime roles (`/qsb/runtime/qsb-gpu-*`) can be created or changed only with
the new `qsb-gpu-boundary`. It allows the ECS instance agent, pulling the
`qsb-solver` image, the GPU log streams, reading job inputs, writing job outputs,
and the watchdog's list/describe/terminate of `qsb-gpu`-tagged jobs. It does not
allow submitting paid jobs, passing roles, reading secrets or broad S3 access.
`terraform/gpu` must set `permissions_boundary` on its four roles to that policy.
The operator is denied creating or changing a `qsb-gpu-*` role with any other
boundary, including `qsb-runtime-boundary`.

**GPU spend under `qsb-operator`.** The app's GPU-time budget only covers jobs
the coordinator submits. The operator can submit smoke jobs to the `qsb-gpu`
queue directly. It can also change the compute environment: raise max vCPUs,
switch the AMI or launch template version, attach an existing security group,
or disable the watchdog rule. It can also rebuild the compute environment with
other instance families or Spot capacity, so the effective caps are the
account's EC2 vCPU quotas for every family (Standard, G and VT, P, and Spot),
not just the G quota. Keep those quotas as low as the account needs, and set
an AWS Budgets alert on the account.

### Create them once, as root

1. Add `operator_user` and `gpu_vpc` to the private inventory (outside Git).
2. Check offline: `python3 ops/github-aws/test_access.py`, then
   `python3 ops/github-aws/verify_access.py --profile ADMIN --inventory INVENTORY`.
3. Commit and push; the checkout must be clean and match its remote branch.
4. `python3 ops/github-aws/bootstrap_access.py --profile ADMIN --inventory INVENTORY`
   prints the plan (names and policy sizes only). Add `--apply` to create it. It
   refuses to touch an existing identity and never creates a password, key or
   MFA device. If a call fails midway, reconcile the partial identities; don't retry blind.
5. As root in the console, enable console access for the user and assign an MFA
   device. Nobody else handles the password or MFA secret.

### Use them

`aws login --profile qsb-user` signs in as the user. Then define the role
profiles in `~/.aws/config` (account number and MFA device ARN are yours to fill in):

```ini
[profile qsb-user]
region = eu-west-1

[profile qsb-view]
role_arn = arn:aws:iam::ACCOUNT:role/qsb/bootstrap/qsb-viewonly
source_profile = qsb-user
mfa_serial = arn:aws:iam::ACCOUNT:mfa/DEVICE
duration_seconds = 14400
region = eu-west-1

[profile qsb-operator]
role_arn = arn:aws:iam::ACCOUNT:role/qsb/bootstrap/qsb-operator
source_profile = qsb-user
mfa_serial = arn:aws:iam::ACCOUNT:mfa/DEVICE
duration_seconds = 3600
region = eu-west-1
```

The first call on each role profile asks for an MFA code, then the CLI caches
the role session until it expires. Agents such as Claude or Codex use a cached
session that you started. They never see or type the code. Then:

- confirm with `python3 ops/github-aws/verify_access.py --profile qsb-view --inventory INVENTORY --live`;
- run the #14 reconcile CLI as `qsb-operator`. It already covers the records, workflow and Batch calls reconcile makes. The #25 reconcile role stays unreachable from this user by design: the operator can edit runtime roles, so a runtime role must never be a way to skip fresh MFA. Terraform still needs a value for `operator_principal_arns`; set it to the `qsb-operator` role ARN, which `NoRoleChaining` keeps from assuming it, so that role stays dormant;
- keep root for break-glass only.

**Verify** before relying on these, against current AWS docs:
- whether `aws login` sessions carry MFA context. The `mfa_serial` profiles don't depend on it, and the age limit stops an older login's MFA from assuming the roles;
- Batch's `PassRole` service names for compute-environment instance roles;
- whether the Terraform AWS provider sends `default_tags` as create-time tags for security groups and launch templates.
