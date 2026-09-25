"""Throwaway Lambda for the APP-ROLE-SANDBOX steps 2-3: one DynamoDB call per invocation.

It runs under a sandbox role whose only DynamoDB permissions are terraform/policies/app-records.json,
scoped to a disposable sandbox table. Each step returns only ok, the error code, cancellation reason
codes and a sanitized *reason* for an authorization denial (which policy type denied it, never an ARN
or item data). The operator reads rows back between steps.
"""
import re

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

DYNAMODB = boto3.client('dynamodb', config=Config(retries={'max_attempts': 1, 'mode': 'standard'}))


def denial_reason(message):
    """Which policy type AWS says denied the call; distinguishes the app policy from a boundary or SCP."""
    text = message or ''
    patterns = [
        (r'explicit deny in an identity-based policy', 'explicit-deny-identity'),
        (r'explicit deny in a permissions boundary', 'explicit-deny-boundary'),
        (r'explicit deny in a service control policy', 'explicit-deny-scp'),
        (r'no identity-based policy allows', 'no-identity-allow'),
        (r'no permissions boundary allows', 'no-boundary-allow'),
        (r'service control policy', 'scp'),
    ]
    return next((label for pattern, label in patterns if re.search(pattern, text, re.I)), 'unattributed')


def handler(event, context):
    table, suffix, step = event['table'], event['suffix'], event['step']
    key = lambda prefix: {'pk': {'S': prefix + suffix}, 'sk': {'S': 'IAM_TEST'}}
    put = lambda prefix: {'Put': {'TableName': table, 'Item': key(prefix),
                                  'ConditionExpression': 'attribute_not_exists(pk)'}}
    try:
        if step == 'control-owner-put':
            DYNAMODB.put_item(TableName=table, Item=key('OWNER#'), ConditionExpression='attribute_not_exists(pk)')
        elif step == 'denied-transaction':
            DYNAMODB.transact_write_items(TransactItems=[put('OWNER#'), put('SYSTEM#')])
        elif step == 'allowed-transaction':
            DYNAMODB.transact_write_items(TransactItems=[
                put('OWNER#'), put('OUTPOINT#'),
                {'ConditionCheck': {'TableName': table, 'Key': key('SYSTEM#'),
                                    'ConditionExpression': 'attribute_not_exists(pk)'}}])
        elif step == 'outpoint-put-again':
            DYNAMODB.put_item(TableName=table, Item=key('OUTPOINT#'), ConditionExpression='attribute_not_exists(pk)')
        elif step == 'outpoint-delete':
            DYNAMODB.delete_item(TableName=table, Key=key('OUTPOINT#'))
        elif step == 'denied-batch':
            result = DYNAMODB.batch_write_item(RequestItems={table: [
                {'PutRequest': {'Item': key('OWNER#')}}, {'PutRequest': {'Item': key('SYSTEM#')}}]})
            return {'ok': True, 'unprocessed': bool(result.get('UnprocessedItems'))}
        else:
            return {'ok': False, 'code': 'UnknownStep'}
        return {'ok': True}
    except ClientError as error:
        reasons = [r.get('Code') for r in error.response.get('CancellationReasons', [])]
        code = error.response['Error']['Code']
        return {'ok': False, 'code': code, 'cancellationReasons': reasons or None,
                'denial': denial_reason(error.response['Error'].get('Message')) if 'AccessDenied' in code else None}
