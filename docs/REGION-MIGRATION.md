# Moving QSB to a new account in eu-west-2

The organisation requires all QSB infrastructure and data in eu-west-2 (London), in a new AWS account that people
reach through IAM Identity Center.

The move is a new stack, never a change of `region` or account on an existing one:
- Both Terraform stacks pin their state to a region (`terraform_data.region_pin`).
- `check-single-pipeline.py --deploy` refuses a plan that doesn't find the resources in its state, or that finds
  them in another region.
- Terraform refuses any account other than `aws_account_id`.

**Built alongside, not replaced.** The new account is empty, so there are no IAM name clashes and the new stack is
built beside the live one. Downtime is only the data copy and the switch-over. The old stack stays intact, with its
switches off, until the new one has run a deposit and a withdrawal. Rollback is switching the old one back on.

**When to cut over:** only when nothing is in flight. That means no held or unconfirmed deposit, no withdrawal
intent that isn't confirmed, and an empty GPU queue. Everything before the cutover can happen earlier.

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
   - Re-initialise both working copies with `-reconfigure -backend-config=bucket=<current state bucket>
     -backend-config=region=eu-west-1`. The GPU stack also needs `-backend-config=key=qsb/gpu/terraform.tfstate`.
   - Then plan and apply both stacks once. The only change should be the new `terraform_data.region_pin`.
2. **Identity Center and account basics** (AWS admin, new account).
   - Create a permission set for the QSB operator (for example `QsbOperator`) and require MFA for its sign-in.
     Assign it to the QSB owner in the new account. It gets its inline policy in step 4.
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
3. **Private inventory** (AWS admin). Write it for the new account with:
   - `account` (the new one), `region` `eu-west-2`, `subject` (the same GitHub main-branch subject) and a new
     `state_bucket` name;
   - `operator_sso_permission_set` (for example `QsbOperator`) instead of `operator_user`;
   - `gpu_vpc`;
   - empty `distributions`, `apis`, `origin_access_controls` and `response_headers_policies`. None exist yet, and
     the deploy policy leaves those statements out until they're registered in step 7.
4. **Bootstrap** (AWS admin). Run `ops/github-aws/bootstrap.py`, then `ops/github-aws/bootstrap_access.py`: plan
   first, then `--apply`.
   - They create the deploy role, the runtime and GPU boundaries, the state bucket in eu-west-2, `qsb-viewonly` and
     `qsb-operator`.
   - The two access roles trust only the permission set's role. There's no IAM user.
   - Render `permission-set.json` with `python3 ops/github-aws/access.py INVENTORY OUTPUT_DIR` and attach it to the
     permission set as its inline policy. It allows assuming those two roles and nothing else.
   - Then check with `verify_access.py --profile qsb-view --inventory INVENTORY --live`.
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
   - Then the AWS admin removes the temp admin role.
8. **Client code** (AWS admin or temp admin, with the key holder).
   - Create `qsb/slipstream` in the new account in eu-west-2 with `{"client_code": "…"}`, as in `terraform/README.md`
     ("MARA Slipstream credential").
   - Then the operator sets its ARN as `slipstream_secret_arn`, plans and applies.
   - `GET /api/rates` through the new URL must return 200.
9. **Check without writing** (operator).
   - `/api/config` shows mainnet, the enrolled solver and the switches off.
   - Run a bounded GPU preflight (driver visible, image pulled by digest), as for the eu-west-1 image preflight.
   - **Don't sign in to the new stack yet.** A sign-in writes a session row, and the copy in step 11 refuses a
     destination holding rows the source lacks.

## Cutover

10. **Freeze** (operator, old account).
    - Confirm the GPU queue is empty and no withdrawal or deposit is in flight.
    - Switch the old app's mainnet switches off: set `mainnet_enabled` and `exact_submit_enabled` to false, then
      plan, check and apply.
    - From here, nothing writes to the old table except sign-ins.
    - Then take an on-demand backup of the old records table
      (`aws dynamodb create-backup --region eu-west-1 --table-name <name>-records --backup-name qsb-pre-move`).
11. **Copy the data** (operator, both accounts). Use one profile per account:
    `npx tsx scripts/copy-records.ts --from eu-west-1:<old>-records --from-profile <old operator profile> --to eu-west-2:<new>-records --to-profile <new operator profile>`.
    - It counts first. Add `--apply` to copy.
    - It copies every item unchanged, refuses a destination holding anything the source lacks, fails if the source
      changes during the copy, and verifies both tables item by item. It resumes safely.
    - It prints only counts and a digest. The data passes through the operator's machine, not any AI tool.
12. **Verify** (operator). Sign in at the new URL. The vault, its deposit and its status must show as before.
13. **Switch on** (operator, with the owner's OK). Set both switches on in the new stack, plan and apply.
14. **Point the tooling at the new account.**
    - Set the GitHub repository variables `QSB_AWS_ACCOUNT_ID`, `QSB_AWS_REGION` (eu-west-2) and
      `QSB_AWS_ROLE_ARN` (the new `qsb-github-deploy`).
    - Point the local `qsb-view` and `qsb-operator` profiles at the new account's roles through Identity Center,
      with region eu-west-2.

## Rollback

- **Before step 13:** switch the old app back on. Its table hasn't changed since the freeze, and nothing in the new
  stack has taken a deposit.
- **After step 13:** new deposits live only in the new account, so don't roll back. Fix forward.

## Decommission the old stack

Do this after the new stack has run a full deposit and withdrawal.

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
   - the `qsb-solver` repository;
   - the job and frontend buckets;
   - the old `qsb/slipstream` secret;
   - the old state bucket;
   - the old IAM identities, following the organisation's process.
