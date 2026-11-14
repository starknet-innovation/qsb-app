"""Non-submitting guard for one public fixture in the deployed pipeline."""
import json
import os
import re
import time
from decimal import Decimal

ACTIVE = ('SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING', 'RUNNING')

def decode(value):
    if 'M' in value: return {k: decode(v) for k, v in value['M'].items()}
    if 'L' in value: return [decode(v) for v in value['L']]
    if 'SS' in value: return value['SS']
    if 'N' in value:
        number=Decimal(value['N'])
        return int(number) if number==int(number) else number
    return value.get('S', value.get('BOOL'))

def checked_request(record, settings):
    token = record.get('jobName', '').removeprefix('qsb-')
    if (not re.fullmatch(r'[a-f0-9-]{36}', token) or record.get('jobName') != 'qsb-' + token
        or record.get('inputKey') != 'inputs/' + token + '.json'
        or not re.fullmatch(r'[a-f0-9]{64}', record.get('inputSha256', ''))
        or record.get('definition') != settings['definition'] or record.get('queue') != settings['queue']
        or set(record) != {'jobName', 'inputKey', 'inputSha256', 'definition', 'queue'}):
        raise RuntimeError('Public request identity changed')
    return record

def owned(job, records, settings):
    if job.get('jobQueue') != settings['queue'] or job.get('jobDefinition') != settings['definition']:
        return False
    matches = [r for r in records if r['jobName'] == job.get('jobName')]
    if len(matches) != 1: return False
    r = matches[0]
    values = job.get('container', {}).get('environment', [])
    tags = job.get('tags', {})
    return ([(x.get('name'), x.get('value')) for x in values if x.get('name') in ('QSB_INPUT_KEY', 'QSB_INPUT_SHA256')]
        in [[('QSB_INPUT_KEY', r['inputKey']), ('QSB_INPUT_SHA256', r['inputSha256'])],
            [('QSB_INPUT_SHA256', r['inputSha256']), ('QSB_INPUT_KEY', r['inputKey'])]]
        and tags.get('Project') == 'qsb-gpu' and tags.get('InputSha256') == r['inputSha256']
        and tags.get('QsbRequest') == r['jobName'][4:])

def read_rows(ddb, settings):
    def row(sk):
        item = ddb.get_item(TableName=settings['table'], Key={'pk': {'S': settings['pk']}, 'sk': {'S': sk}}, ConsistentRead=True).get('Item')
        return {k: decode(v) for k, v in item.items()} if item else None
    public, ledger = row(settings['sk']), row(settings['ledgerSk'])
    if not ledger or ledger.get('manifestHash') != settings['manifestHash'] or ledger.get('case') != settings['name']:
        raise RuntimeError('Public campaign registry missing or changed')
    for candidate in [public, ledger.get('lastPublicRow')]:
        if not candidate: continue
        j = candidate.get('job', {})
        if (j.get('id') != settings['jobId'] or j.get('owner') != settings['owner']
            or j.get('vaultId') != settings['vaultId'] or j.get('manifestHash') != settings['manifestHash']
            or candidate.get('expiresAt') != settings['expiresAt']):
            raise RuntimeError('Public fixture binding changed')
    return public, ledger

def remember(ddb, settings, public, ledger):
    records = {json.dumps(checked_request(json.loads(x), settings), sort_keys=True) for x in ledger.get('records', [])}
    j = public.get('job', {}) if public else {}
    current = [j.get('batchSubmission'), *(s.get('batchSubmission') for s in j.get('parallelSlots', []))]
    for r in current:
        if r: records.add(json.dumps(checked_request(r, settings), sort_keys=True))
    if len(records) > 512: raise RuntimeError('Public registry capacity reached; stop and reconcile')
    if records:
        ddb.update_item(TableName=settings['table'], Key={'pk': {'S': settings['pk']}, 'sk': {'S': settings['ledgerSk']}},
            UpdateExpression='ADD #records :records', ConditionExpression='manifestHash = :hash AND #c = :case',
            ExpressionAttributeNames={'#c': 'case', '#records':'records'}, ExpressionAttributeValues={':records': {'SS': sorted(records)},
                ':hash': {'S': settings['manifestHash']}, ':case': {'S': settings['name']}})
    if public:
        from boto3.dynamodb.types import TypeSerializer
        ddb.update_item(TableName=settings['table'],Key={'pk':{'S':settings['pk']},'sk':{'S':settings['ledgerSk']}},
            UpdateExpression='SET paidSubmissions = :n, lastPublicRow = :row',
            ConditionExpression='manifestHash = :hash AND #c = :case',ExpressionAttributeNames={'#c':'case'},
            ExpressionAttributeValues={':n':{'N':str(j.get('gpuSubmissions',0))},':row':TypeSerializer().serialize(public),':hash':{'S':settings['manifestHash']},':case':{'S':settings['name']}})
    return [json.loads(x) for x in sorted(records)]

