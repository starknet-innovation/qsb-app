"""Explicitly authorized idle-pool maintenance, using the original Batch ARNs only.

No IAM/network writes, direct EC2 launches or paid submissions. Restore the original
pool after independently collecting/draining the separate public-data campaign.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import time

from control import Campaign, ROOT, ACTIVE, clean_source, persist

PROFILE = json.loads((ROOT / 'server/aws-batch-validation.json').read_text())
RESOURCE_KEYS = ['type', 'allocationStrategy', 'minvCpus', 'maxvCpus', 'desiredvCpus',
                 'instanceTypes', 'subnets', 'securityGroupIds', 'instanceRole', 'tags',
                 'launchTemplate', 'ec2Configuration']


def creation(pool):
    return {'computeEnvironmentName': pool['computeEnvironmentName'], 'type': pool['type'],
            'state': 'DISABLED', 'serviceRole': pool['serviceRole'], 'tags': pool['tags'],
            'computeResources': {k: copy.deepcopy(pool['computeResources'][k])
                                 for k in RESOURCE_KEYS if k in pool['computeResources']}}


def queue_identity(queue):
    if queue is None:
        return None
    return {k: v for k, v in queue.items() if k not in ['state', 'status', 'statusReason', 'computeEnvironmentOrder']}


def queue_creation(queue):
    result = {k: copy.deepcopy(queue[k]) for k in ['jobQueueName', 'priority', 'computeEnvironmentOrder', 'tags',
              'jobStateTimeLimitActions', 'schedulingPolicyArn'] if k in queue}
    return dict(result, state='DISABLED')


def ready(pool, queue, target, baseline_queue):
    return (pool is not None and queue is not None and creation(pool) == target and pool['state'] == 'ENABLED' and pool['status'] == 'VALID'
            and queue['state'] == 'ENABLED' and queue['status'] == 'VALID'
            and queue_identity(queue) == queue_identity(baseline_queue)
            and queue['computeEnvironmentOrder'] == baseline_queue['computeEnvironmentOrder'])


def validate_plan(plan, config):
    if config != {'profile': 'qsb-operator-euw2', 'account': '237145860001', 'region': 'eu-west-2'}:
        raise RuntimeError('Only the existing London operator is supported')
    arn = 'arn:aws:batch:eu-west-2:237145860001:'
    pool, queue = plan['baselinePool'], plan['baselineQueue']
    if (pool['computeEnvironmentArn'] != arn + 'compute-environment/qsb-gpu'
        or pool['computeEnvironmentName'] != 'qsb-gpu' or pool['type'] != 'MANAGED'
        or pool['containerOrchestrationType'] != 'ECS' or pool['state'] != 'ENABLED' or pool['status'] != 'VALID'
        or pool['tags'].get('Project') != 'qsb-gpu'
        or pool['computeResources']['type'] != 'EC2'
        or pool['computeResources']['allocationStrategy'] != 'BEST_FIT'
        or pool['computeResources']['instanceTypes'] != ['g5.xlarge']
        or pool['computeResources']['minvCpus'] != 0 or pool['computeResources']['desiredvCpus'] != 0
        or pool['computeResources']['maxvCpus'] != 64
        or set(pool['computeResources']['subnets']) != {'subnet-0b9dbd06af28524de', 'subnet-0a4b5fdacb09d88ab'}
        or pool['computeResources']['launchTemplate'].get('version') != '1'
        or pool['serviceRole'] != 'arn:aws:iam::237145860001:role/aws-service-role/batch.amazonaws.com/AWSServiceRoleForBatch'
        or queue['jobQueueArn'] != arn + 'job-queue/qsb-gpu' or queue['state'] != 'ENABLED' or queue['status'] != 'VALID'
        or queue['computeEnvironmentOrder'] != [{'order': 1, 'computeEnvironment': pool['computeEnvironmentArn']}]
        or queue['tags'].get('Project') != 'qsb-gpu'):
        raise RuntimeError('Unexpected original pool or queue; refuse replacement')
    expected = creation(pool)
    if plan['restore'] != expected:
        raise RuntimeError('Original pool rollback payload changed')
    if plan['queueRestore'] != queue_creation(queue):
        raise RuntimeError('Original queue rollback payload changed')
    expected['computeResources'].update(allocationStrategy=PROFILE['allocationStrategy'], instanceTypes=[PROFILE['instanceType']])
    if plan['candidate'] != expected or PROFILE['gpuName'] != 'A10G' or PROFILE['vcpusPerHost'] != 8:
        raise RuntimeError('Candidate differs from the reviewed single-A10G profile')


def verify_binding(campaign, binding, source, snapshot):
    directory = Path(binding['directory']).resolve()
    plan_path = directory / 'shared-pool-plan.json'
    if hashlib.sha256(plan_path.read_bytes()).hexdigest() != binding['planSha256']:
        raise RuntimeError('Shared pool plan binding changed')
    plan = json.loads(plan_path.read_text())
    validate_plan(plan, campaign.config)
    if (plan['sourceCommit'] != source or binding['sourceCommit'] != source
        or json.loads((directory / 'shared-pool-status.json').read_text())['phase'] != 'candidate-ready'
        or snapshot['queue'][0]['computeEnvironmentOrder'] != plan['baselineQueue']['computeEnvironmentOrder']
        or queue_identity(snapshot['queue'][0]) != queue_identity(plan['baselineQueue'])
        or creation(snapshot['computeEnvironments'][0]) != plan['candidate']
        or snapshot['computeEnvironments'][0]['state'] != 'ENABLED'
        or snapshot['computeEnvironments'][0]['status'] != 'VALID'):
        raise RuntimeError('Shared pool candidate has not been verified')
    if (campaign.directory / 'capacity-plan.json').exists() or campaign.config.get('snfIsolation'):
        raise RuntimeError('Shared replacement cannot combine with another capacity mode')
    return binding


class SharedPool:
    def __init__(self, directory):
        self.c = Campaign(directory)
        if self.c.state:
            raise RuntimeError('Use a separate maintenance directory, never a campaign state')
        self.path = self.c.directory / 'shared-pool-plan.json'
        self.plan = json.loads(self.path.read_text()) if self.path.exists() else None
        if self.plan:
            validate_plan(self.plan, self.c.config)
            status = json.loads((self.c.directory / 'shared-pool-status.json').read_text())
            if status['planSha256'] != hashlib.sha256(self.path.read_bytes()).hexdigest():
                raise RuntimeError('Maintenance plan changed')
        self.batch = self.c.client('batch')
        import boto3
        metadata = boto3.Session(profile_name='qsb-viewonly-euw2', region_name='eu-west-2')
        if metadata.client('sts', config=self.c.read_sdk_config).get_caller_identity()['Account'] != self.c.account:
            raise RuntimeError('Metadata profile account mismatch')
        self.asg = metadata.client('autoscaling', config=self.c.read_sdk_config)

    def queue(self):
        queues = self.batch.describe_job_queues(jobQueues=['qsb-gpu'])['jobQueues']
        if len(queues) > 1:
            raise RuntimeError('Unexpected queue inventory')
        return queues[0] if queues else None

    def pool(self):
        pools = self.batch.describe_compute_environments(computeEnvironments=['qsb-gpu'])['computeEnvironments']
        if len(pools) > 1:
            raise RuntimeError('Unexpected compute environment inventory')
        return pools[0] if pools else None

    def idle(self):
        active = {status: [j for page in self.batch.get_paginator('list_jobs').paginate(jobQueue='qsb-gpu', jobStatus=status)
                           for j in page['jobSummaryList']] for status in ACTIVE} if self.queue() else {}
        api = self.c.client('lambda').get_function_configuration(FunctionName='qsb-app-api')
        workflow = api['Environment']['Variables']['WORKFLOW_ARN']
        executions = [e for page in self.c.client('stepfunctions').get_paginator('list_executions').paginate(
            stateMachineArn=workflow, statusFilter='RUNNING') for e in page['executions']]
        groups = self.plan['baselinePool']['computeResources']['securityGroupIds']
        instances = self.c.client('ec2').describe_instances(Filters=[{'Name': 'instance.group-id', 'Values': groups},
            {'Name': 'instance-state-name', 'Values': ['pending', 'running', 'stopping', 'stopped', 'shutting-down']}])
        groups = [g for page in self.asg.get_paginator('describe_auto_scaling_groups').paginate()
                  for g in page['AutoScalingGroups'] if g['AutoScalingGroupName'].startswith('AWSBatch-qsb-gpu-asg-')]
        record = {'activeJobs': active, 'runningProductionExecutions': executions, 'instances': instances, 'scalingGroups': groups}
        persist(self.c.directory / ('idle-' + str(time.time_ns()) + '.json'), record, exclusive=True)
        if (any(active.values()) or executions or any(r['Instances'] for r in instances['Reservations'])
            or any(g['DesiredCapacity'] != 0 or g['MinSize'] != 0 or g['Instances'] for g in groups)):
            raise RuntimeError('Shared pool is not idle; do not replace or terminate shared hosts')

    def status(self, phase):
        persist(self.c.directory / 'shared-pool-status.json', {'phase': phase,
            'planSha256': hashlib.sha256(self.path.read_bytes()).hexdigest()})

    def capture(self):
        if self.plan:
            raise RuntimeError('Never recapture a maintenance plan')
        pool, queue = self.pool(), self.queue()
        candidate = creation(pool)
        candidate['computeResources'].update(allocationStrategy=PROFILE['allocationStrategy'], instanceTypes=[PROFILE['instanceType']])
        self.plan = {'sourceCommit': clean_source(), 'createdAt': int(time.time()), 'baselinePool': pool,
                     'baselineQueue': queue, 'queueRestore': queue_creation(queue), 'restore': creation(pool), 'candidate': candidate}
        validate_plan(self.plan, self.c.config)
        self.idle()
        persist(self.path, self.plan, exclusive=True)
        self.status('planned')

    def wait(self, read, ready):
        # Bounded read polling; mutations never use a waiter or automatic retry.
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            actual = read()
            if ready(actual):
                return actual
            if actual and actual.get('status') == 'INVALID':
                raise RuntimeError('Batch resource INVALID; inspect before proceeding')
            time.sleep(5)
        raise RuntimeError('Batch transition pending; retain receipts and reconcile')

    def replace(self, restore=False):
        if clean_source() != self.plan['sourceCommit']:
            raise RuntimeError('Maintenance source changed')
        direction = 'restore' if restore else 'candidate'
        target = self.plan[direction]
        before = self.plan['candidate' if restore else 'restore']
        journal = self.c.directory / 'requests'
        checkpoint = self.c.directory / (direction + '-from.json')
        started = checkpoint.exists()
        if not started:
            if not restore and time.time() > self.plan['createdAt'] + 3600:
                raise RuntimeError('Maintenance plan is stale')
            pool, queue = self.pool(), self.queue()
            if restore:
                # A fresh rollback is permitted from known partial maintenance,
                # including a missing environment or the disabled original.
                intents = list(journal.glob('candidate-*.intent.json'))
                if not intents:
                    raise RuntimeError('No recorded replacement to restore')
                for intent in intents:
                    response = intent.with_name(intent.name.replace('.intent.', '.response.'))
                    if not response.exists():
                        raise RuntimeError('Uncertain maintenance write; reconcile before rollback')
                    result = json.loads(response.read_text())
                    if 'error' in result and not (result.get('httpStatusCode') in (400, 403)
                        and result.get('awsErrorCode') in ('AccessDenied', 'AccessDeniedException', 'ClientException')):
                        raise RuntimeError('Uncertain maintenance error; reconcile before rollback')
                if ((queue and (queue_identity(queue) != queue_identity(self.plan['baselineQueue'])
                    or queue['computeEnvironmentOrder'] != self.plan['baselineQueue']['computeEnvironmentOrder']))
                    or (pool and creation(pool) not in (before, target))):
                    raise RuntimeError('Unknown pool/queue state; refuse rollback')
                mode = 'missing' if not pool else 'reuse' if creation(pool) == target else 'replace'
            elif not ready(pool, queue, before, self.plan['baselineQueue']):
                raise RuntimeError('Pool changed before maintenance')
            self.idle()
            persist(checkpoint, {'mode': mode if restore else 'replace', 'pool': pool, 'queue': queue}, exclusive=True)
        origin = json.loads(checkpoint.read_text())
        restore_mode = origin['mode']
        self.status(direction + '-in-progress')
        def mutate(key, operation, **params):
            return self.c.mutate(direction + '-' + key, 'batch', operation, **params)
        # Checkpoint each completed stage. A restart skips only known successful
        # operations, and cannot reinterpret a missing/error response as success.
        def stage(key, operation, read, ready, **params):
            done = self.c.directory / (direction + '-' + key + '.done.json')
            if done.exists():
                return
            mutate(key, operation, **params)
            actual = self.wait(read, ready)
            persist(done, {'actual': actual}, exclusive=True)
        if origin['queue']:
            if not (self.c.directory / (direction + '-queue-delete.done.json')).exists():
                stage('queue-disable', 'update_job_queue', self.queue, lambda q: q and q['state'] == 'DISABLED' and q['status'] == 'VALID', jobQueue='qsb-gpu', state='DISABLED')
                self.idle()
                q = self.queue()
                if q and (queue_identity(q) != queue_identity(self.plan['baselineQueue']) or q['state'] != 'DISABLED'
                    or q['computeEnvironmentOrder'] != self.plan['baselineQueue']['computeEnvironmentOrder']):
                    raise RuntimeError('Unrelated queue configuration changed')
                stage('queue-delete', 'delete_job_queue', self.queue, lambda q: q is None, jobQueue='qsb-gpu')
        if restore_mode == 'replace':
            stage('pool-disable', 'update_compute_environment', self.pool, lambda p: p and p['state'] == 'DISABLED' and p['status'] in ('VALID', 'INVALID'), computeEnvironment='qsb-gpu', state='DISABLED')
            if not (journal / (direction + '-delete.intent.json')).exists():
                pool = self.pool()
                if not pool or creation(pool) != before or pool['state'] != 'DISABLED' or self.queue() is not None:
                    raise RuntimeError('Unexpected pool before deletion')
                self.idle()
            stage('delete', 'delete_compute_environment', self.pool, lambda p: p is None, computeEnvironment='qsb-gpu')
        if restore_mode != 'reuse':
            stage('create', 'create_compute_environment', self.pool, lambda p: p and p['status'] == 'VALID' and creation(p) == target, **target)
        if creation(self.pool()) != target:
            raise RuntimeError('Replacement differs from exact target')
        stage('queue-create', 'create_job_queue', self.queue, lambda q: q and q['status'] == 'VALID' and queue_identity(q) == queue_identity(self.plan['baselineQueue'])
              and q['computeEnvironmentOrder'] == self.plan['baselineQueue']['computeEnvironmentOrder'], **self.plan['queueRestore'])
        stage('pool-enable', 'update_compute_environment', self.pool, lambda p: p and p['status'] == 'VALID' and p['state'] == 'ENABLED', computeEnvironment='qsb-gpu', state='ENABLED')
        stage('queue-enable', 'update_job_queue', self.queue, lambda q: q['status'] == 'VALID' and q['state'] == 'ENABLED', jobQueue='qsb-gpu', state='ENABLED')
        self.idle()
        if not ready(self.pool(), self.queue(), target, self.plan['baselineQueue']):
            raise RuntimeError('Final configuration differs')
        self.status('restored' if restore else 'candidate-ready')
        print(json.dumps({'phase': 'restored' if restore else 'candidate-ready', 'instanceTypes': target['computeResources']['instanceTypes']}))

    def bind(self, destination):
        binding = {'directory': str(self.c.directory), 'sourceCommit': self.plan['sourceCommit'],
                   'planSha256': hashlib.sha256(self.path.read_bytes()).hexdigest()}
        if json.loads((self.c.directory / 'shared-pool-status.json').read_text())['phase'] != 'candidate-ready':
            raise RuntimeError('Candidate not ready')
        persist(destination / 'shared-pool-binding.json', binding, exclusive=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['capture', 'replace', 'restore', 'bind'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--campaign', type=Path)
    args = parser.parse_args()
    pool = SharedPool(args.directory)
    if args.action == 'bind':
        if not args.campaign:
            parser.error('--campaign required')
        pool.bind(args.campaign)
    elif args.action == 'restore':
        pool.replace(restore=True)
    else:
        getattr(pool, args.action)()


if __name__ == '__main__':
    main()
