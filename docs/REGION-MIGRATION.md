# Moving QSB to a new account in eu-west-2

The organisation requires all QSB infrastructure and data in eu-west-2 (London), in a new AWS account that people
reach through IAM Identity Center.

**Status (2 October 2026):** steps 1–11 are done, and the new stack is live. The GitHub part of step 12 is done.
Left: the local-profile part of step 12, and, after the new stack has run a full deposit and withdrawal,
deleting the old stack's retained data (cleanup; never the new stack's). The old stack gets no more deploys.

**QSB started over in the new account.** The new stack was built from scratch, and no data was copied: the records
table, sessions and owner data all started empty. Users see a new app URL and sign in again; vaults created on the
old stack don't appear on the new one.

A region or account move is always a new stack, never a change of `region` or account on an existing one:
- Both Terraform stacks pin their state to a region (`terraform_data.region_pin`).
- `check-single-pipeline.py --deploy` refuses a plan that doesn't find the resources in its state, or that finds
  them in another region.
- Terraform refuses any account other than `aws_account_id`.

The steps below are how the new account was built. Follow them again for any other new account.

**Who:** the steps are marked by who runs them.

| Mark | Who |
| --- | --- |
| **AWS admin** | the organisation's AWS administrator. Runs the new account's bootstraps, sets up Identity Center, and grants the temp admin role. |
| **temp admin** | a temporary administrator role for the first app apply and the ID registration, given to the QSB owner for that day and removed afterwards |
| **operator** | `qsb-operator`. In the new account it's assumed through the Identity Center permission set; in the old account, through the existing operator user. |
| **key holder** | whoever holds MARA's client code |

Claude never runs admin steps, never handles the client code, and never reads table contents.

**Why admin stays someone else.** The boundaries and alerts only hold while the operator can't edit them, and that
holds only while the administrator is a different person.
- A stolen admin session could mint IAM keys, read the MARA credential or swap the frontend.
- A stolen `qsb-operator` session lasts at most an hour and can't touch IAM.

## Build the new stack

Nothing live changes in this phase.

1. **Check the old stack has nothing to carry over** (operator, with the owner). The new stack won't know about
   anything on the old one.
   - No vault on the old stack holds funds. If one does, withdraw it there first.
   - No deposit is held or unconfirmed, and no withdrawal intent is unconfirmed.
   - The GPU queue is empty, and the withdrawal state machine has no running executions
     (`aws stepfunctions list-executions --state-machine-arn <arn> --status-filter RUNNING` lists none).
   - Repeat these checks just before the switch-on (step 10).
2. **Identity Center and account basics** (AWS admin, new account).
   - Create a permission set for the QSB operator (for example `QsbOperator`). Assign it to the QSB owner in the new
     account. It gets its inline policy in step 4. Keep its session duration at one hour; `qsb-operator` sessions
     are an hour at most anyway.
   - Keep the access portal's session short too (for example one hour). It limits how long a stolen CLI sign-in
     token stays usable.
   - **MFA.** The two access roles no longer check MFA themselves, because Identity Center enforces it for the
     whole instance, not per permission set. Confirm that Identity Center prompts for MFA at every sign-in
     ("always-on") and requires users to register an MFA device.
   - Create the GitHub OIDC provider (`token.actions.githubusercontent.com`), which the deploy role trusts. This must
     exist before `bootstrap.py` runs in step 4.
   - **GPU capacity.** Check that `g5.xlarge` is offered in the subnets you'll use:
     `aws ec2 describe-instance-type-offerings --region eu-west-2 --location-type availability-zone --filters Name=instance-type,Values=g5.xlarge`.
     Then request the Service Quotas "Running On-Demand G and VT instances" quota, at least the compute
     environment's maximum vCPUs. That's 64 today: `workersMax` 16 in `server/gpu-spend.json`, times 4 vCPUs per
     `g5.xlarge`. A lower quota caps how many GPUs a withdrawal can use.
   - **GPU AMI.** Find the Ireland AMI's name with `aws ec2 describe-images --region eu-west-1 --image-ids ami-05db4db06e751ab89 --query 'Images[0].Name'`.
     Then find the image with the same name in eu-west-2:
     `aws ec2 describe-images --region eu-west-2 --owners amazon --filters Name=name,Values=<that name> --query 'Images[0].ImageId'`.
     The same name means the same NVIDIA driver build. The operator's roles can't do these lookups or the quota
     request: they're limited to their own account and region.
   - **Network.** Choose the VPC and subnets for the GPU stack.
   - **New-account limits.**
     - Lambda reserved concurrency: the app reserves 2 for each of its 3 functions, and a new account's quota may be
       lower.
     - CloudFront: new accounts sometimes need AWS to verify them before they can create a distribution.
     - Alert routing: the AWS admin sets up where the app's alarms go (the SNS topic for `alarm_actions`) and runs a
       delivery test.