def chain(states, settings):
    arn, result, seen = settings['rootExecution'], [], set()
    prefix = settings['workflow'].replace(':stateMachine:', ':execution:') + ':'
    while arn:
        if arn in seen or not arn.startswith(prefix) or len(seen) >= 8:
            raise RuntimeError('Unexpected execution chain')
        seen.add(arn)
        try: value = states.describe_execution(executionArn=arn)
        except states.exceptions.ExecutionDoesNotExist:
            if result: raise
            return []
        event = json.loads(value['input'])
        if (event.get('owner') != settings['owner'] or event.get('jobId') != settings['jobId'] or event.get('revision') != 0
            or set(event) - {'owner', 'jobId', 'revision', 'polls'} or event.get('polls', 0) != 0):
            raise RuntimeError('Execution is not the public fixture')
        result.append(value)
        output = json.loads(value.get('output', '{}'))
        arn = output.get('ExecutionArn', output.get('executionArn')) if value['status'] == 'SUCCEEDED' else None
    return result

def inventory(batch, settings, records, terminal=False):
    ids = set()
    for status in (*ACTIVE, 'SUCCEEDED', 'FAILED') if terminal else ACTIVE:
        for page in batch.get_paginator('list_jobs').paginate(jobQueue=settings['queue'], jobStatus=status):
            ids.update(j['jobId'] for j in page['jobSummaryList'])
    jobs = []
    ordered = sorted(ids)
    for start in range(0, len(ordered), 100):
        chunk = ordered[start:start + 100]
        values = batch.describe_jobs(jobs=chunk)['jobs']
        if sorted(x['jobId'] for x in values) != chunk: raise RuntimeError('Incomplete Batch inventory')
        jobs.extend(values)
    return [j for j in jobs if owned(j, records, settings)], [j['jobId'] for j in jobs if j['status'] in ACTIVE and not owned(j, records, settings)]

def pause(ddb, settings, reason):
    from botocore.exceptions import ClientError
    try:
        ddb.update_item(TableName=settings['table'], Key={'pk': {'S': settings['pk']}, 'sk': {'S': settings['sk']}},
            UpdateExpression='SET #j.#s = :failed, #j.#e = :reason ADD #v :one',
            ConditionExpression='#j.manifestHash = :hash AND #j.#id = :id AND #j.#s IN (:queued, :searching, :paused)',
            ExpressionAttributeNames={'#j': 'job', '#s': 'status', '#e': 'error', '#v': 'version', '#id':'id'},
            ExpressionAttributeValues={':failed': {'S': 'failed'}, ':reason': {'S': reason}, ':one': {'N': '1'},
                ':hash': {'S': settings['manifestHash']}, ':id': {'S': settings['jobId']}, ':queued': {'S': 'queued'},
                ':searching': {'S': 'searching'}, ':paused': {'S': 'paused'}})
    except ClientError as error:
        if error.response['Error']['Code'] != 'ConditionalCheckFailedException': raise

