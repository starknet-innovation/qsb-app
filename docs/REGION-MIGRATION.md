# Moving QSB from eu-west-1 to eu-west-2

The organisation requires all QSB infrastructure and data in eu-west-2 (London). A region move means building a
new stack, never changing `region` on an existing one. Both Terraform stacks pin their state to a region
(`terraform_data.region_pin`), and `check-single-pipeline.py --deploy` refuses a plan that doesn't find the
resources in its state, or that finds them in another region. So an accidental region change fails instead of
building a second stack and leaving the first one running.

**When:** only once nothing is in flight. That means no held or unconfirmed deposit, no withdrawal intent that
isn't confirmed, and an empty GPU queue. The first mainnet withdrawal must be complete first.

**Who:** the steps below are marked by who runs them.

| Mark | Who |
| --- | --- |
| **admin** | the account administrator (today the account root) |
| **operator** | `qsb-operator` |
| **key holder** | whoever holds MARA's client code |

Claude never runs admin steps, never handles the client code, and never reads table contents.

**What users see:** the app gets a new CloudFront URL, and everyone signs in again. Deposits and withdrawals are
off from the freeze (step 3) until the switch-on (step 13).

## Before the downtime

These change nothing that's live.

1. **Pin both live stacks' region** (operator). After this change, `region` is required and the backend region is
   no longer in `versions.tf`.
   - Add `"region": "eu-west-1"` to the GPU tfvars. The app tfvars already has it.
   - The GPU AMI is now required too, so add `"gpu_ami": "ami-05db4db06e751ab89"` to the GPU tfvars. That's the
     pinned Ireland AMI.
   - Re-initialise both working copies with `-reconfigure -backend-config=bucket=<current state bucket>
     -backend-config=region=eu-west-1`. The GPU stack also needs `-backend-config=key=qsb/gpu/terraform.tfstate`.
   - Then plan and apply both stacks once. The only change should be the new `terraform_data.region_pin`.
2. **Prepare eu-west-2** (admin or operator):
   - **GPU capacity.** Check that `g5.xlarge` is offered in the subnets you'll use:
     `aws ec2 describe-instance-type-offerings --region eu-west-2 --location-type availability-zone --filters Name=instance-type,Values=g5.xlarge`.
     Then request the Service Quotas "Running On-Demand G and VT instances" quota in eu-west-2, at least the
     compute environment's 4 vCPUs. Quotas don't carry across regions.
   - **GPU AMI.** Find the Ireland AMI's name with `aws ec2 describe-images --region eu-west-1 --image-ids ami-05db4db06e751ab89 --query 'Images[0].Name'`.
     Then find the image with the same name in eu-west-2:
     `aws ec2 describe-images --region eu-west-2 --owners amazon --filters Name=name,Values=<that name> --query 'Images[0].ImageId'`.
     The same name means the same NVIDIA driver build. That ID is the new stack's `gpu_ami`.
   - **Network.** Pick the eu-west-2 VPC and subnets for the GPU stack (`vpc_id`, `subnets`).
   - **State bucket** (admin). Create a new versioned, encrypted, private state bucket in eu-west-2 with a TLS-only
     policy, exactly as `ops/github-aws/bootstrap.py` creates one (the create, public-access-block, versioning,
     encryption, tagging and policy calls), but with `LocationConstraint` eu-west-2.

## Downtime

3. **Freeze** (operator).
   - Confirm the GPU queue is empty and no withdrawal or deposit is in flight.
   - Switch the eu-west-1 app's mainnet switches off: set `mainnet_enabled` and `exact_submit_enabled` to false,
     then plan, check and apply.
   - From here, nothing writes to the eu-west-1 table except sign-ins.
4. **Backup** (admin). Take an on-demand backup of the eu-west-1 records table
   (`aws dynamodb create-backup --region eu-west-1 --table-name <name>-records --backup-name qsb-pre-region-move`).
   Point-in-time recovery stays on as well.
5. **Tear down the eu-west-1 GPU stack** (operator).
   - In its state, run `terraform state rm terraform_data.region_pin aws_ecr_repository.solver`, plus the job
     bucket and its configuration resources (every address from `terraform state list | grep -E '^aws_s3_bucket[a-z_]*\.jobs$'`).
     This keeps the image repository and the job bucket, with its access block and policy, until the cleanup.
   - Then run `terraform destroy`. That frees the account-wide IAM role names, which the new stack reuses.
