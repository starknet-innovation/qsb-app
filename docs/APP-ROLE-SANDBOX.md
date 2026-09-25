# App-role IAM validation (#12 / PR #38)

Status: **live regional DynamoDB checks NOT RUN; merge hold remains** until
Adrien confirms the results. Policy simulation cannot settle transactional
per-item authorization. Do not use production tables or roles for this procedure.

## 1. Repeat the read-only simulator

With an AWS CLI profile allowed to call `iam:SimulateCustomPolicy`, run from the
repository root:

```sh
python3 scripts/simulate-app-role-iam.py
```

This reproduces `APP-ROLE-IAM-SIMULATION.json`: both exact policy files, a dummy
ARN, six actions (`GetItem`, `PutItem`, `DeleteItem`, `ConditionCheckItem`,
`UpdateItem`, `BatchWriteItem`) and five contexts (owner, outpoint, system,
mixed owner/system, missing key). No role is assumed or changed and no table is
accessed. The output records source policy hashes and actual simulator decisions.

## 2. Regional transaction checks (operator)

Prerequisites: a dedicated disposable sandbox table with string `pk` and `sk`,
and an API test role whose only DynamoDB identity policy is the current
`terraform/policies/app-records.json` statements, each scoped to that table ARN
(and its index ARN for Query). Do not add broad DynamoDB permissions. Record
role policy hash, table ARN, region, commit, boundaries/SCPs and resource policy;
those may affect actual authorization. Provision from committed/pushed source.
Use AWS CLI profiles for the test role (`qsb-iam-test`) and sandbox administrator
(`qsb-iam-admin`); never export or publish credential values.

Set `QSB_IAM_TABLE` to this sandbox table and `AWS_REGION` explicitly. Generate
inert, unique test rows and request files in a new scratch directory:

```sh
mkdir qsb-iam-sandbox-requests
cd qsb-iam-sandbox-requests
python3 - <<'PY'
import json, os, uuid
from pathlib import Path
name = os.environ['QSB_IAM_TABLE']
suffix = uuid.uuid4().hex
keys = {label: {'pk': {'S': prefix + suffix}, 'sk': {'S': 'IAM_TEST'}}
        for label, prefix in [('owner', 'OWNER#'), ('system', 'SYSTEM#'), ('outpoint', 'OUTPOINT#')]}
def save(name, value):
    Path(name + '.json').write_text(json.dumps(value, indent=2))
for label, key in keys.items():
    save(label + '-key', key)
    save(label + '-put', {'TableName': name, 'Item': key,
                         'ConditionExpression': 'attribute_not_exists(pk)'})
put = lambda label: {'Put': {'TableName': name, 'Item': keys[label],
                            'ConditionExpression': 'attribute_not_exists(pk)'}}
save('denied-transaction', {'TransactItems': [put('owner'), put('system')]})
save('allowed-transaction', {'TransactItems': [put('owner'), put('outpoint'),
    {'ConditionCheck': {'TableName': name, 'Key': keys['system'],
                        'ConditionExpression': 'attribute_not_exists(pk)'}}]})
save('denied-batch', {'RequestItems': {name: [{'PutRequest': {'Item': keys['owner']}},
                                           {'PutRequest': {'Item': keys['system']}}]}})
PY
aws --profile qsb-iam-test dynamodb transact-write-items --cli-input-json file://denied-transaction.json
```

Expected: authorization denial, nonzero exit, **neither row written**. Record the
actual error name and whether `CancellationReasons` is returned (do not invent
it if CLI output omits it). With the administrator profile, use consistent reads
for both keys; absent `Item` confirms no write:

```sh
aws --profile qsb-iam-admin dynamodb get-item --table-name "$QSB_IAM_TABLE" --key file://owner-key.json --consistent-read
aws --profile qsb-iam-admin dynamodb get-item --table-name "$QSB_IAM_TABLE" --key file://system-key.json --consistent-read
aws --profile qsb-iam-test dynamodb transact-write-items --cli-input-json file://allowed-transaction.json
```

Expected: success. The owner and outpoint rows exist; the system row remains
absent. This is the important allowed-write plus `SYSTEM#` ConditionCheck case,
matching reservation creation. Read all three with the administrator profile.
Retry `outpoint-put.json` using test-role `put-item --cli-input-json`: expect
`ConditionalCheckFailedException`, showing the conditional creation guard.
Test-role `delete-item --table-name "$QSB_IAM_TABLE" --key file://outpoint-key.json`
must be denied and the reservation must remain.

## 3. Mixed BatchWriteItem (operator)

After step 2, delete only the inert owner test row using the administrator
profile (keep the outpoint row until cleanup). Then:

```sh
aws --profile qsb-iam-admin dynamodb delete-item --table-name "$QSB_IAM_TABLE" --key file://owner-key.json
aws --profile qsb-iam-test dynamodb batch-write-item --cli-input-json file://denied-batch.json
```

Expected: authorization denial and both owner/system rows absent on consistent
administrator reads. The API policy has no BatchWriteItem allow; SYSTEM also
matches an explicit deny. No partial owner write or UnprocessedItems success is
acceptable. Capture observed response and post-state, not just exit status.

On any mismatch stop; do not loosen policy to make the test pass. Save sanitized
commands, policy hashes, error names, optional cancellation reasons and before/
after row presence. Remove only these scratch rows and the dedicated test
resources after evidence capture. Have Adrien confirm steps 2 and 3 on the PR.
This is not a production rollout, fresh withdrawal, or mainnet authorization.

[AWS transactional IAM documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)
maps Put/Update/Delete to their ordinary item actions and ConditionCheck to
ConditionCheckItem. TransactWriteItems is an API operation, not an IAM action.
The permission model's runtime/operator entries remain parked conceptual
constraints, not deployed roles or permission-complete operator policies.