3. **Private inventory** (AWS admin). Write it for the new account with:
   - `account` (the new one), `region` `eu-west-2`, `subject` (the same GitHub main-branch subject) and a new
     `state_bucket` name;
   - `operator_sso_permission_set` (for example `QsbOperator`) instead of `operator_user`;
   - `gpu_vpc`;
   - empty `distributions`, `origin_access_controls` and `response_headers_policies`. None exist yet. The
     deploy policy names an `UNREGISTERED` placeholder until the real IDs are registered in step 7, so the policies
     keep the same shape.
4. **Bootstrap** (AWS admin). Run `ops/github-aws/bootstrap.py`, then `ops/github-aws/bootstrap_access.py`: plan
   first, then `--apply`.
   - They create the deploy role, the runtime and GPU boundaries, the state bucket in eu-west-2, `qsb-viewonly` and
     `qsb-operator`.
   - The two access roles trust only the permission set's role. There's no IAM user.
   - Render `permission-set.json` with `python3 ops/github-aws/access.py INVENTORY OUTPUT_DIR` and attach it to the
     permission set as its inline policy. It allows assuming those two roles and nothing else.
   - Then check with `verify_access.py --profile qsb-view --inventory INVENTORY --live`. It simulates the
     installed roles, and the role Identity Center provisions in this account for the permission set, so it tests
     the permission set's installed policy, not the rendered file. It fails until the permission set is assigned to
     the account.
   - **Profiles.** While the old stack is still up, give the new account's operator profile its own name, for
     example `qsb-new-operator` (use the profile example in `ops/github-aws/README.md`, with that name), so it
     can't be mistaken for the old account's `qsb-operator`. Step 12 renames it.
5. **GPU stack** (operator, new account).
   - **Init** with the new state bucket: `-backend-config=region=eu-west-2 -backend-config=key=qsb/gpu/terraform.tfstate`.
   - **Tfvars:** the new `aws_account_id`, `region = "eu-west-2"`, the `gpu_ami` from step 2, `vpc_id`, `subnets`, the GPU
     boundary ARN, and the image `<new account>.dkr.ecr.eu-west-2.amazonaws.com/qsb-solver@sha256:<the enrolled digest>`.
   - Then plan and apply.
   - **Solver image.** Copy it into the new repository by digest, from
     `ghcr.io/starknet-innovation/qsb-solver@sha256:<digest>`, or pull it from the old account's repository with the
     old account's credentials. Then confirm that
     `aws ecr describe-images --region eu-west-2 --repository-name qsb-solver --image-ids imageDigest=sha256:<digest>`
     finds it.
   - The release identity is unchanged: it names the image by digest.
6. **App stack, first apply** (temp admin).
   - Follow "First apply in an account" in `terraform/README.md` with the new `aws_account_id`,
     `region = "eu-west-2"`, the new Batch references, `operator_principal_arns` set to the new `qsb-operator` role,
     and both mainnet switches **off**.
   - Leave `slipstream_secret_arn` empty for now.
   - `check-single-pipeline.py --deploy --first-apply` must pass.
7. **Register the edge IDs** (temp admin).
   - Add the new CloudFront distribution, both origin access controls (the frontend's and the API's) and the
     response-headers ID to the inventory.
   - Run `update_installed.py` as a plan, then with `--apply`. From then on `qsb-operator` manages the whole stack.
     The `UNREGISTERED` placeholder keeps the operator policy count the same, so this shouldn't happen. If it
     refuses anyway because the count changed, stop. The AWS admin then creates the extra `qsb-operator-<n>`
     managed policy under `/qsb/bootstrap/` with the document `access.py INVENTORY DIR` renders, attaches it to
     `qsb-operator`, and re-runs the update. `bootstrap_access.py --resume` can't do this: it refuses policies that
     differ from the render.
   - Then the AWS admin removes the temp admin role.
8. **Client code** (AWS admin, with the key holder).
   - Create `qsb/slipstream` in the new account in eu-west-2 with `{"client_code": "…"}`, as in `terraform/README.md`
     ("MARA Slipstream credential").
   - Then the operator sets its ARN as `slipstream_secret_arn`, plans and applies.
   - `GET /api/rates` through the new URL must return 200.
9. **Check** (operator).
   - `/api/config` shows mainnet, the enrolled solver and the switches off.
   - Run a bounded GPU preflight (driver visible, image pulled by digest).
   - Signing in is fine. Create nothing else: with the switches off, creating a vault still works.

## Switch-over

