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