6. **Tear down the eu-west-1 app stack** (operator).
   - Run `terraform state rm terraform_data.region_pin aws_dynamodb_table.records`, plus the frontend bucket and
     its configuration resources (every address from `terraform state list | grep -E '^aws_s3_bucket[a-z_]*\.frontend$'`).
     This keeps the records table, which is the source for step 11, and the frontend bucket. The destroy still
     removes the bucket's objects.
   - Then run `terraform destroy`. It removes CloudFront and the Lambdas, and frees the IAM role names.
   - The old app URL stops working here.
7. **IAM for eu-west-2** (admin).
   - Update the private inventory: `region` eu-west-2, the new `state_bucket`, and `gpu_vpc`. Keep the old edge IDs
     for now.
   - Run `ops/github-aws/update_installed.py`: first as a plan, then with `--apply`.
   - The deploy, operator and viewonly policies and both boundaries are then scoped to eu-west-2, including the
     `MinerCredential` read of `qsb/slipstream` there.
8. **GPU stack in eu-west-2** (operator).
   - Init with the new state bucket: `-backend-config=region=eu-west-2 -backend-config=key=qsb/gpu/terraform.tfstate`.
   - Set the tfvars: `region = "eu-west-2"`, the new `gpu_ami`, `vpc_id` and `subnets`, and the image
     `<account>.dkr.ecr.eu-west-2.amazonaws.com/qsb-solver@sha256:<the enrolled digest>`.
   - Then plan and apply.
9. **Solver image** (operator).
   - Copy the enrolled image into the new repository by digest, for example
     `crane copy <account>.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@sha256:<digest> <account>.dkr.ecr.eu-west-2.amazonaws.com/qsb-solver`.
     You can copy from `ghcr.io/starknet-innovation/qsb-solver@sha256:<digest>` instead.
   - Confirm that `aws ecr describe-images --region eu-west-2 --repository-name qsb-solver --image-ids imageDigest=sha256:<digest>`
     finds it.
   - The release identity is unchanged: it names the image by digest.
10. **App stack in eu-west-2** (admin, first apply).
    - Follow "First apply in an account" in `terraform/README.md`, with `region = "eu-west-2"`, the new Batch
      references, and both mainnet switches **off**.
    - Leave `slipstream_secret_arn` empty for now.
    - `check-single-pipeline.py --deploy --first-apply` must pass.
    - Then register the new CloudFront, API, origin access control and response-headers IDs in the private
      inventory, and apply `update_installed.py` again (admin). From then on `qsb-operator` manages the stack.
11. **Data** (admin). Copy the records into the new, empty table while nobody is signed in to the new stack.
    - Count first: `npx tsx scripts/copy-records.ts --from eu-west-1:<name>-records --to eu-west-2:<name>-records`
    - Then copy: add `--apply`.
    - It copies every item unchanged, refuses a destination holding anything the source lacks, fails if the source
      changes during the copy, and verifies both tables item by item. It prints only counts and a digest.
    - The data passes through the admin's machine, not any AI tool.
12. **Client code** (key holder, then operator).
    - Create `qsb/slipstream` in eu-west-2 with `{"client_code": "…"}`, the same way as in `terraform/README.md`
      ("MARA Slipstream credential").
    - Set its ARN as `slipstream_secret_arn`, then plan and apply.
    - `GET /api/rates` through the new URL must return 200.
13. **Verify, then switch on** (operator, with the owner's OK).
    - Check that `/api/config` shows mainnet, the enrolled solver, and the switches off.
    - Sign in at the new URL. The vault must show its deposit and status as before.
    - Run a bounded GPU preflight in eu-west-2, as for the eu-west-1 image preflight (driver visible, image pulled
      by digest).
    - Then set both switches on, plan and apply.
14. **Point the tooling at eu-west-2.**
    - Set the GitHub repository variable `QSB_AWS_REGION` to eu-west-2.
    - Set `region = eu-west-2` in the local `qsb-view` and `qsb-operator` profiles (`ops/github-aws/README.md`).

## Rollback

- **Up to step 5:** switch the eu-west-1 app back on. Nothing else changed.
- **After the teardowns (steps 5 and 6):** the eu-west-1 table, the image repository and the job bucket still
  exist, and the table hasn't changed since the freeze. Rolling back means rebuilding in eu-west-1 by the same
  procedure (steps 7–13 with eu-west-1).
- The new stack must never take new deposits while a rollback is still possible. Keep its switches off until
  step 13.

## Cleanup

Do this after the new stack has run a full deposit and withdrawal. All of it is admin work.

- Delete the eu-west-1 records table (disable deletion protection first) and its on-demand backup.
- Delete the eu-west-1 `qsb-solver` repository, the old jobs bucket, the old frontend bucket, the old
  `qsb/slipstream` secret and the old state bucket.
- Deleting these is permanent. Check each one against this list before removing it.