def observe(clients, settings, terminal=False):
    public, ledger = read_rows(clients['dynamodb'], settings)
    records = remember(clients['dynamodb'], settings, public, ledger)
    jobs, foreign = inventory(clients['batch'], settings, records, terminal)
    if foreign:
        # Capture candidates first, then strongly read reservations committed
        # before their paid POST. Do not relist after the refreshed ownership read.
        candidates=[]
        for offset in range(0,len(foreign),100):
            chunk=foreign[offset:offset+100]
            found=clients['batch'].describe_jobs(jobs=chunk)['jobs']
            if sorted(j['jobId'] for j in found)!=sorted(chunk):raise RuntimeError('Incomplete ownership refresh')
            candidates.extend(found)
        public, ledger = read_rows(clients['dynamodb'], settings)
        records = remember(clients['dynamodb'], settings, public, ledger)
        jobs += [j for j in candidates if owned(j,records,settings)]
        foreign = [j['jobId'] for j in candidates if j['status'] in ACTIVE and not owned(j,records,settings)]
    executions = chain(clients['stepfunctions'], settings)
    return {'publicRow': public, 'lastPublicRow': ledger.get('lastPublicRow'), 'paidSubmissions': (public or ledger.get('lastPublicRow') or {}).get('job',{}).get('gpuSubmissions',0), 'records': records, 'jobs': jobs, 'foreignActiveIds': foreign, 'executions': executions, 'drainedAt': ledger.get('drainedAt')}

def stopping(value, settings, now):
    j = (value['publicRow'] or {}).get('job', {})
    return (now >= settings['stopAt'] or value['foreignActiveIds']
        or j.get('status') in ('paused', 'failed') or (j.get('status') in ('queued', 'searching') and j.get('gpuSubmissions', 0) >= 224)
        or any(e['status'] in ('FAILED', 'TIMED_OUT', 'ABORTED') for e in value['executions'])
        or any(j['status'] == 'FAILED' and j.get('statusReason') != 'QSB operator/coordinator cancellation' for j in value['jobs']))

def drain(clients, settings, remaining=lambda: 1000):
    started = time.monotonic()
    while remaining() > 30:
        pause(clients['dynamodb'], settings, 'Bounded public deployed validation stopped; no compute retry')
        value = observe(clients, settings)
        for j in value['jobs']:
            if j['status'] in ACTIVE: clients['batch'].terminate_job(jobId=j['jobId'], reason='Bounded public deployed validation stopped')
        if (not any(j['status'] in ACTIVE for j in value['jobs']) and all(e['status'] != 'RUNNING' for e in value['executions'])
            and time.monotonic() - started >= 120):
            clients['dynamodb'].update_item(TableName=settings['table'], Key={'pk': {'S': settings['pk']}, 'sk': {'S': settings['ledgerSk']}}, UpdateExpression='SET drainedAt = :now', ConditionExpression='manifestHash = :hash', ExpressionAttributeValues={':now': {'N': str(int(time.time()))}, ':hash': {'S': settings['manifestHash']}})
            return {**value, 'drained': True}
        if time.monotonic() - started >= 165: break
        time.sleep(5)
    raise RuntimeError('Public drain incomplete; retain reservation and reconcile')

def handler(event, context):
    import boto3
    from botocore.config import Config
    settings = json.loads(os.environ['SETTINGS'])
    config = Config(connect_timeout=5, read_timeout=15, retries={'total_max_attempts': 1})
    clients = {n: boto3.client(n, config=config) for n in ('batch', 'dynamodb', 'stepfunctions')}
    # Stop new reservations before any fallible inventory or execution read.
    if event.get('action') == 'stop' or time.time() >= settings['stopAt']:
        pause(clients['dynamodb'], settings, 'Bounded public deployed validation stopped; no compute retry')
    try:
        value = observe(clients, settings, terminal=event.get('action') == 'collect')
    except Exception:
        pause(clients['dynamodb'], settings, 'Public observation failed; reconcile without compute retry')
        raise
    if event.get('action') == 'stop' or stopping(value, settings, time.time()):
        if not value.get('drainedAt') or any(j['status'] in ACTIVE for j in value['jobs']) or any(e['status']=='RUNNING' for e in value['executions']):
            value = drain(clients, settings, remaining=lambda: context.get_remaining_time_in_millis() / 1000)
        if event.get('action') == 'collect':
            value = {**observe(clients, settings, terminal=True), 'drained': True}
    # Only this public fixture and its proven execution chain are returned.
    return json.loads(json.dumps(value, default=lambda x: float(x) if isinstance(x,Decimal) else str(x)))
