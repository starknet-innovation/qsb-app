#!/usr/bin/env python3
"""One-shot public PQB validation on the existing Batch fleet. Private receipts outside Git."""
import argparse
import base64
import copy
import hashlib
import io
import json
import os
import re
import shutil
from pathlib import Path
import subprocess
import time
import uuid
import zipfile
from datetime import datetime, timezone
from decimal import Decimal

ROOT = Path(__file__).resolve().parents[2]
ACTIVE = ('SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING', 'RUNNING')


def dump(value):
    return json.dumps(value, sort_keys=True, indent=2, default=lambda x: int(x) if isinstance(x, Decimal) and x == int(x) else str(x)) + '\n'


def persist(path, value, exclusive=False):
    data = dump(value).encode()
    if exclusive:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    else:
        fd = os.open(str(path) + '.tmp', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    if not exclusive:
        os.replace(str(path) + '.tmp', path)
    parent = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def clean_source():
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()
    if git('status', '--porcelain'):
        raise RuntimeError('Commit all source before cloud mutation')
    commit, branch = git('rev-parse', 'HEAD'), git('branch', '--show-current')
    if git('ls-remote', 'origin', 'refs/heads/' + branch).split()[0] != commit:
        raise RuntimeError('Push source before cloud mutation')
    return commit


class Campaign:
    def __init__(self, directory):
        import boto3
        from botocore.config import Config
        self.directory = directory.resolve()
        if self.directory.is_relative_to(ROOT):
            raise RuntimeError('Keep operator configuration and receipts outside Git')
        self.state_path = self.directory / 'campaign.json'
        self.config = json.loads((self.directory / 'operator.json').read_text())
        if set(self.config) != {'profile', 'account', 'region'} or self.config['region'] != 'eu-west-2':
            raise RuntimeError('Use the scoped London operator profile, account and region')
        self.session = boto3.Session(profile_name=self.config['profile'], region_name=self.config['region'])
        self.clients = {}
        self.sdk_config = Config(connect_timeout=5, read_timeout=30, retries={'total_max_attempts': 1})
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else None
        if self.state and self.state['operatorHash'] != hashlib.sha256(dump(self.config).encode()).hexdigest():
            raise RuntimeError('Operator binding changed')
        if self.client('sts').get_caller_identity()['Account'] != self.config['account']:
            raise RuntimeError('Operator account mismatch')
        self.account = self.config['account']
        self.region = self.config['region']
        if self.state:
            self.validate_scope()

    def validate_scope(self):
        name = self.state['name']
        if self.state['deadline'] != self.state['createdAt'] + 4 * 3600 or self.state['reservedUsd'] != 200 or self.state['preflightGpuSeconds'] != 900 or self.state['solveGpuSeconds'] != 540000:
            raise RuntimeError('Campaign deadline or reserved budget changed')
        if not re.fullmatch(r'qsb-pqb-v-[a-f0-9]{12}', name):
            raise RuntimeError('Invalid dedicated campaign name')
        expected = {'tables': [name + '-preflight', name + '-solve'],
            'roles': [name + '-' + n for n in ['coordinator', 'workflow', 'deadline', 'scheduler']],
            'function': name + '-coordinator', 'cleanupFunction': name + '-deadline',
            'workflow': name, 'schedule': name + '-deadline'}
        if any(self.state[k] != v for k, v in expected.items()):
            raise RuntimeError('Dedicated resource scope changed; refuse cleanup or execution')
        if self.state.get('logs') not in (None, ['/aws/lambda/' + expected['function'], '/aws/lambda/' + expected['cleanupFunction'], '/aws/vendedlogs/states/' + name]):
            raise RuntimeError('Dedicated log scope changed')
        queue_name = json.loads((ROOT / 'server/aws-batch-validation.json').read_text())['name'] if self.state.get('capacity') else 'qsb-gpu'
        if self.state['queue'] != self.arn('batch', 'job-queue/' + queue_name) or self.state['bucket'] != f'qsb-gpu-{self.account}-{self.region}-jobs':
            raise RuntimeError('Shared Batch binding changed')
        if self.state.get('capacity') and self.state.get('watchdogSchedule') != name + '-watchdog':
            raise RuntimeError('Isolated watchdog scope changed')
        definition = self.state.get('definition')
        if definition and not re.fullmatch(re.escape(self.arn('batch', 'job-definition/qsb-gpu-solver:')) + r'[0-9]+', definition):
            raise RuntimeError('Unexpected Batch definition namespace')
        if definition:
            found = self.client('batch').describe_job_definitions(jobDefinitions=[definition])['jobDefinitions']
            if len(found) != 1 or found[0].get('tags', {}).get('PqbValidation') != name:
                raise RuntimeError('Batch revision is not owned by this campaign')

    def client(self, name):
        if name not in self.clients:
            self.clients[name] = self.session.client(name, config=self.sdk_config)
        return self.clients[name]

    def arn(self, service, resource):
        return f'arn:aws:{service}:{self.region}:{self.account}:{resource}'

    def iam(self, name):
        return f'arn:aws:iam::{self.account}:role/qsb/runtime/{name}'

    def save(self):
        persist(self.state_path, self.state)

    def mutate(self, key, service, operation, invoke=None, **params):
        journal = self.directory / 'requests'
        journal.mkdir(exist_ok=True)
        intent, response = journal / (key + '.intent.json'), journal / (key + '.response.json')
        def normalized(v):
            if isinstance(v, bytes):
                return {'bytes': len(v), 'sha256': hashlib.sha256(v).hexdigest()}
            if isinstance(v, dict):
                return {k: normalized(x) for k, x in v.items()}
            if isinstance(v, list):
                return [normalized(x) for x in v]
            return v
        request = {'service': service, 'operation': operation, 'params': normalized(params)}
        if intent.exists():
            if json.loads(intent.read_text()) != request or not response.exists():
                raise RuntimeError(f'Uncertain or changed request {key}; reconcile, never replay')
            prior = json.loads(response.read_text())
            if 'error' in prior:
                raise RuntimeError(f'Prior failure {key}; reconcile before any new request')
            return prior['result']
        persist(intent, request, exclusive=True)
        try:
            result = invoke() if invoke is not None else getattr(self.client(service), operation)(**params)
        except Exception as error:
            persist(response, {'error': type(error).__name__, 'message': str(error)}, exclusive=True)
            raise
        persist(response, {'result': result}, exclusive=True)
        return result

    def inspect(self):
        # No application table data or secret values are read.
        coordinator = self.client('lambda').get_function_configuration(FunctionName='qsb-app-coordinator')
        env = coordinator['Environment']['Variables']
        queue = self.client('batch').describe_job_queues(jobQueues=[env['AWS_BATCH_JOB_QUEUE']])['jobQueues']
        definition = self.client('batch').describe_job_definitions(jobDefinitions=[env['AWS_BATCH_JOB_DEFINITION']])['jobDefinitions']
        compute = self.client('batch').describe_compute_environments(computeEnvironments=[x['computeEnvironment'] for x in queue[0]['computeEnvironmentOrder']])['computeEnvironments']
        active = {status: [j['jobId'] for page in self.client('batch').get_paginator('list_jobs').paginate(jobQueue=env['AWS_BATCH_JOB_QUEUE'], jobStatus=status) for j in page['jobSummaryList']] for status in ACTIVE}
        workflow_arn = self.client('lambda').get_function_configuration(FunctionName='qsb-app-api')['Environment']['Variables']['WORKFLOW_ARN']
        workflow = self.client('stepfunctions').describe_state_machine(stateMachineArn=workflow_arn)
        running = [x['executionArn'] for page in self.client('stepfunctions').get_paginator('list_executions').paginate(stateMachineArn=workflow_arn, statusFilter='RUNNING') for x in page['executions']]
        persist(self.directory / 'live-runtime-private.json', {'coordinatorEnv': env, 'apiWorkflow': workflow_arn,
            'queue': queue, 'definition': definition, 'computeEnvironments': compute,
            'activeJobs': active, 'workflow': workflow, 'runningExecutions': running}, exclusive=True)
        print(dump({'activeBatchJobs': sum(map(len, active.values())), 'runningProductionExecutions': len(running), 'servedRelease': env['SOLVER_RELEASE_ID']}).strip())

    def prepare(self):
        if self.state:
            raise RuntimeError('Never restart an existing campaign')
        source = clean_source()
        subprocess.run(['node', '--import', 'tsx', 'ops/pqb-serving/fixture.ts', 'validate', str(self.directory)], cwd=ROOT,
            env={**os.environ, 'QSB_NETWORK': 'mainnet'}, check=True)
        fixture = json.loads((self.directory / 'public-fixture.json').read_text())
        snapshot = json.loads((self.directory / 'live-runtime-private.json').read_text())
        manifest = json.loads((ROOT / 'terraform/.build/manifest.json').read_text())
        if manifest['commit'] != source or not manifest['clean'] or manifest['identities']['solver']['id'] != fixture['descriptor']['id']:
            raise RuntimeError('Clean exact PQB build manifest required')
        enrolled = json.loads((ROOT / 'src/lib/releases/qsb-solver-pqb-aws-sm86-v0-1-0.json').read_text())
        if fixture['descriptor'] != enrolled:
            raise RuntimeError('Fixture descriptor differs from the enrolled immutable release')
        for name, digest in manifest['files'].items():
            if hashlib.sha256((ROOT / 'terraform/.build' / name).read_bytes()).hexdigest() != digest:
                raise RuntimeError('Build artifact hash mismatch: ' + name)
        if any(snapshot['activeJobs'].values()) or snapshot['runningExecutions']:
            raise RuntimeError('Baseline must be drained')
        capacity_plan = self.directory / 'capacity-plan.json'
        capacity = None
        if capacity_plan.exists():
            from capacity import Capacity
            capacity = Capacity(self)
            if (capacity.plan['sourceCommit'] != source or capacity.plan['productionQueue'] != snapshot['queue'][0]
                or capacity.plan['expiresAt'] < time.time() + 5 * 3600):
                raise RuntimeError('Capacity plan is stale or differs from the source/baseline')
            capacity.check_grant()
        groups = snapshot['computeEnvironments'][0]['computeResources']['securityGroupIds']
        baseline = self.client('ec2').describe_instances(Filters=[{'Name': 'instance.group-id', 'Values': groups}])
        persist(self.directory / 'instance-baseline.json', baseline, exclusive=True)
        token = uuid.uuid4().hex[:12]
        name = 'qsb-pqb-v-' + token
        prepared_at = int(time.time())
        self.state = {'format': 'pqb-serving-campaign-v1', 'name': name, 'sourceCommit': source,
            'operatorHash': hashlib.sha256(dump(self.config).encode()).hexdigest(), 'createdAt': prepared_at,
            'deadline': prepared_at + 4 * 3600, 'reservedUsd': 200, 'reservationStatus': 'reserved',
            'preflightGpuSeconds': 900, 'solveGpuSeconds': 540000, 'fixtureSha256': hashlib.sha256((self.directory / 'public-fixture.json').read_bytes()).hexdigest(),
            'coordinatorSha256': manifest['files']['coordinator.zip'], 'apiArtifactSha256': manifest['files']['api.zip'], 'descriptor': fixture['descriptor'],
            'queue': snapshot['coordinatorEnv']['AWS_BATCH_JOB_QUEUE'], 'bucket': snapshot['coordinatorEnv']['AWS_BATCH_JOB_BUCKET'],
            'tables': [name + '-preflight', name + '-solve'], 'roles': [name + '-' + n for n in ['coordinator', 'workflow', 'deadline', 'scheduler']],
            'function': name + '-coordinator', 'cleanupFunction': name + '-deadline', 'workflow': name,
            'schedule': name + '-deadline', 'phase': 'prepared'}
        if capacity:
            self.state['capacity'] = {'planSha256': hashlib.sha256(capacity_plan.read_bytes()).hexdigest(), 'status': 'planned'}
            self.state['queue'] = capacity.plan['queueArn']
            self.state['watchdogSchedule'] = name + '-watchdog'
        retained = self.directory / 'build-artifacts'; retained.mkdir()
        for name in ['manifest.json', 'api.zip', 'coordinator.zip', 'reference.zip', 'webhooks.zip']:
            shutil.copyfile(ROOT / 'terraform/.build' / name, retained / name)
            with open(retained / name, 'rb') as artifact:
                os.fsync(artifact.fileno())
        persist(self.state_path, self.state, exclusive=True)
        self.validate_scope()
        print(dump({'prepared': self.state['name'], 'deadline': self.state['deadline'], 'reservedUsd': 200}).strip())

    def before_deadline(self):
        if time.time() > self.state['deadline'] - 1200:
            raise RuntimeError('Too little of the fixed deadline remains; stop and collect')
        if clean_source() != self.state['sourceCommit']:
            raise RuntimeError('Campaign source changed')
        if hashlib.sha256((self.directory / 'public-fixture.json').read_bytes()).hexdigest() != self.state['fixtureSha256']:
            raise RuntimeError('Public fixture binding changed')

    def mirror(self):
        self.before_deadline()
        descriptor = self.state['descriptor']
        source = descriptor['image']
        registry = f'{self.account}.dkr.ecr.{self.region}.amazonaws.com'
        dest = registry + '/qsb-solver:' + self.state['name']
        record = self.directory / 'mirror.intent.json'
        persist(record, {'source': source, 'destination': dest, 'sourceCommit': self.state['sourceCommit']}, exclusive=True)
        # Registry credentials exist only in this process and its private ephemeral Docker config.
        import tempfile
        with tempfile.TemporaryDirectory(prefix='qsb-registry-') as temporary:
            os.chmod(temporary, 0o700)
            env = {**os.environ, 'DOCKER_CONFIG': temporary}
            auth = self.client('ecr').get_authorization_token()['authorizationData'][0]
            username, password = base64.b64decode(auth['authorizationToken']).decode().split(':', 1)
            subprocess.run(['crane', 'auth', 'login', registry, '-u', username, '--password-stdin'], input=password.encode(), env=env, check=True, capture_output=True, timeout=60)
            del auth, password
            with open(self.directory / 'mirror.log', 'wb') as log:
                subprocess.run(['gh', 'attestation', 'verify', 'oci://' + source, '--repo', 'starknet-innovation/qsb-solver',
                    '--bundle-from-oci', '--signer-workflow', 'starknet-innovation/qsb-solver/.github/workflows/pqb-qualify.yml',
                    '--source-digest', descriptor['kernelCommit'], '--deny-self-hosted-runners', '--format', 'json'], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=180)
                subprocess.run(['crane', 'copy', source, dest], env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=900)
            expected = source.split('@')[1]
            actual = subprocess.check_output(['crane', 'digest', dest], env=env, text=True, timeout=60).strip()
            if actual != expected:
                raise RuntimeError('ECR did not preserve the immutable registry index')
            raw = subprocess.check_output(['crane', 'manifest', dest], env=env, timeout=60)
            if 'sha256:' + hashlib.sha256(raw).hexdigest() != expected:
                raise RuntimeError('Raw ECR index hash mismatch')
            (self.directory / 'ecr-index.json').write_bytes(raw)
        self.state['image'] = registry + '/qsb-solver@' + expected
        self.state['mirrorTag'] = self.state['name']
        self.save()
        persist(self.directory / 'mirror.response.json', {'digest': actual, 'verified': True}, exclusive=True)

    def deploy(self):
        self.before_deadline()
        state = self.state
        snapshot = json.loads((self.directory / 'live-runtime-private.json').read_text())
        # Check the current shared configuration; never change it.
        queue = self.client('batch').describe_job_queues(jobQueues=[snapshot['queue'][0]['jobQueueArn']])['jobQueues'][0]
        if queue != snapshot['queue'][0]:
            # desired capacity is in the CE, not the queue: this comparison is intentionally exact.
            raise RuntimeError('Shared queue changed since the reviewed baseline')
        if state.get('capacity'):
            from capacity import Capacity
            capacity = Capacity(self); capacity.check_ready()
            capacity.verify_queue_inventory(capacity.queue_jobs())
        original = snapshot['definition'][0]
        params = {k: copy.deepcopy(original[k]) for k in ['jobDefinitionName', 'type', 'parameters', 'retryStrategy', 'containerProperties', 'timeout', 'propagateTags', 'platformCapabilities'] if k in original}
        params['containerProperties']['image'] = state['image']
        params['tags'] = {'Project': 'qsb-gpu', 'PqbValidation': state['name'], 'SourceCommit': state['sourceCommit']}
        definition = self.mutate('definition', 'batch', 'register_job_definition', **params)
        state['definition'] = definition['jobDefinitionArn']; self.save()
        boundary = f'arn:aws:iam::{self.account}:policy/qsb/bootstrap/qsb-runtime-boundary'
        tags = [{'Key': 'Project', 'Value': 'qsb-vault'}, {'Key': 'PqbValidation', 'Value': state['name']}, {'Key': 'SourceCommit', 'Value': state['sourceCommit']}]
        services = ['lambda.amazonaws.com', 'states.amazonaws.com', 'lambda.amazonaws.com', 'scheduler.amazonaws.com']
        for role, service in zip(state['roles'], services):
            self.mutate('role-' + role, 'iam', 'create_role', RoleName=role, Path='/qsb/runtime/', PermissionsBoundary=boundary,
                AssumeRolePolicyDocument=json.dumps({'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'Service': service}, 'Action': 'sts:AssumeRole'}]}), Tags=tags)
        for table in state['tables']:
            self.mutate('table-' + table, 'dynamodb', 'create_table', TableName=table, BillingMode='PAY_PER_REQUEST',
                AttributeDefinitions=[{'AttributeName': k, 'AttributeType': 'S'} for k in ['pk', 'sk']],
                KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'}, {'AttributeName': 'sk', 'KeyType': 'RANGE'}], Tags=tags)
        logs = ['/aws/lambda/' + state['function'], '/aws/lambda/' + state['cleanupFunction'], '/aws/vendedlogs/states/' + state['name']]
        state['logs'] = logs; self.save()
        for n, group in enumerate(logs):
            self.mutate('log-' + str(n), 'logs', 'create_log_group', logGroupName=group, tags={t['Key']: t['Value'] for t in tags})
            self.mutate('retention-' + str(n), 'logs', 'put_retention_policy', logGroupName=group, retentionInDays=7)
        def allow(actions, resources, **extra):
            return {'Effect': 'Allow', 'Action': actions, 'Resource': resources, **extra}
        table_arns = [self.arn('dynamodb', 'table/' + t) for t in state['tables']]
        read_batch = allow(['batch:DescribeJobs', 'batch:DescribeJobDefinitions', 'batch:DescribeJobQueues', 'batch:DescribeComputeEnvironments', 'batch:ListJobs'], '*')
        cancel = allow(['batch:CancelJob', 'batch:TerminateJob'], self.arn('batch', 'job/*'), Condition={'StringEquals': {'aws:ResourceTag/Project': 'qsb-gpu'}})
        log_policy = allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [self.arn('logs', 'log-group:' + g + ':*') for g in logs])
        policies = [
            [allow(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'], table_arns), read_batch, cancel, log_policy,
             allow(['batch:SubmitJob'], [state['queue'], state['definition']]),
             allow(['batch:TagResource'], [state['queue'], state['definition'], self.arn('batch', 'job/*')], Condition={'StringEquals': {'aws:RequestTag/Project': 'qsb-gpu'}, 'ForAllValues:StringEquals': {'aws:TagKeys': ['Project', 'QsbRequest', 'InputSha256']}}),
             allow(['s3:PutObject'], f"arn:aws:s3:::{state['bucket']}/inputs/*"), allow(['s3:GetObject'], f"arn:aws:s3:::{state['bucket']}/outputs/*")],
            [allow(['lambda:InvokeFunction'], self.arn('lambda', 'function:' + state['function'])), allow(['states:StartExecution'], self.arn('states', 'stateMachine:' + state['workflow'])),
             allow(['logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery', 'logs:DeleteLogDelivery', 'logs:ListLogDeliveries', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups'], '*')],
            [allow(['dynamodb:UpdateItem'], table_arns), read_batch, cancel, log_policy],
            [allow(['lambda:InvokeFunction'], self.arn('lambda', 'function:' + state['cleanupFunction']))]]
        for n, (role, statements) in enumerate(zip(state['roles'], policies)):
            self.mutate('policy-' + str(n), 'iam', 'put_role_policy', RoleName=role, PolicyName='validation', PolicyDocument=json.dumps({'Version': '2012-10-17', 'Statement': statements}))
        # IAM propagation is read-polled, not a retry of a create or paid submission.
        for table in state['tables']:
            self.client('dynamodb').get_waiter('table_exists').wait(TableName=table, WaiterConfig={'Delay': 2, 'MaxAttempts': 20})
        time.sleep(10)
        code = (ROOT / 'terraform/.build/coordinator.zip').read_bytes()
        if hashlib.sha256(code).hexdigest() != state['coordinatorSha256']:
            raise RuntimeError('Coordinator bundle changed')
        env = {k: v for k, v in snapshot['coordinatorEnv'].items() if k in ['GPU_EXECUTION_TIMEOUT_MS', 'GPU_WORKERS_MAX', 'GPU_WORKERS_MIN', 'MAX_JOB_GPU_SECONDS']}
        env.update(TABLE_NAME=state['tables'][0], QSB_NETWORK='mainnet', SOLVER_RELEASE_ID=state['descriptor']['id'], QSB_MAINNET_ENABLED=snapshot['coordinatorEnv']['QSB_MAINNET_ENABLED'], REFERENCE_FUNCTION='public-pqb-in-process',
            AWS_BATCH_JOB_QUEUE=state['queue'], AWS_BATCH_JOB_DEFINITION=state['definition'], AWS_BATCH_JOB_BUCKET=state['bucket'],
            QSB_OWNER_ALLOWLIST=json.loads((self.directory / 'public-fixture.json').read_text())['event']['owner'], QSB_OWNER_MAX_GPU_SECONDS=str(state['preflightGpuSeconds']))
        state['coordinatorEnv'] = env; self.save()
        common = {'Runtime': 'nodejs22.x', 'Architectures': ['arm64'], 'Handler': 'index.handler', 'Timeout': 90, 'MemorySize': 512}
        response = self.mutate('function', 'lambda', 'create_function', FunctionName=state['function'], Role=self.iam(state['roles'][0]), Code={'ZipFile': code}, Environment={'Variables': env}, Tags={t['Key']: t['Value'] for t in tags}, **common)
        if base64.b64decode(response['CodeSha256']).hex() != state['coordinatorSha256']:
            raise RuntimeError('Deployed coordinator bytes differ')
        fixture = json.loads((self.directory / 'public-fixture.json').read_text())
        settings = {'deadline': state['deadline'], 'tables': state['tables'], 'pk': fixture['rows'][1]['pk'], 'sk': fixture['rows'][1]['sk'], 'queue': state['queue'], 'definition': state['definition']}
        if state.get('capacity'):
            settings['watchdogMaxAgeSeconds'] = 1800
        zip_bytes = io.BytesIO()
        with zipfile.ZipFile(zip_bytes, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('deadline.py', (ROOT / 'ops/pqb-serving/deadline.py').read_bytes())
        self.mutate('deadline-function', 'lambda', 'create_function', FunctionName=state['cleanupFunction'], Runtime='python3.13', Architectures=['arm64'], Handler='deadline.handler', Role=self.iam(state['roles'][2]), Timeout=180, MemorySize=128, Code={'ZipFile': zip_bytes.getvalue()}, Environment={'Variables': {'SETTINGS': json.dumps(settings)}}, Tags={t['Key']: t['Value'] for t in tags})
        asl = json.loads(snapshot['workflow']['definition'])
        asl['States']['CoordinateSearch']['Resource'] = self.arn('lambda', 'function:' + state['function'])
        asl['States']['ContinueSearch']['Parameters']['StateMachineArn'] = self.arn('states', 'stateMachine:' + state['workflow'])
        asl['TimeoutSeconds'] = 4 * 3600
        state['asl'] = asl; self.save()
        self.mutate('workflow', 'stepfunctions', 'create_state_machine', name=state['workflow'], definition=json.dumps(asl), roleArn=self.iam(state['roles'][1]), type='STANDARD',
            loggingConfiguration={'level': 'ALL', 'includeExecutionData': True, 'destinations': [{'cloudWatchLogsLogGroup': {'logGroupArn': self.arn('logs', 'log-group:' + logs[2]) + ':*'}}]}, tags=[{'key': t['Key'], 'value': t['Value']} for t in tags])
        deadline = datetime.fromtimestamp(state['deadline'], timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
        self.mutate('schedule', 'scheduler', 'create_schedule', Name=state['schedule'], ScheduleExpression='at(' + deadline + ')', ScheduleExpressionTimezone='UTC', FlexibleTimeWindow={'Mode': 'OFF'},
            Target={'Arn': self.arn('lambda', 'function:' + state['cleanupFunction']), 'RoleArn': self.iam(state['roles'][3]), 'Input': '{}', 'RetryPolicy': {'MaximumEventAgeInSeconds': 3600, 'MaximumRetryAttempts': 10}})
        check = self.client('scheduler').get_schedule(Name=state['schedule'])
        if check['State'] != 'ENABLED' or check['Target']['Arn'] != self.arn('lambda', 'function:' + state['cleanupFunction']):
            raise RuntimeError('Independent deadline not armed')
        persist(self.directory / 'armed-deadline.json', check, exclusive=True)
        if state.get('capacity'):
            self.mutate('watchdog-schedule', 'scheduler', 'create_schedule', Name=state['watchdogSchedule'],
                ScheduleExpression='rate(5 minutes)', ScheduleExpressionTimezone='UTC', FlexibleTimeWindow={'Mode': 'OFF'},
                StartDate=datetime.fromtimestamp(state['createdAt'] + 300, timezone.utc), EndDate=datetime.fromtimestamp(state['deadline'], timezone.utc),
                Target={'Arn': self.arn('lambda', 'function:' + state['cleanupFunction']), 'RoleArn': self.iam(state['roles'][3]),
                    'Input': '{}', 'RetryPolicy': {'MaximumEventAgeInSeconds': 3600, 'MaximumRetryAttempts': 10}})
            watchdog = self.client('scheduler').get_schedule(Name=state['watchdogSchedule'])
            if watchdog['State'] != 'ENABLED' or watchdog['Target']['Arn'] != self.arn('lambda', 'function:' + state['cleanupFunction']):
                raise RuntimeError('Isolated age watchdog not armed')
            persist(self.directory / 'armed-watchdog.json', watchdog, exclusive=True)
        state['phase'] = 'armed'; self.save()

    @staticmethod
    def check_function(actual, expected):
        for field in ['CodeSha256', 'Role', 'Runtime', 'Architectures', 'Handler', 'Timeout', 'MemorySize']:
            if actual.get(field) != expected.get(field):
                raise RuntimeError('Deployed function identity changed: ' + field)
        if actual.get('Environment', {}).get('Variables', {}) != expected.get('Environment', {}).get('Variables', {}):
            raise RuntimeError('Deployed function environment changed')
        defaults = {'Layers': [], 'FileSystemConfigs': [], 'KMSKeyArn': '', 'PackageType': 'Zip'}
        for field, default in defaults.items():
            if actual.get(field, default) != expected.get(field, default):
                raise RuntimeError('Deployed function runtime configuration changed: ' + field)
        for field, defaults in {
            'VpcConfig': {'SubnetIds': [], 'SecurityGroupIds': [], 'VpcId': '', 'Ipv6AllowedForDualStack': False},
            'DeadLetterConfig': {'TargetArn': ''}, 'TracingConfig': {'Mode': 'PassThrough'},
            'EphemeralStorage': {'Size': 512}, 'SnapStart': {'ApplyOn': 'None', 'OptimizationStatus': 'Off'},
        }.items():
            if {**defaults, **actual.get(field, {})} != {**defaults, **expected.get(field, {})}:
                raise RuntimeError('Deployed function runtime configuration changed: ' + field)
        log_defaults = {'LogFormat': 'Text', 'LogGroup': '/aws/lambda/' + expected['FunctionName']}
        if {**log_defaults, **actual.get('LoggingConfig', {})} != {**log_defaults, **expected.get('LoggingConfig', {})}:
            raise RuntimeError('Deployed function logging configuration changed')

    @staticmethod
    def check_workflow(actual, expected):
        if actual.get('status') != 'ACTIVE' or actual.get('type') != expected['type'] or actual.get('roleArn') != expected['roleArn']:
            raise RuntimeError('Deployed state machine identity changed')
        if json.loads(actual['definition']) != json.loads(expected['definition']) or actual.get('loggingConfiguration') != expected['loggingConfiguration']:
            raise RuntimeError('Deployed workflow definition or logging changed')
        if actual.get('tracingConfiguration', {}).get('enabled', False) or actual.get('encryptionConfiguration', {}).get('type', 'AWS_OWNED_KEY') != 'AWS_OWNED_KEY':
            raise RuntimeError('Deployed workflow tracing or encryption changed')

    def check_coordinator(self, environment):
        recorded = json.loads((self.directory / 'requests/function.response.json').read_text())['result']
        expected = dict(recorded, Environment={'Variables': environment})
        actual = self.client('lambda').get_function_configuration(FunctionName=self.state['function'])
        self.check_function(actual, expected)

    def check_runtime_roles(self):
        for n, role in enumerate(self.state['roles']):
            request = json.loads((self.directory / ('requests/role-' + role + '.intent.json')).read_text())['params']
            actual = self.client('iam').get_role(RoleName=role)['Role']
            if actual['PermissionsBoundary']['PermissionsBoundaryArn'] != request['PermissionsBoundary'] or actual['AssumeRolePolicyDocument'] != json.loads(request['AssumeRolePolicyDocument']):
                raise RuntimeError('Dedicated role trust or boundary changed')
            expected = json.loads((self.directory / ('requests/policy-' + str(n) + '.intent.json')).read_text())['params']
            policy = self.client('iam').get_role_policy(RoleName=role, PolicyName='validation')['PolicyDocument']
            if policy != json.loads(expected['PolicyDocument']):
                raise RuntimeError('Dedicated runtime policy changed')
            if self.client('iam').list_role_policies(RoleName=role)['PolicyNames'] != ['validation'] or self.client('iam').list_attached_role_policies(RoleName=role)['AttachedPolicies']:
                raise RuntimeError('Unexpected extra runtime policy')

    def start(self, phase):
        from boto3.dynamodb.types import TypeSerializer
        self.before_deadline()
        if phase not in ('preflight', 'solve') or self.state['phase'] not in ('armed', 'preflight-passed'):
            raise RuntimeError('Invalid phase transition')
        if phase == 'solve' and self.state['phase'] != 'preflight-passed':
            raise RuntimeError('Require the collected native preflight before the full solve')
        if phase == 'preflight' and self.state['phase'] != 'armed':
            raise RuntimeError('Never restart the preflight')
        if self.state.get('capacity'):
            from capacity import Capacity
            capacity = Capacity(self); capacity.check_ready()
            capacity.verify_queue_inventory(capacity.queue_jobs())
        schedule = self.client('scheduler').get_schedule(Name=self.state['schedule'])
        armed = json.loads((self.directory / 'armed-deadline.json').read_text())
        if schedule['State'] != 'ENABLED' or schedule['ScheduleExpression'] != armed['ScheduleExpression'] or schedule['Target'] != armed['Target']:
            raise RuntimeError('Independent deadline configuration changed')
        if self.state.get('capacity'):
            watchdog = self.client('scheduler').get_schedule(Name=self.state['watchdogSchedule'])
            armed_watchdog = json.loads((self.directory / 'armed-watchdog.json').read_text())
            fields = ['State', 'ScheduleExpression', 'ScheduleExpressionTimezone', 'Target', 'StartDate', 'EndDate', 'FlexibleTimeWindow']
            if watchdog['State'] != 'ENABLED' or dump({k: watchdog.get(k) for k in fields}) != dump({k: armed_watchdog.get(k) for k in fields}):
                raise RuntimeError('Isolated age watchdog configuration changed')
        deadline_function = self.client('lambda').get_function_configuration(FunctionName=self.state['cleanupFunction'])
        recorded = json.loads((self.directory / 'requests/deadline-function.response.json').read_text())['result']
        self.check_function(deadline_function, recorded)
        if json.loads(recorded['Environment']['Variables']['SETTINGS'])['deadline'] != self.state['deadline']:
            raise RuntimeError('Campaign deadline differs from the armed cleanup receipt')
        self.check_runtime_roles()
        self.check_coordinator(self.state['coordinatorEnv'])
        workflow = self.client('stepfunctions').describe_state_machine(stateMachineArn=self.arn('states', 'stateMachine:' + self.state['workflow']))
        requested = json.loads((self.directory / 'requests/workflow.intent.json').read_text())['params']
        self.check_workflow(workflow, requested)
        n = int(phase == 'solve')
        for status in ACTIVE:
            for page in self.client('batch').get_paginator('list_jobs').paginate(jobQueue=self.state['queue'], jobStatus=status):
                if page['jobSummaryList']:
                    raise RuntimeError('The shared queue is not drained; do not start validation')
        if n:
            env = dict(self.state['coordinatorEnv'], TABLE_NAME=self.state['tables'][n], QSB_OWNER_MAX_GPU_SECONDS=str(self.state['solveGpuSeconds']))
            self.mutate('solve-environment', 'lambda', 'update_function_configuration', FunctionName=self.state['function'], Environment={'Variables': env})
            self.client('lambda').get_waiter('function_updated_v2').wait(FunctionName=self.state['function'], WaiterConfig={'Delay': 2, 'MaxAttempts': 20})
            self.check_coordinator(env)
        else:
            self.client('lambda').get_waiter('function_active_v2').wait(FunctionName=self.state['function'], WaiterConfig={'Delay': 2, 'MaxAttempts': 20})
            self.check_coordinator(self.state['coordinatorEnv'])
        fixture = json.loads((self.directory / 'public-fixture.json').read_text(), parse_float=Decimal)
        serialize = TypeSerializer().serialize
        for i, row in enumerate(fixture['rows']):
            self.mutate(phase + '-row-' + str(i), 'dynamodb', 'put_item', TableName=self.state['tables'][n], Item={k: serialize(v) for k, v in row.items()}, ConditionExpression='attribute_not_exists(pk)')
        # The intent and budget reservation are durable before this can invoke paid work.
        result = self.mutate(phase + '-execution', 'stepfunctions', 'start_execution', stateMachineArn=self.arn('states', 'stateMachine:' + self.state['workflow']), name=phase + '-' + self.state['name'], input=json.dumps(fixture['event']))
        self.state[phase + 'Execution'] = result['executionArn']; self.state['phase'] = phase + '-running'; self.save()
        print(dump({'phase': self.state['phase'], 'deadline': self.state['deadline']}).strip())

    def native_jobs(self):
        if not self.state.get('definition'):
            return []
        if self.state.get('capacity', {}).get('queueRemoved'):
            ids = self.state.get('knownJobIds', [])
            jobs = []
            for offset in range(0, len(ids), 100):
                jobs += self.client('batch').describe_jobs(jobs=ids[offset:offset + 100])['jobs']
            if sorted(j['jobId'] for j in jobs) != sorted(ids) or any(j['jobDefinition'] != self.state['definition'] or j['jobQueue'] != self.state['queue'] for j in jobs):
                raise RuntimeError('Recorded work after queue deletion is incomplete or changed')
            return jobs
        ids = set()
        for status in (*ACTIVE, 'SUCCEEDED', 'FAILED'):
            for page in self.client('batch').get_paginator('list_jobs').paginate(jobQueue=self.state['queue'], jobStatus=status):
                ids.update(j['jobId'] for j in page['jobSummaryList'])
        jobs = []
        ids = sorted(ids)
        for offset in range(0, len(ids), 100):
            jobs += [j for j in self.client('batch').describe_jobs(jobs=ids[offset:offset + 100])['jobs'] if j['jobDefinition'] == self.state['definition']]
        return jobs

    def collect(self):
        from boto3.dynamodb.types import TypeDeserializer
        if self.state.get('capacity'):
            from capacity import Capacity
            try:
                Capacity(self).check_ready()
            except Exception:
                self.stop(reason='Validation capacity changed; stop and reconcile')
                raise
        phase = 'solve' if self.state['phase'].startswith('solve') else 'preflight'
        n = int(phase == 'solve')
        fixture = json.loads((self.directory / 'public-fixture.json').read_text())
        deserialize = TypeDeserializer().deserialize
        row = self.client('dynamodb').get_item(TableName=self.state['tables'][n], Key={k: {'S': fixture['rows'][1][k]} for k in ['pk', 'sk']}, ConsistentRead=True).get('Item')
        if not row:
            raise RuntimeError('No public fixture row')
        row = {k: deserialize(v) for k, v in row.items()}
        stamp = str(time.time_ns())
        persist(self.directory / (phase + '-job-' + stamp + '.json'), row, exclusive=True)
        jobs = self.native_jobs()
        persist(self.directory / ('batch-' + stamp + '.json'), jobs, exclusive=True)
        self.state['knownJobIds'] = sorted(set(self.state.get('knownJobIds', [])) | {j['jobId'] for j in jobs})
        self.save()
        unexpected = [j['jobId'] for j in jobs if j['status'] == 'FAILED' and j.get('statusReason') != 'QSB operator/coordinator cancellation']
        if unexpected:
            self.stop(reason='Unexpected native failure observed during public validation')
            persist(self.directory / ('unexpected-failure-' + stamp + '.json'), {'jobs': unexpected, 'stopped': True}, exclusive=True)
            self.collect_artifacts(jobs, stamp)
            raise RuntimeError('Unexpected native failure observed; assessment paused and drained')
        executions = [x for page in self.client('stepfunctions').get_paginator('list_executions').paginate(stateMachineArn=self.arn('states', 'stateMachine:' + self.state['workflow'])) for x in page['executions']]
        persist(self.directory / ('executions-' + stamp + '.json'), executions, exclusive=True)
        status = row['job']['status']
        preflight_budget_stop = phase == 'preflight' and status == 'paused' and row['job'].get('error') == 'Owner GPU-time budget reached. Further GPU work needs a reviewed budget change.'
        if any(e['status'] in ('FAILED', 'TIMED_OUT', 'ABORTED') for e in executions) or (status not in ('queued', 'searching', 'awaiting_authorization') and not preflight_budget_stop) or ('unknown' in row['job'].get('error', '').lower()):
            self.stop(reason='Coordinator workflow halted or requires reconciliation during public validation')
            self.collect_artifacts(jobs, stamp)
            raise RuntimeError('Coordinator halted unexpectedly; assessment paused and drained')
        print(dump({'phase': phase, 'status': status, 'stage': row['job']['stage'], 'submissions': row['job'].get('gpuSubmissions'), 'jobs': {s: sum(j['status'] == s for j in jobs) for s in (*ACTIVE, 'SUCCEEDED', 'FAILED')}, 'workflowStatuses': [x['status'] for x in executions]}).strip())
        terminal = executions and all(x['status'] != 'RUNNING' for x in executions)
        active = any(j['status'] in ACTIVE for j in jobs)
        try:
            self.collect_artifacts(jobs, stamp)
        except Exception:
            self.stop(reason='Public validation collection failed; retain and reconcile evidence')
            raise
        for j in jobs:
            output = self.directory / 'objects' / ('outputs__' + j['jobId'] + '.json')
            if (j['status'] == 'SUCCEEDED' and not output.exists()) or (output.exists() and json.loads(output.read_text())['output']['status'] != 'completed'):
                self.stop(reason='Incomplete native result observed during public validation')
                raise RuntimeError('Incomplete native result observed; assessment paused and drained')
        expected_jobs = int(row['job'].get('gpuSubmissions', 0)) + (len(self.state.get('preflightJobIds', [])) if phase == 'solve' else 0)
        if terminal and not active and len(jobs) != expected_jobs:
            raise RuntimeError('Paid submission count differs from reconciled native job inventory')
        if phase == 'preflight' and terminal and not active and status == 'paused' and row['job'].get('error') == 'Owner GPU-time budget reached. Further GPU work needs a reviewed budget change.' and row['job'].get('gpuSubmissions') == 1 and len(jobs) == 1 and jobs[0]['status'] == 'SUCCEEDED':
            subprocess.run(['node', '--import', 'tsx', 'ops/pqb-serving/fixture.ts', 'audit', str(self.directory), 'native-index-' + stamp + '.json'], cwd=ROOT, env={**os.environ, 'QSB_NETWORK': 'mainnet'}, check=True, timeout=360)
            self.state['preflightJobIds'] = [j['jobId'] for j in jobs]
            self.state['phase'] = 'preflight-passed'; self.save()
        if phase == 'solve' and terminal and not active and status == 'awaiting_authorization':
            subprocess.run(['node', '--import', 'tsx', 'ops/pqb-serving/fixture.ts', 'audit', str(self.directory), 'native-index-' + stamp + '.json'], cwd=ROOT, env={**os.environ, 'QSB_NETWORK': 'mainnet'}, check=True, timeout=360)
            persist(self.directory / 'final-job.json', row, exclusive=True)
            self.state['phase'] = 'solve-complete'; self.save()

    def collect_artifacts(self, jobs, stamp, allow_missing=False):
        # Original public objects are copied without exposing them in console output.
        objects = self.directory / 'objects'; objects.mkdir(exist_ok=True)
        logs = self.directory / 'logs'; logs.mkdir(exist_ok=True)
        s3 = self.client('s3')
        for job in jobs:
            env = {v['name']: v['value'] for v in job.get('container', {}).get('environment', [])}
            key = env.get('QSB_INPUT_KEY')
            if not key:
                raise RuntimeError('Campaign job lacks its immutable input identity')
            for object_key in [key, 'outputs/' + job['jobId'] + '.json']:
                target = objects / object_key.replace('/', '__')
                if target.exists():
                    continue
                try:
                    with s3.get_object(Bucket=self.state['bucket'], Key=object_key)['Body'] as body:
                        data = body.read()
                except s3.exceptions.NoSuchKey:
                    continue
                if object_key == key and hashlib.sha256(data).hexdigest() != env.get('QSB_INPUT_SHA256'):
                    raise RuntimeError('Native input object differs from its submitted SHA256')
                with open(target, 'xb') as out:
                    out.write(data); out.flush(); os.fsync(out.fileno())
                head = s3.head_object(Bucket=self.state['bucket'], Key=object_key)
                persist(objects / (target.name + '.head.json'), head, exclusive=True)
            stream = job.get('container', {}).get('logStreamName')
            if stream:
                try:
                    snapshot = json.loads((self.directory / 'live-runtime-private.json').read_text())
                    group = snapshot['definition'][0]['containerProperties']['logConfiguration']['options']['awslogs-group']
                    pages = list(self.client('logs').get_paginator('filter_log_events').paginate(
                        logGroupName=group, logStreamNames=[stream]))
                except self.client('logs').exceptions.ResourceNotFoundException:
                    pages = []
                persist(logs / (job['jobId'] + '-' + stamp + '.json'), pages, exclusive=True)
        fixture = json.loads((self.directory / 'public-fixture.json').read_text())
        manifest_hash = fixture['rows'][1]['job']['manifestHash']
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=self.state['bucket'], Prefix='inputs/'):
            for obj in page.get('Contents', []):
                if obj['LastModified'].timestamp() < self.state['createdAt']:
                    continue
                target = objects / obj['Key'].replace('/', '__')
                if target.exists():
                    continue
                with s3.get_object(Bucket=self.state['bucket'], Key=obj['Key'])['Body'] as body:
                    data = body.read()
                value = json.loads(data)
                if value.get('input', {}).get('manifestHash') != manifest_hash:
                    continue
                with open(target, 'xb') as out:
                    out.write(data); out.flush(); os.fsync(out.fileno())
                persist(objects / (target.name + '.head.json'), s3.head_object(Bucket=self.state['bucket'], Key=obj['Key']), exclusive=True)
        persist(self.directory / ('native-index-' + stamp + '.json'), {'image': self.state.get('image'), 'definition': self.state.get('definition'),
            'jobs': jobs, 'startupLogs': {j['jobId']: 'logs/' + j['jobId'] + '-' + stamp + '.json' for j in jobs if j.get('container', {}).get('logStreamName')}}, exclusive=True)
        # Managed workflow ALL logs retain transitions even where the operator cannot read execution data APIs.
        for index, group in enumerate(self.state.get('logs', [])):
            try:
                pages = list(self.client('logs').get_paginator('filter_log_events').paginate(logGroupName=group))
            except self.client('logs').exceptions.ResourceNotFoundException:
                if not allow_missing:
                    raise
                pages = []
            persist(logs / (str(index) + '-' + stamp + '.json'), pages, exclusive=True)
        snapshot = json.loads((self.directory / 'live-runtime-private.json').read_text())
        groups = snapshot['computeEnvironments'][0]['computeResources']['securityGroupIds']
        instances = self.client('ec2').describe_instances(Filters=[{'Name': 'instance.group-id', 'Values': groups}])
        persist(self.directory / ('instances-' + stamp + '.json'), instances, exclusive=True)
        if self.state.get('capacity'):
            from capacity import Capacity
            Capacity(self).collect(stamp)

    @staticmethod
    def rows_hash(rows):
        rows = sorted(rows, key=lambda r: (r['pk']['S'], r['sk']['S']))
        return hashlib.sha256(dump(rows).encode()).hexdigest()

    def optional_cleanup_resource(self, service, operation, **params):
        from botocore.exceptions import ClientError
        def read(client):
            try:
                return getattr(client, operation)(**params)
            except ClientError as error:
                if error.response['Error']['Code'] not in ('ResourceNotFoundException', 'StateMachineDoesNotExist', 'NoSuchEntity'):
                    raise
                return None
        try:
            return read(self.client(service))
        except ClientError as error:
            if service != 'iam' or operation != 'get_role' or error.response['Error']['Code'] not in ('AccessDenied', 'AccessDeniedException'):
                raise
            # A never-created role cannot resolve to the operator's runtime IAM path.
            # An explicit metadata-only read must verify absence; denial is not absence.
            if not hasattr(self, '_cleanup_metadata_iam'):
                from capacity import Capacity
                self._cleanup_metadata_iam = Capacity(self).metadata_session().client('iam', config=self.sdk_config)
            return read(self._cleanup_metadata_iam)

    def final_collect(self):
        started = bool(list((self.directory / 'requests').glob('*-execution.intent.json')))
        for intent in (self.directory / 'requests').glob('*.intent.json'):
            response = intent.with_name(intent.name.replace('.intent.json', '.response.json'))
            if not response.exists():
                raise RuntimeError('Uncertain mutation requires a separate reconciliation receipt before final cleanup: ' + intent.name)
        if not self.state.get('definition') and (self.directory / 'requests/definition.intent.json').exists():
            raise RuntimeError('Reconcile the uncertain definition identity before cleanup')
        optional = self.optional_cleanup_resource
        def owned(tags):
            if isinstance(tags, list):
                tags = {t.get('Key', t.get('key')): t.get('Value', t.get('value')) for t in tags}
            if tags.get('PqbValidation') != self.state['name']:
                raise RuntimeError('Refuse to collect/delete a resource without the campaign ownership tag')
        snapshot = {'tables': {}, 'functions': {}, 'roles': {}, 'logs': [], 'workflow': None, 'schedule': None, 'watchdogSchedule': None}
        row_hashes, ledger = {}, 0
        for name in self.state['tables']:
            table = optional('dynamodb', 'describe_table', TableName=name)
            if table is None:
                if started:
                    raise RuntimeError('An executed campaign table is missing; reconcile evidence')
                continue
            owned(self.client('dynamodb').list_tags_of_resource(ResourceArn=table['Table']['TableArn'])['Tags'])
            pages = list(self.client('dynamodb').get_paginator('scan').paginate(TableName=name, ConsistentRead=True))
            rows = [r for page in pages for r in page['Items']]
            for row in rows:
                if 'job' in row:
                    job = row['job']['M']
                    if job['status']['S'] in ('queued', 'searching') and started:
                        raise RuntimeError('Pause/drain the public fixture before final collection')
                    ledger += int(job.get('gpuSubmissions', {'N': '0'})['N'])
            row_hashes[name] = self.rows_hash(rows)
            snapshot['tables'][name] = {'description': table, 'pages': pages}
        jobs = self.native_jobs()
        if any(j['status'] in ACTIVE for j in jobs) or len(jobs) != ledger:
            raise RuntimeError('Paid work remains active or unreconciled; retain all evidence')
        self.state['knownJobIds'] = sorted(j['jobId'] for j in jobs); self.save()
        workflow = optional('stepfunctions', 'describe_state_machine', stateMachineArn=self.arn('states', 'stateMachine:' + self.state['workflow']))
        executions = []
        if workflow:
            owned(self.client('stepfunctions').list_tags_for_resource(resourceArn=workflow['stateMachineArn'])['tags'])
            executions = [x for page in self.client('stepfunctions').get_paginator('list_executions').paginate(stateMachineArn=workflow['stateMachineArn']) for x in page['executions']]
            if any(x['status'] == 'RUNNING' for x in executions):
                raise RuntimeError('Dedicated executions are not drained')
            snapshot['workflow'] = workflow
        elif started:
            raise RuntimeError('Executed workflow missing; reconcile history before removal')
        snapshot['executions'] = executions
        for name in [self.state['function'], self.state['cleanupFunction']]:
            config = optional('lambda', 'get_function_configuration', FunctionName=name)
            if config:
                owned(self.client('lambda').list_tags(Resource=self.arn('lambda', 'function:' + name))['Tags'])
                snapshot['functions'][name] = config
        for name in self.state['roles']:
            role = optional('iam', 'get_role', RoleName=name)
            if role:
                owned(role['Role'].get('Tags', []))
                names = self.client('iam').list_role_policies(RoleName=name)['PolicyNames']
                if set(names) - {'validation'} or self.client('iam').list_attached_role_policies(RoleName=name)['AttachedPolicies']:
                    raise RuntimeError('Unexpected policy on dedicated role; reconcile before deletion')
                snapshot['roles'][name] = {'role': role, 'policies': {n: self.client('iam').get_role_policy(RoleName=name, PolicyName=n) for n in names}}
        schedule = optional('scheduler', 'get_schedule', Name=self.state['schedule'])
        if schedule:
            if schedule['Target']['Arn'] != self.arn('lambda', 'function:' + self.state['cleanupFunction']) or schedule['Target']['RoleArn'] != self.iam(self.state['roles'][3]):
                raise RuntimeError('Unexpected schedule target; refuse deletion')
            snapshot['schedule'] = schedule
        if self.state.get('watchdogSchedule'):
            watchdog = optional('scheduler', 'get_schedule', Name=self.state['watchdogSchedule'])
            if watchdog:
                if watchdog['Target']['Arn'] != self.arn('lambda', 'function:' + self.state['cleanupFunction']) or watchdog['Target']['RoleArn'] != self.iam(self.state['roles'][3]):
                    raise RuntimeError('Unexpected watchdog target; refuse deletion')
                snapshot['watchdogSchedule'] = watchdog
        expected_logs = ['/aws/lambda/' + self.state['function'], '/aws/lambda/' + self.state['cleanupFunction'], '/aws/vendedlogs/states/' + self.state['name']]
        for group in expected_logs:
            found = [g for page in self.client('logs').get_paginator('describe_log_groups').paginate(logGroupNamePrefix=group) for g in page['logGroups'] if g['logGroupName'] == group]
            if found:
                owned(self.client('logs').list_tags_log_group(logGroupName=group)['tags'])
                snapshot['logs'].append(group)
        stamp = str(time.time_ns())
        self.collect_artifacts(jobs, stamp, allow_missing=not started)
        if executions:
            pages = json.loads((self.directory / ('logs/2-' + stamp + '.json')).read_text())
            events = [json.loads(e['message']) for p in pages for e in p['events']]
            expected_arns = {e['executionArn'] for e in executions}
            for execution in executions:
                history = [e for e in events if e.get('execution_arn') == execution['executionArn']]
                terminal = {'SUCCEEDED': 'ExecutionSucceeded', 'FAILED': 'ExecutionFailed', 'TIMED_OUT': 'ExecutionTimedOut', 'ABORTED': 'ExecutionAborted'}[execution['status']]
                ends = [int(e['id']) for e in history if e.get('type') == terminal]
                if not ends or {int(e['id']) for e in history} != set(range(1, max(ends) + 1)):
                    raise RuntimeError('Complete workflow event history not yet retained; collect again before removal')
            prefix = self.arn('states', 'execution:' + self.state['workflow'] + ':')
            referenced = set(re.findall(re.escape(prefix) + r'[A-Za-z0-9_-]+', dump(events)))
            if referenced - expected_arns:
                raise RuntimeError('Continuation execution is not yet reconciled')
        snapshot_path = self.directory / ('final-resources-' + stamp + '.json')
        persist(snapshot_path, snapshot, exclusive=True)
        paths = [snapshot_path, self.directory / ('native-index-' + stamp + '.json'), self.directory / ('instances-' + stamp + '.json'), self.directory / 'public-fixture.json']
        if self.state.get('capacity'):
            paths.append(self.directory / 'capacity-plan.json')
        for folder in ['requests', 'objects', 'logs', 'build-artifacts', 'capacity']:
            paths += [p for p in (self.directory / folder).rglob('*') if p.is_file()]
        files = {str(p.relative_to(self.directory)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
        receipt = {'format': 'pqb-serving-final-collection-v1', 'name': self.state['name'], 'sourceCommit': self.state['sourceCommit'],
            'resources': str(snapshot_path.relative_to(self.directory)), 'nativeJobIds': self.state['knownJobIds'],
            'executions': {x['executionArn']: x['status'] for x in executions}, 'rows': row_hashes, 'files': files}
        receipt_path = self.directory / ('final-collection-' + stamp + '.json')
        persist(receipt_path, receipt, exclusive=True)
        self.state['finalCollection'] = {'file': receipt_path.name, 'sha256': hashlib.sha256(receipt_path.read_bytes()).hexdigest()}; self.save()
        print(dump({'finalCollectionRetained': True, 'nativeJobs': len(jobs), 'executions': len(executions)}).strip())

    def checked_final_collection(self):
        binding = self.state.get('finalCollection')
        if not binding or not re.fullmatch(r'final-collection-[0-9]+\.json', binding['file']):
            raise RuntimeError('Require final_collect before any destructive removal')
        path = self.directory / binding['file']
        if hashlib.sha256(path.read_bytes()).hexdigest() != binding['sha256']:
            raise RuntimeError('Final collection receipt changed')
        receipt = json.loads(path.read_text())
        if receipt['name'] != self.state['name'] or receipt['sourceCommit'] != self.state['sourceCommit']:
            raise RuntimeError('Final collection identity differs')
        for name, expected in receipt['files'].items():
            original = (self.directory / name).resolve()
            if not original.is_relative_to(self.directory) or hashlib.sha256(original.read_bytes()).hexdigest() != expected:
                raise RuntimeError('Retained collection bytes changed or missing')
        return receipt, json.loads((self.directory / receipt['resources']).read_text())

    def remove(self):
        receipt, resources = self.checked_final_collection()
        if self.state.get('capacity') and self.state['capacity'].get('status') != 'removed-verified':
            raise RuntimeError('Verify isolated queue and pool cleanup first')
        jobs = self.native_jobs()
        if any(j['status'] in ACTIVE for j in jobs) or sorted(j['jobId'] for j in jobs) != receipt['nativeJobIds']:
            raise RuntimeError('Native work changed since final collection')
        executions = [x for page in self.client('stepfunctions').get_paginator('list_executions').paginate(
            stateMachineArn=self.arn('states', 'stateMachine:' + self.state['workflow'])) for x in page['executions']] if resources['workflow'] else []
        if {x['executionArn']: x['status'] for x in executions} != receipt['executions']:
            raise RuntimeError('Workflow state changed since final collection')
        for table, expected in receipt['rows'].items():
            rows = [r for page in self.client('dynamodb').get_paginator('scan').paginate(TableName=table, ConsistentRead=True) for r in page['Items']]
            if self.rows_hash(rows) != expected:
                raise RuntimeError('Public fixture data changed since final collection')
        # Only collected, uniquely bound public fixture objects are disposable.
        for index, head_path in enumerate(sorted((self.directory / 'objects').glob('*.head.json'))):
            key = head_path.name[:-10].replace('__', '/')
            if not re.fullmatch(r'(inputs|outputs)/[a-f0-9-]{36}\.json', key):
                raise RuntimeError('Unexpected collected object key')
            data = json.loads(head_path.with_name(head_path.name[:-10]).read_text())
            fixture = json.loads((self.directory / 'public-fixture.json').read_text())
            if key.startswith('inputs/'):
                if data['input']['manifestHash'] != fixture['rows'][1]['job']['manifestHash']:
                    raise RuntimeError('Refuse to delete an input for another manifest')
            elif data['jobId'] not in self.state['knownJobIds']:
                raise RuntimeError('Refuse to delete an output for another job')
            head = json.loads(head_path.read_text())
            params = {'Bucket': self.state['bucket'], 'Key': key}
            if 'VersionId' in head:
                params['VersionId'] = head['VersionId']
            self.mutate('remove-object-' + str(index), 's3', 'delete_object', **params)
        if resources['schedule']:
            self.mutate('remove-schedule', 'scheduler', 'delete_schedule', Name=self.state['schedule'])
        if resources.get('watchdogSchedule'):
            self.mutate('remove-watchdog', 'scheduler', 'delete_schedule', Name=self.state['watchdogSchedule'])
        if resources['workflow']:
            self.mutate('remove-workflow', 'stepfunctions', 'delete_state_machine', stateMachineArn=self.arn('states', 'stateMachine:' + self.state['workflow']))
        for name in resources['functions']:
            self.mutate('remove-function-' + name, 'lambda', 'delete_function', FunctionName=name)
        for table in resources['tables']:
            self.mutate('remove-table-' + table, 'dynamodb', 'delete_table', TableName=table)
        if self.state.get('definition'):
            self.mutate('remove-definition', 'batch', 'deregister_job_definition', jobDefinition=self.state['definition'])
        for role, metadata in resources['roles'].items():
            if 'validation' in metadata['policies']:
                self.mutate('remove-policy-' + role, 'iam', 'delete_role_policy', RoleName=role, PolicyName='validation')
            self.mutate('remove-role-' + role, 'iam', 'delete_role', RoleName=role)
        # Logs are retained locally, then only the dedicated log groups are removed. Shared Batch logs stay intact.
        for index, group in enumerate(resources['logs']):
            self.mutate('remove-logs-' + str(index), 'logs', 'delete_log_group', logGroupName=group)
        self.state['phase'] = 'removal-requested'; self.save()
        print('Removal requested; independent resource, instance and volume verification is still required.')

    def stop(self, reason='Public validation stopped by controller or operator'):
        import importlib.util
        spec = importlib.util.spec_from_file_location('pqb_deadline', ROOT / 'ops/pqb-serving/deadline.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        fixture = json.loads((self.directory / 'public-fixture.json').read_text())
        settings = {'tables': self.state['tables'], 'pk': fixture['rows'][1]['pk'], 'sk': fixture['rows'][1]['sk'], 'queue': self.state['queue'], 'definition': self.state['definition'], 'stopReason': reason}
        # A fresh explicit stop receipt; never retry a compute submission.
        stamp = str(time.time_ns())
        persist(self.directory / ('stop-' + stamp + '.intent.json'), settings, exclusive=True)
        result = module.drain({n: self.client(n) for n in ['batch', 'dynamodb']}, settings)
        persist(self.directory / ('stop-' + stamp + '.response.json'), result, exclusive=True)
        print(dump(result).strip())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['inspect', 'prepare', 'mirror', 'deploy', 'start', 'collect', 'final_collect', 'stop', 'remove'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--phase', choices=['preflight', 'solve'])
    args = parser.parse_args()
    campaign = Campaign(args.directory)
    if args.mode == 'start':
        campaign.start(args.phase)
    else:
        getattr(campaign, args.mode)()


if __name__ == '__main__':
    main()
