#!/usr/bin/env python3
"""Prepare inert IAM sandbox requests only. No AWS calls or credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import uuid

ROOT = Path(__file__).resolve().parents[1]


def prepare(table_arn: str, role_arn: str, destination: Path):
    table = re.fullmatch(r'arn:aws:dynamodb:([a-z0-9-]+):(\d{12}):table/([A-Za-z0-9_.-]{3,255})', table_arn)
    role = re.fullmatch(r'arn:aws:iam::(\d{12}):role/([A-Za-z0-9+=,.@_/-]+)', role_arn)
    if not table or not role or table[2] != role[1]:
        raise ValueError('Explicit same-account sandbox table and test-role ARNs required')
    # Never merge with or overwrite earlier request/evidence files.
    destination.mkdir(parents=True, exist_ok=False)
    nonce = uuid.uuid4().hex
    keys = {label: {'pk': {'S': prefix + nonce}, 'sk': {'S': 'IAM_TEST'}}
            for label, prefix in [('owner', 'OWNER#'), ('system', 'SYSTEM#'), ('outpoint', 'OUTPOINT#')]}
    def put(label):
        return {'Put': {'TableName': table[3], 'Item': keys[label],
                        'ConditionExpression': 'attribute_not_exists(pk)'}}
    requests = {
        'denied-transaction': {'TransactItems': [put('owner'), put('system')]},
        'allowed-transaction': {'TransactItems': [put('owner'), put('outpoint'),
            {'ConditionCheck': {'TableName': table[3], 'Key': keys['system'],
                                'ConditionExpression': 'attribute_not_exists(pk)'}}]},
        'denied-batch': {'RequestItems': {table[3]: [
            {'PutRequest': {'Item': keys['owner']}}, {'PutRequest': {'Item': keys['system']}}]}},
        'duplicate-outpoint': put('outpoint')['Put'],
        'delete-outpoint': {'TableName': table[3], 'Key': keys['outpoint']},
        'remove-inert-owner-before-batch': {'TableName': table[3], 'Key': keys['owner']},
    }
    for label, key in keys.items():
        requests[f'read-{label}'] = {'TableName': table[3], 'Key': key, 'ConsistentRead': True}
    for name, value in requests.items():
        (destination / f'{name}.json').write_text(json.dumps(value, indent=2) + '\n')
    policy = ROOT / 'terraform/policies/app-records.json'
    manifest = {'schemaVersion': 1, 'scope': 'inert-disposable-sandbox-only',
                'tableArn': table_arn, 'testRoleArn': role_arn, 'region': table[1],
                'nonce': nonce, 'policySourceSha256': hashlib.sha256(policy.read_bytes()).hexdigest(),
                'requestSha256': {f'{name}.json': hashlib.sha256((destination / f'{name}.json').read_bytes()).hexdigest()
                                  for name in requests},
                'awsCallsPerformed': False}
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    # Blank observations are deliberately not success evidence. Operators retain
    # actual service responses and consistent reads alongside this local form.
    expected = {
        'initial-reads': {'owner': False, 'system': False, 'outpoint': False},
        'denied-transaction': {'owner': False, 'system': False, 'outpoint': False},
        'allowed-transaction': {'owner': True, 'system': False, 'outpoint': True},
        'duplicate-outpoint': {'outpoint': True},
        'delete-outpoint': {'outpoint': True},
        'remove-inert-owner-before-batch': {'owner': False, 'system': False, 'outpoint': True},
        'denied-batch': {'owner': False, 'system': False, 'outpoint': True},
    }
    observations = {
        'schemaVersion': 1, 'status': 'NOT_RUN', 'nonce': nonce,
        'requestManifestSha256': hashlib.sha256((destination / 'manifest.json').read_bytes()).hexdigest(),
        'appCommit': None, 'awsAccount': table[2], 'region': table[1],
        'testPrincipalArnObserved': None, 'administratorPrincipalArnObserved': None,
        'rolePolicyDocumentSha256Observed': None,
        'permissionsBoundaryDocumentSha256Observed': None,
        'scpAndResourcePolicyReviewReference': None,
        'steps': {name: {'expectedItemPresence': presence, 'observedItemPresence': None,
                         'observedAtUtc': None, 'exitCode': None, 'serviceErrorCode': None,
                         'cancellationReasons': None, 'responseFile': None,
                         'consistentReadFiles': [], 'evidenceFileSha256': {}}
                  for name, presence in expected.items()},
        'operatorReviewReference': None, 'depositAuthorized': False,
    }
    (destination / 'observations.template.json').write_text(json.dumps(observations, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--table-arn', required=True)
    parser.add_argument('--test-role-arn', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        manifest = prepare(args.table_arn, args.test_role_arn, args.output)
    except (ValueError, OSError) as exc:
        parser.exit(1, f'Preparation refused: {exc}\n')
    print(json.dumps({'output': str(args.output), 'requestFiles': len(manifest['requestSha256']),
                      'awsCallsPerformed': False}))
