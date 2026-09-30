# IAM sandbox runner

`run.py` performs steps 2 and 3 of [`docs/APP-ROLE-SANDBOX.md`](../../docs/APP-ROLE-SANDBOX.md), which check live how AWS authorizes the API role's mixed DynamoDB transactions. Those steps need someone acting as a test role, and the human access identities can't do that by design (see `ops/github-aws/README.md`): they may assume only `qsb-viewonly` and `qsb-operator`, and `qsb-operator` is denied `sts:AssumeRole`. So `run.py` makes the same calls from a throwaway Lambda that uses the test role.

## Run

Run it as `qsb-operator` from a clean, pushed checkout, with the stack's region. Open the operator session with the CLI first, because the script uses it directly:

```sh
aws sts get-caller-identity --profile qsb-operator
python3 ops/iam-sandbox/run.py --profile qsb-operator --region eu-west-2 --evidence ~/qsb-operations/iam-sandbox.json
```

It creates three resources, all named `qsb-iam-sandbox-<random>`:
- a disposable table;
- a role under `/qsb/runtime/` with `qsb-runtime-boundary`, whose only permissions are `terraform/policies/app-records.json`, scoped to that table exactly as `terraform/compute.tf` scopes them;
- a Lambda, `handler.py`, that uses the role.

It then runs the steps and expected results listed in [APP-ROLE-SANDBOX.md](../../docs/APP-ROLE-SANDBOX.md#23-live-transaction-and-batch-checks). The handler records which policy type AWS names for each denial (identity policy, permissions boundary, SCP, or unattributed).

**Evidence.** Between steps it reads the rows with consistent reads and records which rows it saw. It writes the evidence outside Git: commit, policy hashes (the role-policy hash is taken with the account masked), error codes, denial attributions, cancellation reasons and observed rows. The evidence has no account numbers, session names or item data.

**Cleanup.** It deletes what it created, including anything whose create call errored, unless `--keep` is given. It reports each deletion as deleted, not found or failed, exits with an error if any deletion failed, and names what to delete by hand.

## Outcomes

The evidence records one of four `outcome` values: `passed`, `failed`, `inconclusive` or `aborted`. Only `passed` counts, and it requires a completed run with all 10 checks passing.
- **Aborted:** it stopped before every check ran (a Lambda error, an expired session, an interruption). Fix the cause and rerun.
- **Inconclusive:** the control step failed, or AWS didn't say which policy denied a call. Rerun once. If it repeats, the denial-attribution method needs a reviewed change: an unattributed denial never counts as a pass.
- **Failed:** stop, and don't loosen the app policy to make it pass. If the evidence attributes a denial to the permissions boundary, the boundary is missing something the app policy grants. Fix `qsb-runtime-boundary` in `ops/github-aws/render.py` through review, as #66 did for `ConditionCheckItem`, then have the administrator install it with `update_installed.py`.

`qsb-operator` already has what this needs: DynamoDB and Lambda on `qsb-*`, and creating, passing and deleting `/qsb/runtime/qsb-*` roles with the runtime boundary. `test_run.py` checks the orchestration offline with AWS mocked; it can't prove AWS's authorization behaviour.
