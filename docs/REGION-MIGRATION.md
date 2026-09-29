# Moving QSB to a new account in eu-west-2

The organisation requires all QSB infrastructure and data in eu-west-2 (London), in a new AWS account that people
reach through IAM Identity Center.

The move is a new stack, never a change of `region` or account on an existing one:
- Both Terraform stacks pin their state to a region (`terraform_data.region_pin`).
- `check-single-pipeline.py --deploy` refuses a plan that doesn't find the resources in its state, or that finds
  them in another region.
- Terraform refuses any account other than `aws_account_id`.

**Built alongside, not replaced.** The new account is empty, so there are no IAM name clashes and the new stack is
built beside the live one. Downtime is only the data copy and the switch-over.
- **Until the switch-on (step 13):** the old stack stays intact but frozen, so rollback is just unfreezing it. The new
  stack stays frozen, or used read-only by the operator, and its URL isn't shared.
- **At the switch-on:** the old stack's services are retired straight away (step 14), so nothing can take a deposit
  over the same vault rows. By then new deposits live only in the new account, so there's nothing to roll back to.
- **Its data is kept:** the records table, the solver image and the buckets stay until the new stack has run a full
  deposit and withdrawal (cleanup).

**When to cut over:** only after the first mainnet withdrawal (#22) is complete, and only when nothing is in
flight. That means no held or unconfirmed deposit, no withdrawal intent that isn't confirmed, and an empty GPU queue.
Everything before the cutover can happen earlier.

**Who:** the steps below are marked by who runs them.

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

**What users see:** a new app URL, and everyone signs in again. Deposits and withdrawals are off from the freeze
(step 10) until the switch-on (step 13).

## Before the cutover

Nothing live changes in this phase.

1. **Pin the live stacks' region** (operator, old account). After this change, `region` is required and the backend
   region is no longer in `versions.tf`.
   - Add `"region": "eu-west-1"` to the old GPU tfvars. The app tfvars already has it.
   - The GPU AMI is now required too, so add `"gpu_ami": "ami-05db4db06e751ab89"`. That's the pinned Ireland AMI.
   - Re-initialise the app working copy with `-reconfigure -backend-config=bucket=<current state bucket>
     -backend-config=region=eu-west-1`. Until then its plan stops with "Backend initialization required". The GPU
     stack's backend block didn't change, so its working copy needs no re-init.
   - Then plan and apply both stacks once. Expect the new `terraform_data.region_pin`, the `SourceCommit` tag
     updates, and a replaced release record (`terraform_data.release` in the app, `terraform_data.release_identity`
     in the GPU stack), as with any new commit. Nothing else should be replaced or destroyed.
2. **Identity Center and account basics** (AWS admin, new account).
   - Create a permission set for the QSB operator (for example `QsbOperator`). Assign it to the QSB owner in the new
     account. It gets its inline policy in step 4. Keep its session duration at one hour; `qsb-operator` sessions
     are an hour at most anyway.
   - Keep the access portal's session short too (for example one hour). It limits how long a stolen CLI sign-in
     token stays usable.
   - **MFA.** The two access roles no longer check MFA themselves, because Identity Center enforces it for the
     whole instance, not per permission set. Confirm that Identity Center prompts for MFA at every sign-in
     ("always-on") and requires users to register an MFA device.
   - Create the GitHub OIDC provider (`token.actions.githubusercontent.com`), which the deploy role trusts.
   - **GPU capacity.** Check that `g5.xlarge` is offered in the subnets you'll use:
     `aws ec2 describe-instance-type-offerings --region eu-west-2 --location-type availability-zone --filters Name=instance-type,Values=g5.xlarge`.
     Then request the Service Quotas "Running On-Demand G and VT instances" quota, at least the compute
     environment's 4 vCPUs.
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
     - If the app's `alarm_actions` is used, create its SNS topic in the new account.
3. **Private inventory** (AWS admin). Write it for the new account with:
   - `account` (the new one), `region` `eu-west-2`, `subject` (the same GitHub main-branch subject) and a new
     `state_bucket` name;
   - `operator_sso_permission_set` (for example `QsbOperator`) instead of `operator_user`;
   - `gpu_vpc`;
   - empty `distributions`, `apis`, `origin_access_controls` and `response_headers_policies`. None exist yet. The
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
   - Add the new CloudFront distribution, API, origin access control and response-headers IDs to the inventory.
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
   - Run a bounded GPU preflight (driver visible, image pulled by digest), as for the eu-west-1 image preflight.
   - Signing in is fine. It writes only a challenge and a session, which the copy in step 11 ignores.

## Cutover

10. **Freeze** (operator, old account).
    - Confirm the GPU queue is empty, no withdrawal or deposit is in flight, and the withdrawal state machine has no
      running executions (`aws stepfunctions list-executions --state-machine-arn <arn> --status-filter RUNNING`
      lists none).
    - Freeze the old app: set `mainnet_enabled` and `exact_submit_enabled` to false **and `lambda_concurrency` to 0**,
      then plan, check and apply. The switches alone don't stop writes: creating a vault and the status reads still
      write to the table. With no concurrency, every function is throttled, so nothing reads or writes the old
      table.
    - Concurrency 0 stops new invocations but not ones already running. So wait at least 3 minutes after the apply,
      longer than any application function's timeout (the API's 120 seconds is the longest). Then re-check that the
      state machine has no running executions and the GPU queue is empty.
    - Confirm the freeze: `curl -s -o /dev/null -w '%{http_code}' <old URL>/api/config` returns a throttling error
      (429 or 5xx), not 200. From here only DynamoDB's own TTL deletes of challenges and sessions touch the old table,
      and the copy ignores those rows.
    - Then take an on-demand backup of the old records table
      (`aws dynamodb create-backup --region eu-west-1 --table-name <name>-records --backup-name qsb-pre-move`).
