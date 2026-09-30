# App-role IAM validation

The API role's reservation writes depend on how AWS authorizes each item of a mixed DynamoDB transaction, which policy simulation can't settle. These checks establish it against the committed `terraform/policies/app-records.json`, without touching production tables or roles.

**Status.** Steps 2 and 3 passed live on 25 September 2026 in the earlier account (`ops/iam-sandbox/run.py` at `5c0e74f`: outcome `passed`, 10 of 10 checks). They cover the API role only. The coordinator's two-item `OWNER#` transaction for `owner_max_gpu_seconds` has not been run; run it before that variable is ever set ([runbook](OPERATIONAL-RUNBOOK.md#per-owner-limits)).

## 1. Policy simulation (read-only)

With an AWS CLI profile allowed to call `iam:SimulateCustomPolicy`, from the repository root:

```sh
python3 scripts/simulate-app-role-iam.py
```

This writes `APP-ROLE-IAM-SIMULATION.json` next to this doc: both policy files, a dummy table ARN, six actions (`GetItem`, `PutItem`, `DeleteItem`, `ConditionCheckItem`, `UpdateItem`, `BatchWriteItem`) and five key contexts (owner, outpoint, system, mixed owner/system, missing key). No role is assumed or changed and no table is accessed. The output records each source policy's hash and the simulator's decisions. Run it after changing either policy and commit its output with that change.

## 2–3. Live transaction and batch checks

The human access roles can't assume a test role by design, so [`ops/iam-sandbox/run.py`](../ops/iam-sandbox/README.md) runs these as `qsb-operator` from a throwaway Lambda whose role has only `app-records.json`, scoped to a disposable table. Expected results:

| Step | Expected |
| --- | --- |
| Control: a plain `OWNER#` Put | succeeds, which proves the role works (the row is then removed) |
| Transaction: `OWNER#` Put + `SYSTEM#` Put | denied; neither row written |
| Transaction: `OWNER#` Put + `OUTPOINT#` Put + `SYSTEM#` ConditionCheck (the reservation shape) | succeeds; owner and outpoint written, system not |
| Conditional re-create of the outpoint | `ConditionalCheckFailedException` |
| Delete the outpoint | denied; the reservation remains |
| After deleting the owner row: BatchWriteItem `OWNER#` + `SYSTEM#` | denied; neither row written, no partial success or `UnprocessedItems` |

Rows are read back with consistent reads between steps. A denial counts only when AWS attributes it to the role's own identity policy: a denial from the permissions boundary or an SCP fails the check, because it wouldn't be testing `app-records.json`.

On any mismatch, stop; don't loosen the policy to make the test pass. This is not a production rollout or a mainnet authorization.

[AWS transactional IAM documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html) maps Put, Update and Delete to their ordinary item actions and ConditionCheck to ConditionCheckItem. TransactWriteItems is an API operation, not an IAM action.
