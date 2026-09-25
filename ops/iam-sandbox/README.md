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
| Transaction: `OWNER#` Put + `SYSTEM#` Put | denied; neither row written |
| Transaction: `OWNER#` Put + `OUTPOINT#` Put + `SYSTEM#` ConditionCheck (the reservation shape) | succeeds; owner and outpoint written, system not |
| Conditional re-create of the outpoint | `ConditionalCheckFailedException` |
| Delete the outpoint | denied; the reservation remains |
| After deleting the owner row: BatchWriteItem `OWNER#` + `SYSTEM#` | denied; neither row written, no partial success |

Between steps it reads the rows with consistent reads. It writes the evidence outside Git: commit, policy hashes, error codes, cancellation reasons and row presence, with no account numbers or item data. It always deletes what it created, unless `--keep` is given.

**If any check fails:** stop, don't deposit, and don't loosen the policy to make it pass. Keep the evidence and investigate.

`qsb-operator` already has what this needs: DynamoDB and Lambda on `qsb-*`, and creating, passing and deleting `/qsb/runtime/qsb-*` roles with the runtime boundary.

`test_run.py` checks the orchestration offline with AWS mocked. It can't prove AWS's authorization behaviour; only the live run does.