11. **Copy the data** (operator, both accounts).
    - **Freeze the new stack too.** Set its `lambda_concurrency` to 0, then plan and apply. Creating a vault writes
      even with the switches off, so a write to the new table during the copy could otherwise escape verification.
    - **Profiles.** One per account, with distinct names: during the move the old and new operator profiles can't
      both be called `qsb-operator`. Keep the old account's as `qsb-operator`, and name the new account's
      `qsb-new-operator` (use the profile example in `ops/github-aws/README.md`, with that name) until step 15. The
      script can't answer an MFA prompt, so give it two helper profiles that reuse credentials the CLI already has:
      - In `~/.aws/config`, add `[profile qsb-copy-from]` with
        `credential_process = aws configure export-credentials --profile qsb-operator --format process`. Run
        `aws sts get-caller-identity --profile qsb-operator` first, which prompts for MFA once and caches the session.
      - Add `[profile qsb-copy-to]` with
        `credential_process = aws configure export-credentials --profile qsb-new-operator --format process`, after
        `aws sso login`.
    - **Copy:** `npx tsx scripts/copy-records.ts --from eu-west-1:<old>-records --from-profile qsb-copy-from --to eu-west-2:<new>-records --to-profile qsb-copy-to`.
      It counts first; add `--apply` to copy.
    - It copies every item unchanged, overwrites any row an earlier interrupted copy left under the same key,
      refuses a destination row whose key isn't in the source, fails if the source changes during the copy, and
      verifies both tables item by item.
    - **Keep the new stack frozen** after the copy, and note the copy's output (item count and digest) for the
      rollback check.
    - It prints only counts and a digest. The data passes through the operator's machine, not any AI tool.
12. **Verify** (operator).
    - Unfreeze the new stack: restore its `lambda_concurrency` to its previous value, then plan and apply.
    - Don't share the new URL before step 13. Until then only the operator uses it, read-only: creating a vault
      works even with the switches off, and such a vault would exist only in the new table.
    - Sign in at the new URL. The vault, its deposit and its status must show as before. Create nothing.
13. **Switch on** (operator, with the owner's OK). Set both switches on in the new stack, plan and apply.
14. **Retire the old stack's services straight away** (operator, old account). Steps 1 and 2 of "Decommission the
    old stack" below destroy everything that could take a deposit, and keep the data. Afterwards nothing is left to
    switch back on by mistake. Deleting the kept data still waits for the cleanup.
15. **Point the tooling at the new account.** Rename the `qsb-new-operator` profile to `qsb-operator` once the old
    account's profile is no longer needed.
    - Set the GitHub repository variables `QSB_AWS_ACCOUNT_ID`, `QSB_AWS_REGION` (eu-west-2) and
      `QSB_AWS_ROLE_ARN` (the new `qsb-github-deploy`).
    - Point the local `qsb-view` and `qsb-operator` profiles at the new account's roles through Identity Center,
      with region eu-west-2.

## Rollback

- **Before step 13:** first check that the new table holds nothing the copy didn't put there. Run the copy script in
  reverse, count-only (`--from eu-west-2:<new>-records … --to eu-west-1:<old>-records …`, without `--apply`), and
  compare its item count and digest with the copy's output from step 11. If they differ, stop: something was created
  in the new stack and must be reconciled before rolling back. Then freeze the new stack again, restore the old app's
  `lambda_concurrency` and switches to their values before the freeze, and plan and apply. Its table
  hasn't changed since the freeze, and nothing in the new stack has taken a deposit.
- **After step 13:** new deposits live only in the new account, so don't roll back. Fix forward. Step 14 removes
  the old services, so the old stack can't be switched on by mistake.

## Decommission the old stack

Steps 1 and 2 run at cutover step 14. They destroy the old services but keep the data. Step 3 deletes the kept data,
after the new stack has run a full deposit and withdrawal.

1. **GPU stack** (operator, old account).
   - Run `terraform state rm terraform_data.region_pin aws_ecr_repository.solver`, plus the job bucket and its
     configuration resources (every address from `terraform state list | grep -E '^aws_s3_bucket[a-z_]*\.jobs$'`).
   - Then run `terraform destroy`.
2. **App stack** (operator, old account).
   - Run `terraform state rm terraform_data.region_pin aws_dynamodb_table.records`, plus the frontend bucket and its
     configuration resources (every address from `terraform state list | grep -E '^aws_s3_bucket[a-z_]*\.frontend$'`).
   - Then run `terraform destroy`. It removes CloudFront, the Lambdas and the roles; the old URL stops working.
3. **Cleanup** (old account's administrator). Delete these permanently, checking each against this list first:
   - the old records table (disable deletion protection first) and its on-demand backup;
   - note that deleting a table with point-in-time recovery makes DynamoDB keep a system backup of it for 35 days.
     Treat it as retained until it expires, so the old account holds QSB data until then. After 35 days, confirm it has expired: `aws dynamodb list-backups --region eu-west-1 --backup-type SYSTEM`
     should list nothing for the old table;
   - the `qsb-solver` repository;
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