10. **Switch on** (operator, with the owner's OK).
    - Repeat step 1's checks on the old stack.
    - Set both switches on in the new stack, plan and apply.
11. **Retire the old stack's services** (the QSB owner, old account; done on 30 September 2026). Steps 1 and 2 of "Decommission the
    old stack" below destroy everything that could take a deposit, and keep the data. Afterwards nothing is left to
    switch back on by mistake. Deleting the kept data still waits for the cleanup.
12. **Point the tooling at the new account.** Rename the `qsb-new-operator` profile to `qsb-operator` once the old
    account's profile is no longer needed.
    - Set the GitHub repository secrets `QSB_AWS_ACCOUNT_ID`, `QSB_AWS_ROLE_ARN` (the new `qsb-github-deploy`) and
      `QSB_TERRAFORM_STATE_BUCKET`, and the variable `QSB_AWS_REGION` (eu-west-2). To deploy from GitHub, finish
      the setup in "Deploy from GitHub" in `terraform/README.md`.
    - Point the local `qsb-view` and `qsb-operator` profiles at the new account's roles through Identity Center,
      with region eu-west-2.

What stays with the AWS admin once `qsb-operator` manages the stack is in
[ops/github-aws/README.md](../ops/github-aws/README.md#what-stays-with-the-aws-administrator).

## Rollback

There is none: since the switch-on (step 10), users are sent to the new stack, so fix forward. Until step 11 the
old stack still serves its routes and could still take a deposit, which is why step 11 re-checks it and removes its
app stack first.

## Decommission the old stack

Steps 1 and 2 run at switch-over step 11. They destroy the old services but keep the data. Step 3 deletes the kept
data, after the new stack has run a full deposit and withdrawal.

The old stacks need two settings before current code can plan them:
- `region` is required, and the backend region is no longer in `versions.tf`. Add `"region": "eu-west-1"` to the old
  GPU tfvars (the app tfvars already has it). Re-initialise the app working copy with
  `-reconfigure -backend-config=bucket=<current state bucket> -backend-config=region=eu-west-1`. Until then its
  plan stops with "Backend initialization required". The GPU stack's backend block didn't change, so its working
  copy needs no re-init.
- The GPU AMI is required too, so add `"gpu_ami": "ami-05db4db06e751ab89"` to the old GPU tfvars. That's the
  pinned Ireland AMI.

Immediately before step 1, repeat the checks of "Build the new stack" step 1 on the old stack: no vault holds
funds, no deposit is held or unconfirmed, no withdrawal intent is unconfirmed, the GPU queue is empty and the
withdrawal state machine has no running executions. If any fails, stop and resolve it on the old stack first.

1. **App stack** (operator, old account). This goes first, so nothing can take a deposit or start GPU work while the
   rest is removed.
   - Run `terraform state rm aws_dynamodb_table.records`, plus the frontend bucket and its configuration resources
     (every address from `terraform state list | grep -E '^aws_s3_bucket[a-z_]*\.frontend$'`).
   - Then run `terraform destroy`. It removes CloudFront, the API, the Lambdas, the state machine and the roles; the
     old URL stops working.
2. **GPU stack** (operator, old account).
   - Run `terraform state rm aws_ecr_repository.solver`, plus the job bucket and its configuration resources
     (every address from `terraform state list | grep -E '^aws_s3_bucket[a-z_]*\.jobs$'`).
   - Then run `terraform destroy`.
3. **Cleanup** (old account's administrator). Delete these permanently, checking each against this list first:
   - the old records table (disable deletion protection first);
   - note that deleting a table with point-in-time recovery makes DynamoDB keep a system backup of it for 35 days.
     Treat it as retained until it expires, so the old account holds QSB data until then. After 35 days, confirm it has expired: `aws dynamodb list-backups --region eu-west-1 --backup-type SYSTEM`
     should list nothing for the old table;
   - the `qsb-solver` repository. It still holds the solver image, and a repository with images can't be deleted.
     First confirm the image is in the new account's repository, which is also on GHCR by digest. Then delete the
     old repository's images, confirm `aws ecr list-images --region eu-west-1 --repository-name qsb-solver` lists
     none, and delete the repository;
   - the job bucket. Empty it first: it still holds the withdrawals' job inputs and outputs until they expire after
     30 days, and a bucket with objects can't be deleted. Confirm `aws s3 ls s3://<name> --recursive` lists nothing,
     then delete it;
   - the frontend bucket. It's versioned, so empty it first: delete every object
     version and delete marker (for example with the S3 console's "Empty bucket"), confirm
     `aws s3api list-object-versions --bucket <name>` lists nothing, then delete the bucket;
   - the old `qsb/slipstream` secret;
   - the old state bucket. It's versioned too, so empty every version and delete marker the same way before
     deleting it;
   - the old IAM identities, following the organisation's process.
