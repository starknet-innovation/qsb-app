# APP-ROLE-SANDBOX steps 2 and 3, without assuming the test role

[`docs/APP-ROLE-SANDBOX.md`](../../docs/APP-ROLE-SANDBOX.md) steps 2 and 3 check live how AWS authorizes the API role's mixed DynamoDB transactions. The reservation logic depends on that result. Those steps need someone acting as a test role. The human access identities can't do that by design (see `ops/github-aws/README.md`):
- the operator user may assume only `qsb-viewonly` and `qsb-operator`;
- `qsb-operator` is denied `sts:AssumeRole`;
- root can't assume IAM roles.

So `run.py` performs the same calls from a throwaway Lambda that uses the test role.

## Run

Run it as `qsb-operator` from a clean, pushed checkout. Open the operator session with the CLI first, because the script uses it directly:

```sh
aws sts get-caller-identity --profile qsb-operator
python3 ops/iam-sandbox/run.py --profile qsb-operator --evidence ~/qsb-operations/iam-sandbox.json
```

It creates three resources, all named `qsb-iam-sandbox-<random>`:
- a disposable table;
- a role under `/qsb/runtime/` with `qsb-runtime-boundary`, whose only permissions are `terraform/policies/app-records.json`, scoped to that table exactly as `terraform/compute.tf` scopes them;
- a Lambda, `handler.py`, that uses the role.

It then runs, in order:

| Step | Expected |
| --- | --- |
| Control: a plain `OWNER#` Put | succeeds, which proves the role works (the row is then removed) |
| Transaction: `OWNER#` Put + `SYSTEM#` Put | denied; neither row written |
| Transaction: `OWNER#` Put + `OUTPOINT#` Put + `SYSTEM#` ConditionCheck (the reservation shape) | succeeds; owner and outpoint written, system not |
| Conditional re-create of the outpoint | `ConditionalCheckFailedException` |
| Delete the outpoint | denied; the reservation remains |
| After deleting the owner row: BatchWriteItem `OWNER#` + `SYSTEM#` | denied; neither row written, no partial success |

**Denials.** A denial counts only if AWS attributes it to the role's own identity policy, either an explicit deny or no allow. The handler records which policy type AWS names:
- identity policy;
- permissions boundary;
- SCP;
- unattributed.

A denial from the boundary or an SCP fails the check, because it would mean the check isn't testing `app-records.json`.

**Rows and evidence.** Between steps it reads the rows with consistent reads, and records which rows it saw. It writes the evidence outside Git: commit, policy hashes (the role-policy hash is taken with the account masked), error codes, denial attributions, cancellation reasons and observed rows. The evidence has no account numbers, session names or item data.

**Cleanup.** It deletes what it created, including anything whose create call errored, unless `--keep` is given. It reports each deletion as deleted, not found or failed. It exits with an error if any deletion failed, and names what to delete by hand.

**If any check fails:** stop, don't deposit, and don't loosen the app policy to make it pass. If the evidence attributes a denial to the permissions boundary, the boundary is missing something the app policy grants. Fix `qsb-runtime-boundary` in `ops/github-aws/render.py` through review, as #66 did for `ConditionCheckItem`, then install it with `update_installed.py`. Keep the evidence and investigate.

`qsb-operator` already has what this needs: DynamoDB and Lambda on `qsb-*`, and creating, passing and deleting `/qsb/runtime/qsb-*` roles with the runtime boundary.

`test_run.py` checks the orchestration offline with AWS mocked. It can't prove AWS's authorization behaviour; only the live run does.
