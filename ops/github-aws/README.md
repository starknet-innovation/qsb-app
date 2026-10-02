# QSB AWS identities

The AWS administrator's bootstraps create everything QSB's people and workflows use in an account:
- `bootstrap.py`: the GitHub deploy role `qsb-github-deploy` under `/qsb/bootstrap/`, the runtime boundary
  `qsb-runtime-boundary`, and an encrypted, versioned, private Terraform state bucket;
- `bootstrap_access.py`: the human access roles `qsb-viewonly` and `qsb-operator`, the GPU boundary
  `qsb-gpu-boundary`, and an IAM Access Analyzer external-access analyzer.

They create no access keys and don't start the application. The whole sequence for a new account is in
[REGION-MIGRATION.md](../../docs/REGION-MIGRATION.md).

## Deploy role

`qsb-github-deploy` trusts only the repository's exact OIDC `sub` for `main` and the `sts.amazonaws.com` audience,
through the account's GitHub OIDC provider, which the administrator creates before `bootstrap.py` runs. Read the
actual subject prefix with `gh api repos/OWNER/REPO/actions/oidc/customization/sub`; newer repositories include
immutable owner/repository IDs. Don't replace it with a guessed name or wildcard. Environment-bound jobs have
different subjects and are not trusted.

The deploy role has Terraform control of QSB-named Lambda, DynamoDB, Step Functions, alarms, logs and frontend
buckets in the configured account and region. The runtime role path is `/qsb/runtime/qsb-*`; creating or changing
runtime policies requires the fixed administrator-owned boundary. It can't modify its own identity, the boundary,
other projects' roles, or create static credentials. Runtime roles can't manage IAM.

CloudFront distributions, origin access controls and response-header policies are restricted to explicitly
registered QSB IDs. These identifiers don't encode project ownership, and some CloudFront resources can't be
protected with tags. **New CDN resources must first be allocated and registered by an administrator.** The role
can fully manage registered infrastructure, but can't create arbitrary new CDN/API resources or EC2/VPC/backup
infrastructure. Roles can be passed only to Lambda, Step Functions and EventBridge Scheduler, which runs the webhook
dispatcher's schedule; the role can manage only `qsb-*` schedules in the default group.

