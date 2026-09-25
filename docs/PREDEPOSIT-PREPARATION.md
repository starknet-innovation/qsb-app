# First mainnet withdrawal: preparation before the first deposit

Preparation for #22 only. No deployment, IAM sandbox execution, wallet funding,
GPU search or miner submission is performed by the files on this branch.
Refreshed against app main `a9c4540` on 25 September 2026: AWS migration PR #54
and solver PR #5 are merged, and solver release `aws-v0.1.0` exists. **#15 is
still open**, and main's generated registry still contains only the historical
schema-2 `qsb-solver-v0-1-0` descriptor. The new release's existence is not app
enrollment or deployment evidence. Wait for #15 before #22 execution; refresh
these observations before use. Older Runpod preflight comments are superseded by
#22's current AWS Batch scope.

## 1. Record the reviewed starting point

Refresh #22 and all dependencies from GitHub, including comments, before execution:

```sh
gh issue view 22 --repo starknet-innovation/qsb-app --comments
for issue in 10 11 12 13 14 15 16 18 19 20 25 48 49; do
  gh issue view "$issue" --repo starknet-innovation/qsb-app --json number,state,title
done
gh pr view 54 --repo starknet-innovation/qsb-app --json state,mergedAt,mergeCommit,statusCheckRollup
```

Stop while any dependency is open. Record the merged app commit, solver source
commit, release descriptor and deployed Lambda source evidence. A pushed commit
is not proof that those bytes are deployed. Preserve all archived descriptors;
a new release must be enrolled explicitly. Keep `mainnet_enabled` and
`exact_submit_enabled` false during preparation. No amount or transaction is
approved by this checklist.

## 2. Prepare and execute the disposable IAM sandbox separately

Use the **actual API role policy from the reviewed final commit** with the
sandbox-only role/table described in [APP-ROLE-SANDBOX.md](APP-ROLE-SANDBOX.md).
No broad additional identity permission may mask the policy being tested.
Record boundaries, SCPs, resource policies and effective principal identity.
The test role and table must be separate from application resources.

This command generates unique inert request files locally. It refuses an
existing output directory and cross-account role/table references. It makes no
AWS calls, provisions nothing and does not infer that an ARN is disposable:

```sh
python3 scripts/prepare-predeposit-iam.py \
  --table-arn "$QSB_SANDBOX_TABLE_ARN" \
  --test-role-arn "$QSB_SANDBOX_API_ROLE_ARN" \
  --output /private/tmp/qsb-predeposit-iam-requests
python3 -m unittest discover -s tests/predeposit -v
```

`manifest.json` records request hashes and the source policy hash, not a live IAM
attestation. `observations.template.json` starts at `NOT_RUN` with every observed
result blank and deposit authorization false. Copy it to a private observations
record and fill actual principal/policy identities, timestamps, service errors,
response/read files and their hashes only after execution. Expected row presence
is separate from observed presence; never copy expected values into observed fields. Protect operational evidence outside Git. Follow sandbox steps 2
and 3 using those files only after the sandbox execution is separately authorized:

| Order | Test-role operation / file | Required observed result |
| --- | --- | --- |
| 0 | Administrator consistent reads: `read-owner`, `read-system`, `read-outpoint` | All three rows absent before any writes |
| 1 | `transact-write-items`, `denied-transaction` | Authorization denied; owner and system still absent on administrator reads |
| 2 | `transact-write-items`, `allowed-transaction` | OWNER/OUTPOINT puts plus SYSTEM ConditionCheck succeed; owner and outpoint present, system absent |
| 3 | `put-item`, `duplicate-outpoint` | `ConditionalCheckFailedException`; original reservation unchanged |
| 4 | `delete-item`, `delete-outpoint` | Authorization denied; outpoint still present |
| 5 | Administrator `delete-item`, `remove-inert-owner-before-batch` | Only generated inert owner row removed; verify absence |
| 6 | `batch-write-item`, `denied-batch` | Authorization denied; owner/system remain absent, no partial writes |

CLI usage is `aws --profile TEST --region REGION dynamodb OPERATION
--cli-input-json file://REQUEST.json`; read/cleanup operations use the dedicated
sandbox administrator. The generator never executes these commands. Capture
actual service error codes and cancellation reasons when supplied; a nonzero exit
alone could be a network or malformed-request failure and proves no IAM property.
Policy simulation and DynamoDB Local do not replace these regional observations.
Any mismatch blocks the deposit. Remove only generated scratch rows and dedicated
sandbox resources after evidence is retained; do not alter application records.

## 3. Verify the enrolled release and AWS Batch definition

After #15 closes with reviewed enrollment merged, check the release using the
**merged app's parser and registry**, not a private descriptor that the deployed app cannot select:

- Schema 3 includes `searchContract` equal to the canonical SHA256 of
  `contracts/ranked-v2.json`; the app's actual range-vector tests pass.
- The canonical descriptor pins the approved solver repository commit and the
  immutable GHCR `@sha256:` release identity. Verify build provenance, release
  checksums and registry manifest identity. The AWS ECR mirror must preserve the
  same verified image digest; do not rewrite the canonical descriptor merely to
  embed an AWS account. A schema-2 historical release is not a replacement.
