"""Throwaway Lambda for the APP-ROLE-SANDBOX steps 2-3: one DynamoDB call per invocation.

It runs under a sandbox role whose only DynamoDB permissions are terraform/policies/app-records.json,
scoped to a disposable sandbox table. Each step returns only ok/error code (and cancellation reason
codes); it never returns item data. The operator reads rows back between steps.
"""
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

DYNAMODB = boto3.client('dynamodb', config=Config(retries={'max_attempts': 1, 'mode': 'standard'}))


def handler(event, context):
    table, suffix, step = event['table'], event['suffix'], event['step']
    key = lambda prefix: {'pk': {'S': prefix + suffix}, 'sk': {'S': 'IAM_TEST'}}
    put = lambda prefix: {'Put': {'TableName': table, 'Item': key(prefix),
                                  'ConditionExpression': 'attribute_not_exists(pk)'}}
    try:
        if step == 'denied-transaction':
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
        return {'ok': False, 'code': error.response['Error']['Code'], 'cancellationReasons': reasons or None}