The runtime boundary allows QSB data access and, for the API roles in `api_functions` only, read-only access to one
secret, `qsb/slipstream`: the optional MARA Slipstream credential (see `terraform/README.md`). Only calls from that
same function's execution environment get it (`lambda:SourceFunctionArn`, which Lambda sets on those calls and a few
it makes for the function, such as its logs, never on a session taken elsewhere). So neither a session of an API
role taken anywhere else, such as by another account a changed trust names, nor a role and function a deploy adds
can read it. It allows no other secret and no KMS decrypt. Deploying code confers that code's runtime access, so `qsb-operator` and `qsb-github-deploy` can
reach this secret through an API role. Workflow log-delivery control APIs and regional metadata discovery require
regional wildcard resources; these are the runtime control-plane exceptions. In S3, the boundary allows only the GPU
job bucket's prefixes (`s3:PutObject` on `inputs/*`, `s3:GetObject` on `outputs/*`), which Terraform grants to the
coordinator; runtime identities have no other S3 grant, and no SQS or ECR grant. The GPU roles have their own
boundary ([below](#gpu-roles-and-spend)). KMS customer keys would need separately reviewed grants. This is a project deployment role, not a
read-only role.

The state bucket uses S3-managed encryption, versioning, public access blocking and an HTTPS-only policy. The deploy
role and `qsb-operator` can read and write objects only under `qsb/`, and delete only `.tflock` lock objects. They
can't administer the bucket or delete state snapshots.

## Provision and verify

`render.py` takes a private inventory containing `account`, `region`, `subject`, `state_bucket` and arrays
`distributions`, `origin_access_controls` (the frontend's and the API's), `response_headers_policies`, and
`api_functions` (the API functions' names, `<name>-api` such as `qsb-app-api`; required, since they're known before any
apply). `access.py` also reads
`gpu_vpc` (the VPC of the `terraform/gpu` security group) and exactly one of `operator_sso_permission_set` or
`operator_user` ([Human access without root](#human-access-without-root)). Keep that inventory, policy renders,
state and receipts outside Git.

1. Render with `python3 ops/github-aws/render.py INVENTORY OUTPUT_DIRECTORY`.
2. Validate both identity policies with IAM Access Analyzer and run
   `python3 ops/github-aws/verify.py --profile ADMIN --inventory INVENTORY`.
3. Commit and push; verify the checkout is clean and its remote branch matches.
4. Run `python3 ops/github-aws/bootstrap.py --profile ADMIN --inventory INVENTORY --apply`. It refuses to overwrite
   an existing role, boundary, or state bucket. If an AWS operation fails midway, inspect and reconcile the partial
   resources; don't delete persisted state to retry.
5. Repeat `verify.py` with `--role-arn ROLE_ARN` and compare the live trust and policies with the committed renderer.
   The simulator checks permissions; only a GitHub job can prove the OIDC exchange end to end.
6. For the human access identities, check offline with `python3 ops/github-aws/test_access.py` and
   `verify_access.py --profile ADMIN --inventory INVENTORY`, commit and push, then run
   `python3 ops/github-aws/bootstrap_access.py --profile ADMIN --inventory INVENTORY`. It prints the plan (names and
   policy sizes only); add `--apply` to create it. It refuses to touch an existing identity and never creates a
   password, key or MFA device. If a call fails midway, don't delete anything or retry blind: rerun with
   `--apply --resume`. It first checks that every identity that already exists matches what this commit renders
   (path, policy documents, trust, session length, and no access keys, groups or extra policies; for each existing
   policy, exactly one version and no attachment or boundary use outside its own role or the GPU roles), then creates
   or attaches only what's missing, and anything that differs stops it.
7. Check the installed roles with `verify_access.py --profile qsb-view --inventory INVENTORY --live`.

## GitHub usage

Repository secrets. They're secrets because GitHub prints each step's inputs and environment in the public log, and
masks only secrets:

- `QSB_AWS_ROLE_ARN` (the `qsb-github-deploy` role), `QSB_AWS_ACCOUNT_ID`, `QSB_TERRAFORM_STATE_BUCKET`

Repository variables:

- `QSB_AWS_REGION`
- `QSB_SOLVER_RELEASE_ID`: the enrolled solver release the app is built with
- `QSB_AWS_DEPLOY_ENABLED`: `deploy.yml` does nothing unless it's `true`

The private tfvars set the runtime boundary, and `check-single-pipeline.py --deploy` refuses a plan with any other.

`aws-auth.yml` is a manual authentication-only check, runnable on `main`. It can't deploy or resume the app. Like
`deploy.yml`, it gets the role's credentials through `terraform/scripts/github_deploy.py credential-process`, which
neither stores nor prints them, and prints only whether the session is the deploy role's.

`deploy.yml` is the reviewed Terraform workflow for the app stack: it plans each push to `main`, and applies that
plan once a reviewer approves the `qsb-deploy` environment. See "Deploy from GitHub" in
[`terraform/README.md`](../../terraform/README.md#deploy-from-github). The approval and `QSB_AWS_DEPLOY_ENABLED` are
conventions the workflow checks, not IAM enforcement: they don't restrict direct AWS API calls made by another
workflow on `main`.

See [GitHub's AWS OIDC guidance](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

## Local regression checks

Run `python3 -m unittest discover -s ops/github-aws -p "test_*.py"` to check that removed services stay absent while
exact OIDC trust, state protection, registered edge/API resources and required pipeline grants remain. These are
structural policy checks, not a live AWS authorization test. `verify.py` also includes explicit denied-service and
PassRole cases for an IAM simulation. Changing the renderer doesn't update installed roles or boundaries: see
[Keep installed IAM in line with `main`](#keep-installed-iam-in-line-with-main).

## Human access without root

Day-to-day AWS work (checks, Terraform applies, GPU smoke runs, reconciliation) never uses the account root.
`access.py` renders two roles for people:

| Identity | Path | Can | Cannot |
| --- | --- | --- | --- |
| `qsb-viewonly` | `/qsb/bootstrap/` | AWS `ViewOnlyAccess`, plus Batch/Scheduler/IAM describe, IAM simulation and Cost Explorer reads | read data: S3 objects, DynamoDB items, secrets, parameters, KMS decrypt, log events, Lambda code, execution input/output |
| `qsb-operator` | `/qsb/bootstrap/` | everything `qsb-github-deploy` can, plus the `terraform/gpu` stack and its smoke jobs | ingress rules, `RunInstances`, VPC/gateway creation, users, access keys or MFA devices, editing any `/qsb/bootstrap/` identity or policy, removing a boundary |

Neither role can assume other roles, so editing a runtime role's trust doesn't let the operator become that role.
Both roles' sessions last at most 1 hour.

**Through IAM Identity Center** (the current account): the inventory sets `operator_sso_permission_set`, the
permission set's name. There is no IAM user.
- `qsb-viewonly` and `qsb-operator` trust only that permission set's role (an `ArnLike` match on the reserved
  `/aws-reserved/sso.amazonaws.com/` path, which no one can create roles in).
- Identity Center enforces MFA at sign-in; the administrator keeps it "always-on".
- `access.py INVENTORY DIR` writes `permission-set.json`. The administrator attaches it to the permission set as its
  inline policy: it allows assuming those two roles and nothing else.

The local profiles chain from the permission set's session:

```ini
[profile qsb-sso]
sso_session = qsb
sso_account_id = ACCOUNT_ID
sso_role_name = QsbOperator
region = eu-west-2

[profile qsb-operator]
source_profile = qsb-sso
role_arn = arn:aws:iam::ACCOUNT_ID:role/qsb/bootstrap/qsb-operator
region = eu-west-2

[profile qsb-view]
source_profile = qsb-sso
role_arn = arn:aws:iam::ACCOUNT_ID:role/qsb/bootstrap/qsb-viewonly
region = eu-west-2

[sso-session qsb]
sso_start_url = https://YOUR-PORTAL.awsapps.com/start
# The region hosting the organisation's Identity Center instance, which may not be eu-west-2.
sso_region = YOUR-IDENTITY-CENTER-REGION
```

Sign in with `aws sso login --sso-session qsb`. Agents such as Claude or Codex use a cached session that you started;
they never see or type an MFA code.

**Terraform can't use these profiles directly.** Open the session with the CLI, then export it into the shell for
Terraform without printing it: `aws sts get-caller-identity --profile qsb-operator`, then
`eval "$(aws configure export-credentials --profile qsb-operator --format env)" && unset AWS_PROFILE`. The exported
credentials expire with the session.

**Reconciliation** runs as `qsb-operator` ([runbook](../../docs/OPERATIONAL-RUNBOOK.md#operator-session)). Terraform
still needs a value for `operator_principal_arns`: set it to the `qsb-operator` role ARN. `NoRoleChaining` keeps that
principal from assuming the scoped runtime reconcile role, so that role stays dormant. This doesn't prevent the
operator from granting an outside principal access through runtime trust or bucket policies (see below).

### With an IAM user instead

`access.py` also supports an account without Identity Center: set `operator_user` (the IAM user name) instead of
`operator_sso_permission_set`, and it renders a `/qsb/operators/` user that can sign in (console or `aws login`),
change its password and assume the two roles, and nothing else, even an action a resource policy grants it. Both
roles then trust only that user, only with MFA (`aws:MultiFactorAuthPresent`) under an hour old
(`aws:MultiFactorAuthAge`). After `bootstrap_access.py`, the administrator enables console access and assigns a
TOTP MFA device (the CLI `mfa_serial` flow needs a six-digit code); the user has no MFA self-service. The role
profiles then use `source_profile = qsb-user` with `mfa_serial` and `duration_seconds = 3600`. AWS counts a role
session assumed from an `aws login` session as role chaining, which caps it at 1 hour. Whether `aws login`'s
refreshed credentials keep an MFA age that still satisfies the trust is unverified: check it against current AWS
documentation before relying on this mode.

### GPU roles and spend

GPU runtime roles (`/qsb/runtime/qsb-gpu-*`) can be created or changed only with `qsb-gpu-boundary`. It allows the
ECS instance agent, pulling the `qsb-solver` image, the GPU log streams, reading job inputs, writing job outputs,
and the watchdog's list/describe/terminate of `qsb-gpu`-tagged jobs. It doesn't allow submitting paid jobs, passing
roles, reading secrets or broad S3 access. `terraform/gpu` sets `permissions_boundary` on its four roles to that
policy, and the operator is denied creating or changing a `qsb-gpu-*` role with any other boundary.

**GPU spend under `qsb-operator`.** The app's GPU-time budget only covers jobs the coordinator submits. The operator
can submit smoke jobs to the `qsb-gpu` queue directly. It can also change the compute environment: raise max vCPUs,
switch the AMI or launch template version, attach an existing security group, or disable the watchdog rule. It can
also rebuild the compute environment with other instance families or Spot capacity, so the effective caps are the
account's EC2 vCPU quotas for every family (Standard, G and VT, P, and Spot), not just the G quota. Keep those quotas
as low as the account needs, and set an AWS Budgets alert on the account.

### Persistent external access

The operator, and the deploy role too, may create or update a function URL only with `AWS_IAM` auth: the API's, which
CloudFront signs for through origin access control. The operator is explicitly denied DynamoDB resource policy writes
and ECR repository policy writes. Lambda AddPermission is limited to CloudFront and EventBridge principals. That principal
restriction doesn't validate the permission's `SourceArn` or `SourceAccount`; keep source restrictions bound to the
reviewed account and resources in Terraform. For the API's two CloudFront permissions, `check-single-pipeline.py`
refuses a plan whose `source_arn` isn't this stack's distribution. An operator can still grant persistent outside access via:

- a Lambda permission for either allowed service principal whose `SourceArn` or `SourceAccount` names another
  account, or whose source restrictions are missing;
- runtime role trust changes, S3 bucket policies (including frontend content access), or cross-account log
  subscriptions. IAM has no condition key for a trust policy's principals, so nothing here can deny a trust that
  names another account. `check-single-pipeline.py --deploy` refuses a plan in which the Lambda or workflow roles
  trust anything but their AWS service, which covers deploys but not a direct API call. A role trusted from outside
  can still do what the boundary allows, except read `qsb/slipstream` (above). Revoking a deployer therefore means
  auditing every `qsb-*` runtime role's trust, and the `qsb-*` functions and schedules a deploy may have added.

A CloudFront distribution in another account, granted the API's function URL by such a permission,
and [EventBridge cross-account service targets](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-service-cross-account.html)
can provide an outside invocation path through those allowed service principals. MFA on the original operator
session doesn't make downstream grants expire. Don't assume Access Analyzer reports every service-principal
permission; review the actual source restrictions and test alert delivery independently.

`bootstrap_access.py` creates the external-access analyzer `qsb-external-access` if the region has no account
analyzer. Before creating any human-access IAM policies or roles, it requires an existing `ACTIVE` analyzer or
confirms the new analyzer becomes `ACTIVE`. Failed, disabled or unknown states stop the bootstrap, and so does a new
analyzer still creating after 20 polls (three-second intervals); inspect it and rerun after it becomes active.
Existing inactive analyzers are never replaced automatically. The operator is denied every Access Analyzer action,
and `qsb-viewonly` can list findings.

The administrator routes the analyzer's findings to an independently controlled alert destination, and alerts on
CloudTrail CreateRole, UpdateAssumeRolePolicy, PutBucketPolicy, PutSubscriptionFilter and Lambda AddPermission calls
by `qsb-operator`. Review each Lambda service-principal permission's SourceArn/SourceAccount for missing or
outside-account bindings. Keep alert rules outside `qsb-gpu-*`, and their roles, policies and destinations outside
all QSB deploy resource patterns, so the operator can't disable them. The bootstrap creates only the analyzer, not
alert or monitoring resources. Findings need human review, not automatic deletion of access.

References: [Lambda permission conditions](https://docs.aws.amazon.com/lambda/latest/dg/access-control-resource-based.html),
[Sign-In console actions](https://docs.aws.amazon.com/signin/latest/userguide/console-access-control.html),
and [AssumeRole MFA token](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html).

## Keep installed IAM in line with `main`

`bootstrap.py` and `bootstrap_access.py` create identities once and never update them, so a reviewed change to
`render.py` or `access.py` doesn't reach AWS by itself. `update_installed.py` compares every installed
administrator-managed QSB document with what the current clean, pushed commit renders:

- from `render.py`: `qsb-github-deploy`'s inline policy and its GitHub OIDC trust, and `qsb-runtime-boundary`;
- from `access.py`: `qsb-gpu-boundary`, the `qsb-viewonly-N` and `qsb-operator-N` policies, the operator user's
  inline policy (IAM-user mode), and both roles' trust and maximum session. With Identity Center it also compares the
  permission set's provisioned policy with the rendered `permission-set.json`, and refuses to run if they differ,
  because it can't change Identity Center.

```sh
python3 ops/github-aws/update_installed.py --profile qsb-view --inventory INVENTORY
python3 ops/github-aws/update_installed.py --profile ADMIN --inventory INVENTORY --apply
```

**Plan mode** can run as `qsb-viewonly` on any pushed branch. For each target it prints `identical`, `missing` or
`differs`. For a changed statement it also shows the exact actions, resources, principals and conditions that
differ, with account numbers masked. The inventory feeds these documents as much as the code does, so compare that
detail with the reviewed diff: a principal or resource you don't recognise means the inventory, not the code,
changed it. Masking covers account numbers only: the plan still shows VPC and CloudFront IDs, the state bucket
and the operator user's name. Keep plan output out of this public repository.

**`--apply`** runs only from a clean `main` that matches `origin`, with an administrator profile. It shows the plan,
then asks you to type `apply`.

Every plan-mode run prints a `plan_hash`, a digest of the commit and everything it read and would write. `--apply`
runs don't print it, so a hash always comes from a plan someone could review. To apply without the prompt, for
example when an agent runs it with your OK, pass `--yes --plan-hash HASH` using the hash from a plan-mode run you
reviewed. If anything differs from that run, it refuses, including a target that plan mode couldn't read. A plan
reviewed as `qsb-viewonly` therefore authorises only what that plan actually showed.

The updater never changes who a role trusts. A trust update that would move a principal, or the GitHub OIDC
`sub`/`aud`, is refused, because those values come from the inventory and need a separately reviewed step. It
updates only what differs:
- a new default version for managed policies;
- `put-*-policy` for inline ones;
- `update-assume-role-policy` or `update-role` for the roles.

It reads back every change. It never creates or deletes an identity, never attaches or detaches a policy, and never
deletes a policy version. It refuses before any write in any of these cases:
- a changed managed policy already has IAM's maximum of five versions;
- the number of rendered access policies changed;
- anything is missing, including all of a role's access policies;
- any of the three roles carries a policy this commit doesn't render.

Afterwards, run `verify.py --role-arn` and `verify_access.py --live`. Old policy versions stay stored but inactive;
an administrator can delete them once verification passes.

## What stays with the AWS administrator

These stay with the AWS administrator, even though `qsb-operator` manages the stacks:
- **IAM changes.** When a change to `render.py` or `access.py` lands on `main`, the administrator runs
  `update_installed.py`, checks its plan against the merged diff, then runs it with `--apply`. When the rendered
  `permission-set.json` changes, the administrator first attaches it in Identity Center and re-provisions the
  permission set, then runs the update.
- **A temporary admin role for the day,** as for an account's first apply, to:
  - create or replace a registered resource (the CloudFront distribution, an origin access control or the
    response-headers policy) and register the new ID.
- **Alerts.** Alarm routing (the SNS topics in `alarm_actions`), the analyzer and CloudTrail alerts above, and their
  delivery tests.
- **Secrets.** Creating or changing `qsb/slipstream` with the key holder
  ([MARA Slipstream credential](../../terraform/README.md#mara-slipstream-credential)).

The boundaries and alerts only hold while the operator can't edit them, and that holds only while the administrator
is a different person.