- The descriptor is present in generated browser/Lambda registry and the clean
  packaged deployment. Record its ID and canonical release hash.
- Verify the **exact active Batch definition ARN including revision**, not a name
  that can resolve to another revision. Its ECR image must bind to the canonical
  GHCR release through the same verified digest and the final reviewed mirror
  mapping. Merged #54 implements `batchImageMatches`: matching digest plus the
  configured queue's account/region and `qsb-solver` repository are required.
  Validate that behavior and the exact mirror against the final enrolled release;
  the mapping implementation does not itself enroll or authenticate a release.

Example read-only definition capture (no submission):

```sh
aws --profile "$QSB_AWS_PROFILE" --region "$QSB_AWS_REGION" \
  batch describe-job-definitions \
  --job-definitions "$QSB_BATCH_JOB_DEFINITION_ARN" \
  --query 'jobDefinitions[].{arn:jobDefinitionArn,status:status,image:containerProperties.image,retryAttempts:retryStrategy.attempts,runningTimeout:timeout.attemptDurationSeconds}'
```

Require exactly one ACTIVE definition, matching ARN and verified mirror image, one retry attempt
and the reviewed running timeout. Check the deployed coordinator's configured
queue, definition, artifact bucket, regional account and per-job GPU budget
against the reviewed deployment record, without printing unrelated environment
values. Verify queue/compute limits, watchdog enrollment and zero idle capacity
using #54's final runbook. Its bounded synthetic GPU smoke is useful transport
and sizing evidence; zero-hit output does not establish positive CPU verification
or the funded withdrawal required by #22.

## 4. Remaining execution requires explicit approval

Once prerequisites and IAM evidence are accepted:

1. Obtain and record the user's deployment activation approval for the specific
   account/region, app commit and switch values. Commit/push code first; never
   commit credentials, private tfvars or operator configuration. Deploy only the
   approved artifact. Verify both Terraform switch outputs and uncached
   `/api/config` against the approved network/values. Source metadata flags remain
   false as required by #22.
2. The user creates a fresh vault, downloads/reimports the backup locally and
   authorizes one small Xverse deposit. Agree the amount first. Never request the
   backup, passphrase or one-time secrets, or reuse a spent validation fixture.
3. Create one reserved withdrawal job using the enrolled release. Observe durable
   intents, Batch IDs, CPU hit checks, both subset stages and budget accounting.
   Unknown submissions require reconciliation; switch toggles never authorize a
   duplicate paid request. Use the merged #53 behavior or documented workaround.
4. Deliver the public solved result. The user signs locally and approves the
   **exact transaction, destination, amount and fee**. Run the exact-spend and
   offline Core checks on those exact bytes. Failure stops submission.
5. Submit once through the approved route, reconcile uncertainty without another
   POST, and independently confirm the transaction in chain data. Preserve the
   public evidence requested by #22 only after sanitization.

A passing request-generation test, IAM simulator, infrastructure smoke or this
checklist does not satisfy #22's on-chain inclusion acceptance criterion.

## Operator inputs still needed before regional execution

- Reviewed final app enrollment from #15, its deployment commit and immutable
  solver release descriptor. The currently published release must be verified,
  enrolled and mirrored; do not select the legacy schema-2 entry.
- Intended AWS account/region and authenticated profiles for a disposable
  sandbox administrator and the exact-policy API test role. Identify table and
  role ARNs; supply references only, never credential values. Provisioning these
  resources is a separate authorized action, not part of this generator.
- Exact deployed Batch queue/definition ARN, application output/config endpoint
  and GPU role boundary ARN. Check all four GPU roles use the same-account
  `policy/qsb/bootstrap/qsb-gpu-boundary` and that its live policy is the reviewed
  bootstrap document. A Terraform source declaration does not attest live IAM.
- Authorization to execute the sandbox operations, followed by review of actual
  results. This is distinct from deployment activation approval and the later
  wallet deposit/transaction approval. No deposit amount has been assumed.

For each sandbox operation, save the response and exit code without pipelines
that replace AWS's exit code. Example after selecting the disposable resources
and receiving execution authorization (not executed by preparation):

```sh
aws --profile "$QSB_IAM_TEST_PROFILE" --region "$QSB_AWS_REGION" \
  dynamodb transact-write-items \
  --cli-input-json file:///private/tmp/qsb-predeposit-iam-requests/denied-transaction.json \
  > /private/tmp/denied-transaction.stdout.json 2> /private/tmp/denied-transaction.stderr.txt
qsb_iam_exit=$?
# Record qsb_iam_exit and the actual error in the private observation record.
# Then perform the required consistent administrator reads from the table above.
```

Run commands individually: an expected denial exits nonzero, so a blanket
`set -e` script would stop before the required post-state reads. Conversely,
`|| true` without recording the original exit status would erase evidence.
Store evidence privately and sanitize any public #22 record; do not commit
account credentials, raw policy inventories or operator configuration.
