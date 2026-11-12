"""Independent campaign stop: public fixture tables and this exact Batch revision only."""
import json
import os
import time


def stop(clients, settings):
    from botocore.exceptions import ClientError
    reason = settings.get('stopReason', 'Fixed public validation deadline reached')
    for table in settings['tables']:
        try:
            clients['dynamodb'].update_item(TableName=table,
                Key={'pk': {'S': settings['pk']}, 'sk': {'S': settings['sk']}},
                UpdateExpression='SET #j.#s = :paused, #j.#e = :reason ADD #v :one',
                ConditionExpression='attribute_exists(pk) AND #j.#s IN (:queued, :searching)',
                ExpressionAttributeNames={'#j': 'job', '#s': 'status', '#e': 'error', '#v': 'version'},
                ExpressionAttributeValues={':paused': {'S': 'paused'}, ':queued': {'S': 'queued'},
                    ':searching': {'S': 'searching'}, ':reason': {'S': reason},
                    ':one': {'N': '1'}})
        except ClientError as e:
            if e.response['Error']['Code'] != 'ConditionalCheckFailedException':
                raise
    active = []
    batch = clients['batch']
    for status in ('SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING', 'RUNNING'):
        for page in batch.get_paginator('list_jobs').paginate(jobQueue=settings['queue'], jobStatus=status):
            ids = [j['jobId'] for j in page['jobSummaryList']]
            for offset in range(0, len(ids), 100):
                for job in batch.describe_jobs(jobs=ids[offset:offset + 100])['jobs']:
                    if job['jobDefinition'] != settings['definition']:
                        continue
                    if job.get('tags', {}).get('Project') != 'qsb-gpu':
                        raise RuntimeError('Campaign revision has an unexpected job tag')
                    active.append(job['jobId'])
                    batch.terminate_job(jobId=job['jobId'], reason=reason)
    return {'pauseRequested': True, 'activeJobs': active}


def drain(clients, settings, remaining=None):
    """Pause first, then reconcile beyond the lifetime of an in-flight coordinator."""
    started = time.monotonic()
    while remaining is None or remaining() > 25:
        result = stop(clients, settings)
        elapsed = time.monotonic() - started
        print(json.dumps(result), flush=True)
        if not result['activeJobs'] and elapsed >= 95:
            return {**result, 'terminalWorkVerified': True, 'settleSeconds': elapsed}
        if elapsed >= 150:
            break
        time.sleep(5)
    raise RuntimeError('Drain incomplete; retain reservations and reconcile before removal')


def handler(event, context):
    settings = json.loads(os.environ['SETTINGS'])
    if time.time() < settings['deadline']:
        return {'beforeDeadline': True}
    import boto3
    from botocore.config import Config
    config = Config(connect_timeout=5, read_timeout=15, retries={'total_max_attempts': 1})
    clients = {n: boto3.client(n, config=config) for n in ('batch', 'dynamodb')}
    # A coordinator invocation may already have reserved work before the pause.
    # Reconcile past its 90-second timeout so a late accepted POST is also stopped.
    return drain(clients, settings, remaining=lambda: context.get_remaining_time_in_millis() / 1000)
