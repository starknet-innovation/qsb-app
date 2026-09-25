#!/usr/bin/env python3
"""Read-only AWS IAM simulation; never creates resources or retrieves secrets."""
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
resource = 'arn:aws:dynamodb:us-east-1:123456789012:table/qsb-policy-simulation'
actions = ['GetItem', 'PutItem', 'DeleteItem', 'ConditionCheckItem', 'UpdateItem', 'BatchWriteItem']
report = {'kind': 'AWS IAM custom-policy simulation; not live DynamoDB calls',
          'resource': resource, 'command': 'python3 scripts/simulate-app-role-iam.py',
          'method': 'Exact committed statements with a dummy table Resource; SimulateCustomPolicy only. No role, table or credential mutations.',
          'cases': []}
for role, filename in [('api', 'app-records.json'), ('coordinator', 'coordinator-records.json')]:
    raw = (root / 'terraform/policies' / filename).read_bytes()
    statements = [dict(s, Resource=resource) for s in json.loads(raw)]
    policy = json.dumps({'Version': '2012-10-17', 'Statement': statements})
    for keys in [['OWNER#dummy'], ['OUTPOINT#dummy'], ['SYSTEM#dummy'], ['OWNER#dummy', 'SYSTEM#dummy'], []]:
        command = ['aws', 'iam', 'simulate-custom-policy', '--policy-input-list', policy,
                   '--action-names', *['dynamodb:' + a for a in actions],
                   '--resource-arns', resource, '--output', 'json', '--no-cli-pager']
        if keys:
            command += ['--context-entries', json.dumps([{'ContextKeyName': 'dynamodb:LeadingKeys',
                         'ContextKeyType': 'stringList', 'ContextKeyValues': keys}])]
        result = json.loads(subprocess.check_output(command))
        report['cases'].append({'role': role, 'policySha256': hashlib.sha256(raw).hexdigest(),
                                'keys': keys, 'decisions': {x['EvalActionName']: x['EvalDecision'] for x in result['EvaluationResults']}})
(root / 'docs/APP-ROLE-IAM-SIMULATION.json').write_text(json.dumps(report, indent=2) + '\n')
print('Recorded 60 read-only IAM simulation decisions; live DynamoDB gate remains pending.')
