#!/usr/bin/env python3
"""Isolated GPU queue/pool, verified external IAM grants, immutable private receipts."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import time
from datetime import datetime, timezone

from control import ACTIVE, Campaign, ROOT, clean_source, dump, persist

PROFILE = json.loads((ROOT / 'server/aws-batch-validation.json').read_text())
COMPUTE_NAME = QUEUE_NAME = PROFILE['name']
POLICY_NAME = 'qsb-pqb-validation-capacity'
# CreateJobQueue authorizes both its queue and each referenced compute environment.
COMPUTE_ACTIONS = {'batch:CreateComputeEnvironment', 'batch:UpdateComputeEnvironment', 'batch:DeleteComputeEnvironment', 'batch:TagResource', 'batch:CreateJobQueue'}
QUEUE_ACTIONS = {'batch:CreateJobQueue', 'batch:UpdateJobQueue', 'batch:DeleteJobQueue', 'batch:TagResource'}
CAPACITY_ACTIONS = COMPUTE_ACTIONS | QUEUE_ACTIONS


def generated_actions(value):
    found = set()
    if isinstance(value, dict):
        if value.get('Effect') == 'Allow':
            actions = value.get('Action', [])
            found.update([actions] if isinstance(actions, str) else actions)
        for child in value.values():
            found.update(generated_actions(child))
    elif isinstance(value, list):
        for child in value:
            found.update(generated_actions(child))
    return found & CAPACITY_ACTIONS


def validate_operator_policy(policy, campaign):
    if set(policy) - {'Version', 'Statement', 'Id'} or policy.get('Version') != '2012-10-17' or len(policy.get('Statement', [])) != 2:
        raise RuntimeError('Require exactly two temporary operator statements')
    expected = {campaign.arn('batch', 'compute-environment/' + COMPUTE_NAME): COMPUTE_ACTIONS,
                campaign.arn('batch', 'job-queue/' + QUEUE_NAME): QUEUE_ACTIONS}
    expiries, seen = set(), set()
    for statement in policy['Statement']:
        resource = statement.get('Resource')
        if (not isinstance(resource, str) or resource not in expected or resource in seen
            or set(statement) - {'Sid', 'Effect', 'Action', 'Resource', 'Condition'}
            or statement.get('Effect') != 'Allow' or not isinstance(statement.get('Action'), list)
            or len(statement['Action']) != len(expected[resource]) or set(statement['Action']) != expected[resource]):
            raise RuntimeError('Reject broader or differently scoped administrator grant')
        conditions = statement.get('Condition', {})
        if (set(conditions) != {'StringEquals', 'DateLessThan'}
            or conditions['StringEquals'] != {'aws:RequestedRegion': campaign.region}
            or set(conditions['DateLessThan']) != {'aws:CurrentTime'}):
            raise RuntimeError('Require the exact region and absolute grant expiry')
        try:
            expiry = datetime.strptime(conditions['DateLessThan']['aws:CurrentTime'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
        except (ValueError, TypeError) as error:
            raise RuntimeError('Invalid grant expiry') from error
        expiries.add(int(expiry.timestamp())); seen.add(resource)
    if len(expiries) != 1:
        raise RuntimeError('Grant statements must have one fixed expiry')
    return expiries.pop()


def boundary_document(value):
    return value.get('PolicyVersion', {}).get('Document', value)


def requested_boundary(baseline, campaign, expiry):
    """Append only the new queue's runtime permissions; preserve the original boundary."""
    result = copy.deepcopy(boundary_document(baseline))
    if result.get('Version') != '2012-10-17' or not isinstance(result.get('Statement'), list):
        raise RuntimeError('Invalid boundary baseline')
    if any(s.get('Sid') in ('PqbValidationSubmit', 'PqbValidationTag') for s in result['Statement']):
        raise RuntimeError('Reconcile the previous validation boundary supplement first')
    condition = {'StringEquals': {'aws:RequestedRegion': campaign.region},
        'ArnLike': {'aws:PrincipalArn': f'arn:aws:iam::{campaign.account}:role/qsb/runtime/qsb-pqb-v-????????????-coordinator'},
        'DateLessThan': {'aws:CurrentTime': datetime.fromtimestamp(expiry, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}}
    queue = campaign.arn('batch', 'job-queue/' + QUEUE_NAME)
    result['Statement'].append({'Sid': 'PqbValidationSubmit', 'Effect': 'Allow', 'Action': ['batch:SubmitJob'], 'Resource': [queue], 'Condition': copy.deepcopy(condition)})
    condition['StringEquals']['aws:RequestTag/Project'] = 'qsb-gpu'
    condition['ForAllValues:StringEquals'] = {'aws:TagKeys': ['Project', 'QsbRequest', 'InputSha256']}
    condition['Null'] = {'aws:TagKeys': 'false'}
    result['Statement'].append({'Sid': 'PqbValidationTag', 'Effect': 'Allow', 'Action': ['batch:TagResource'], 'Resource': [queue], 'Condition': condition})
    return result


def validate_plan(plan, c):
    if c.config.get('snfIsolation') is True:
        from snf import validate_plan as validate_snf_plan
        return validate_snf_plan(plan, c)
    if (plan['format'] != 'pqb-validation-capacity-v2'
        or plan['computeArn'] != c.arn('batch', 'compute-environment/' + COMPUTE_NAME)
        or plan['queueArn'] != c.arn('batch', 'job-queue/' + QUEUE_NAME)):
        raise RuntimeError('Unexpected isolated capacity identity')
    expiry = validate_operator_policy(plan['operatorPolicy'], c)
    if expiry != plan['expiresAt'] or not plan['createdAt'] < expiry <= plan['createdAt'] + 24 * 3600:
        raise RuntimeError('Never extend the fixed, at most 24-hour capacity grant')
    if plan['runtimeBoundary'] != requested_boundary(plan['boundaryBaseline'], c, expiry):
        raise RuntimeError('Runtime boundary differs from the exact expiring queue supplement')
    original = plan['computeBaseline']
    if original['computeEnvironmentArn'] != c.arn('batch', 'compute-environment/qsb-gpu') or original['type'] != 'MANAGED' or original['state'] != 'ENABLED' or original['status'] != 'VALID':
        raise RuntimeError('Unexpected production compute baseline')
    wanted = {k: copy.deepcopy(v) for k, v in original['computeResources'].items() if k in
        {'type', 'subnets', 'securityGroupIds', 'instanceRole', 'launchTemplate', 'ec2Configuration'}}
    wanted.update(allocationStrategy=PROFILE['allocationStrategy'], instanceTypes=[PROFILE['instanceType']],
                  minvCpus=0, desiredvCpus=0, maxvCpus=PROFILE['maxVcpus'])
    if plan.get('validationNetwork') is not None:
        from validation_network import validate_binding
        validate_binding(plan['validationNetwork'], original['computeResources']['subnets'], c.region)
        wanted['subnets'] = [plan['validationNetwork']['selected']]
    if plan['computeResources'] != wanted or wanted['type'] != 'EC2' or wanted['launchTemplate'].get('version') != '1' or not wanted.get('ec2Configuration'):
        raise RuntimeError('Preserve the reviewed isolated GPU hardware, AMI, network and host profile')
    queue = plan['productionQueue']
    if (queue['jobQueueArn'] != c.arn('batch', 'job-queue/qsb-gpu')
        or queue['computeEnvironmentOrder'] != [{'order': 1, 'computeEnvironment': original['computeEnvironmentArn']}]):
        raise RuntimeError('Unexpected production queue baseline')


class Capacity:
    def __init__(self, campaign):
        self.c = campaign; self.path = self.c.directory / 'capacity-plan.json'
        self.plan = json.loads(self.path.read_text()) if self.path.exists() else None
        self.batch = self.c.client('batch')
        if self.plan:
            validate_plan(self.plan, self.c)
            witnesses = [] if self.c.config.get('snfIsolation') is True else [('autopilot.json', 'autopilotSha256'), ('requested-policy.json', 'requestedPolicySha256'), ('boundary-baseline.json', 'boundaryBaselineSha256')]
            for name, key in witnesses:
                if hashlib.sha256((self.c.directory / 'capacity' / name).read_bytes()).hexdigest() != self.plan[key]:
                    raise RuntimeError('Capacity policy evidence changed')
            if self.c.state:
                binding = self.c.state.get('capacity')
                if not binding or binding['planSha256'] != hashlib.sha256(self.path.read_bytes()).hexdigest() or self.plan['sourceCommit'] != self.c.state['sourceCommit']:
                    raise RuntimeError('Capacity plan differs from the campaign binding')

    def metadata_session(self):
        if self.c.config.get('snfIsolation') is True: return self.c.session
        import boto3
        source = self.c.session._session.get_scoped_config().get('source_profile')
        if not source:
            raise RuntimeError('Require the existing SSO source profile for metadata reads')
        base = boto3.Session(profile_name=source, region_name=self.c.region)
        credentials = base.client('sts', config=self.c.sdk_config).assume_role(
            RoleArn=f'arn:aws:iam::{self.c.account}:role/qsb/bootstrap/qsb-viewonly', RoleSessionName='pqb-capacity-metadata')['Credentials']
        return boto3.Session(aws_access_key_id=credentials['AccessKeyId'], aws_secret_access_key=credentials['SecretAccessKey'], aws_session_token=credentials['SessionToken'], region_name=self.c.region)

    def scaling_groups(self):
        client = self.metadata_session().client('autoscaling', config=self.c.read_sdk_config)
        return [g for page in client.get_paginator('describe_auto_scaling_groups').paginate()
                for g in page['AutoScalingGroups'] if g['AutoScalingGroupName'].startswith('AWSBatch-' + COMPUTE_NAME + '-asg-')]

    def production_unchanged(self, require_idle=False):
        if self.c.config.get('snfIsolation') is True:
            from snf import check_baseline
            return check_baseline(self.c, require_idle)
        q = self.batch.describe_job_queues(jobQueues=[self.plan['productionQueue']['jobQueueArn']])['jobQueues']
        if q != [self.plan['productionQueue']]:
            raise RuntimeError('Production queue changed; stop and reconcile')
        if require_idle:
            for status in ACTIVE:
                if any(p['jobSummaryList'] for p in self.batch.get_paginator('list_jobs').paginate(jobQueue=q[0]['jobQueueArn'], jobStatus=status)):
                    raise RuntimeError('Production work needs GPU capacity; stop the public assessment')

    def read_network(self, subnet, planning=False):
        from validation_network import capture
        ec2 = self.metadata_session().client('ec2', config=self.c.read_sdk_config)
        return capture(ec2, self.plan['computeBaseline']['computeResources']['subnets'], subnet,
            self.c.region, PROFILE['instanceType'], (PROFILE['maxVcpus'] // PROFILE['vcpusPerHost'] + 5) if planning else 0)

    def check_network(self):
        if self.plan.get('validationNetwork') is not None:
            expected = self.plan['validationNetwork']
            if self.read_network(expected['selected']) != expected:
                raise RuntimeError('Validation network changed since planning')

    def make_plan(self, generated, requested, boundary, validation_subnet=None):
        if self.plan or self.c.state:
            raise RuntimeError('Use a fresh directory; never reuse a capacity campaign')
        source = clean_source(); baseline = json.loads((self.c.directory / 'live-runtime-private.json').read_text())
        if any(baseline['activeJobs'].values()) or baseline['runningExecutions'] or len(baseline['computeEnvironments']) != 1:
            raise RuntimeError('Require a drained reviewed baseline')
        if (self.batch.describe_compute_environments(computeEnvironments=[COMPUTE_NAME])['computeEnvironments']
            or self.batch.describe_job_queues(jobQueues=[QUEUE_NAME])['jobQueues'] or self.scaling_groups()):
            raise RuntimeError('Reconcile existing isolated capacity before a fresh campaign')
        if generated_actions(json.loads(generated.read_text())) != CAPACITY_ACTIONS:
            raise RuntimeError('Autopilot did not establish every required capacity operation')
        policy = json.loads(requested.read_text()); expires = validate_operator_policy(policy, self.c); created = int(time.time())
        if not created + 5 * 3600 <= expires <= created + 24 * 3600:
            raise RuntimeError('Require five to 24 hours before the requested grant expires')
        resources = {k: copy.deepcopy(v) for k, v in baseline['computeEnvironments'][0]['computeResources'].items() if k in
            {'type', 'subnets', 'securityGroupIds', 'instanceRole', 'launchTemplate', 'ec2Configuration'}}
        resources.update(allocationStrategy=PROFILE['allocationStrategy'], instanceTypes=[PROFILE['instanceType']], minvCpus=0, desiredvCpus=0, maxvCpus=PROFILE['maxVcpus'])
        base_boundary = json.loads(boundary.read_text())
        self.plan = {'format': 'pqb-validation-capacity-v2', 'sourceCommit': source, 'createdAt': created, 'expiresAt': expires,
            'computeArn': self.c.arn('batch', 'compute-environment/' + COMPUTE_NAME), 'queueArn': self.c.arn('batch', 'job-queue/' + QUEUE_NAME),
            'productionQueue': baseline['queue'][0], 'computeBaseline': baseline['computeEnvironments'][0], 'computeResources': resources,
            'operatorPolicy': policy, 'boundaryBaseline': base_boundary, 'runtimeBoundary': requested_boundary(base_boundary, self.c, expires),
            'autopilotSha256': hashlib.sha256(generated.read_bytes()).hexdigest(), 'requestedPolicySha256': hashlib.sha256(requested.read_bytes()).hexdigest(),
            'boundaryBaselineSha256': hashlib.sha256(boundary.read_bytes()).hexdigest()}
        if validation_subnet:
            self.plan['validationNetwork'] = self.read_network(validation_subnet, planning=True)
            self.plan['computeResources']['subnets'] = [validation_subnet]
        validate_plan(self.plan, self.c)
        target = self.c.directory / 'capacity'; target.mkdir(exist_ok=True)
        for name, original in [('autopilot.json', generated), ('requested-policy.json', requested), ('boundary-baseline.json', boundary)]:
            with (target / name).open('xb') as stream:
                stream.write(original.read_bytes()); stream.flush(); os.fsync(stream.fileno())
        persist(target / 'runtime-boundary-request.json', self.plan['runtimeBoundary'], exclusive=True)
        persist(self.path, self.plan, exclusive=True)
        print('Retained isolated capacity plan and exact, expiring IAM requests; no campaign deadline started')

    def check_grant(self):
        if self.c.config.get('snfIsolation') is True:
            from snf import check_authority
            check_authority(self.c, self.plan)
            return {'snfIsolation': True}
        self.check_network()
        if time.time() >= self.plan['expiresAt']:
            raise RuntimeError('Capacity grant expired')
        iam = self.metadata_session().client('iam', config=self.c.read_sdk_config)
        try:
            operator = iam.get_role_policy(RoleName='qsb-operator', PolicyName=POLICY_NAME)
        except iam.exceptions.NoSuchEntityException as error:
            raise RuntimeError('Administrator has not installed the isolated capacity grant') from error
        if validate_operator_policy(operator['PolicyDocument'], self.c) != self.plan['expiresAt']:
            raise RuntimeError('Operator grant expiry changed')
        arn = f'arn:aws:iam::{self.c.account}:policy/qsb/bootstrap/qsb-runtime-boundary'
        policy = iam.get_policy(PolicyArn=arn)['Policy']
        version = iam.get_policy_version(PolicyArn=arn, VersionId=policy['DefaultVersionId'])
        if version['PolicyVersion']['Document'] != self.plan['runtimeBoundary']:
            raise RuntimeError('Runtime boundary does not preserve the baseline with only the requested queue supplement')
        return {'operator': operator, 'boundaryMetadata': policy, 'boundaryVersion': version}

    def verify_grant(self):
        target = self.c.directory / 'capacity'; target.mkdir(exist_ok=True)
        persist(target / ('external-grant-' + str(time.time_ns()) + '.json'), {'appliedExternally': True, 'readback': self.check_grant()}, exclusive=True)
        print('Verified externally installed operator and runtime-boundary grants')

    def owned(self, row):
        tags = row.get('tags', {})
        if tags.get('Project') != 'qsb-gpu' or tags.get('PqbValidation') != self.c.state['name']:
            raise RuntimeError('Refuse to use or delete unowned isolated capacity')
        return row

    def pool(self):
        rows = self.batch.describe_compute_environments(computeEnvironments=[self.plan['computeArn']])['computeEnvironments']
        if len(rows) > 1: raise RuntimeError('Ambiguous isolated pool')
        return self.owned(rows[0]) if rows else None

    def queue(self):
        rows = self.batch.describe_job_queues(jobQueues=[self.plan['queueArn']])['jobQueues']
        if len(rows) > 1: raise RuntimeError('Ambiguous isolated queue')
        return self.owned(rows[0]) if rows else None

    def wait(self, read, predicate, message):
        until = time.monotonic() + 120
        while time.monotonic() < until:
            actual = read()
            if predicate(actual): return actual
            time.sleep(3)
        raise RuntimeError(message + '; retain receipts and reconcile without replay')

    def check_ready(self):
        self.production_unchanged(require_idle=True); self.check_grant()
        if self.c.state['capacity']['status'] != 'ready':
            raise RuntimeError('Isolated capacity is not ready')
        pool, queue = self.pool(), self.queue()
        if not pool or not queue or any(r['state'] != 'ENABLED' or r['status'] != 'VALID' or r.get('tags', {}).get('SourceCommit') != self.plan['sourceCommit'] for r in [pool, queue]):
            raise RuntimeError('Isolated capacity is not the owned healthy configuration')
        for key, value in self.plan['computeResources'].items():
            if key != 'desiredvCpus' and pool['computeResources'].get(key) != value:
                raise RuntimeError('Isolated pool configuration changed: ' + key)
        if (pool['computeResources'].get('tags') != {'Project': 'qsb-gpu', 'PqbValidation': self.c.state['name']}
            or queue['priority'] != 0 or queue['computeEnvironmentOrder'] != [{'order': 1, 'computeEnvironment': self.plan['computeArn']}]):
            raise RuntimeError('Isolated host tags or queue binding changed')

    def create(self):
        self.c.before_deadline(); self.production_unchanged(require_idle=True); self.check_grant()
        if self.c.state['phase'] != 'prepared' or self.c.state['capacity']['status'] != 'planned':
            raise RuntimeError('Invalid isolated capacity creation phase')
        resources = copy.deepcopy(self.plan['computeResources'])
        resources['tags'] = {'Project': 'qsb-gpu', 'PqbValidation': self.c.state['name']}
        tags = {'Project': 'qsb-gpu', 'PqbValidation': self.c.state['name']}
        params = {'computeEnvironmentName': COMPUTE_NAME, 'type': 'MANAGED', 'state': 'ENABLED', 'computeResources': resources, 'tags': tags}
        result = self.c.mutate('capacity-create', 'batch', 'create_compute_environment', invoke=lambda: self.batch.create_compute_environment(**params), **params)
        if result['computeEnvironmentArn'] != self.plan['computeArn']: raise RuntimeError('Created pool identity differs')
        self.c.state['capacity']['status'] = 'created'; self.c.save()
        self.wait(self.pool, lambda p: p and p['status'] in ('VALID', 'INVALID'), 'Pool initialization pending')
        if self.pool()['status'] != 'VALID': raise RuntimeError('Isolated pool is invalid; collect and clean up')
        params = {'resourceArn': self.plan['computeArn'], 'tags': {'SourceCommit': self.plan['sourceCommit']}}
        self.c.mutate('capacity-tag', 'batch', 'tag_resource', invoke=lambda: self.batch.tag_resource(**params), **params)
        params = {'jobQueueName': QUEUE_NAME, 'state': 'ENABLED', 'priority': 0,
            'computeEnvironmentOrder': [{'order': 1, 'computeEnvironment': self.plan['computeArn']}], 'tags': dict(tags, SourceCommit=self.plan['sourceCommit'])}
        result = self.c.mutate('capacity-queue', 'batch', 'create_job_queue', invoke=lambda: self.batch.create_job_queue(**params), **params)
        if result['jobQueueArn'] != self.plan['queueArn']: raise RuntimeError('Created queue identity differs')
        self.wait(self.queue, lambda q: q and q['status'] in ('VALID', 'INVALID'), 'Queue initialization pending')
        self.c.state['capacity']['status'] = 'ready'; self.c.save(); self.check_ready()

    def queue_jobs(self):
        ids = sorted({j['jobId'] for status in (*ACTIVE, 'SUCCEEDED', 'FAILED')
            for p in self.batch.get_paginator('list_jobs').paginate(jobQueue=self.plan['queueArn'], jobStatus=status) for j in p['jobSummaryList']})
        rows = []
        for offset in range(0, len(ids), 100): rows.extend(self.batch.describe_jobs(jobs=ids[offset:offset + 100])['jobs'])
        if sorted(j['jobId'] for j in rows) != ids: raise RuntimeError('Incomplete isolated job inventory')
        return rows

    def reconcile_history(self, directories):
        """Retained queue history is not a submission by the new campaign."""
        self.c.before_deadline(); self.check_ready()
        if self.c.state['phase'] != 'prepared' or self.c.state.get('definition') or self.c.state.get('knownJobIds'):
            raise RuntimeError('Reconcile prior history before deploying or submitting new work')
        expected, sources = {}, []
        for directory in directories:
            previous = Campaign(directory)
            state = previous.state
            if (not state or previous.config != self.c.config or state['name'] == self.c.state['name']
                or state['queue'] != self.c.state['queue'] or state.get('reservationStatus') != 'released'
                or not state.get('phase', '').endswith('-cleanup-verified')):
                raise RuntimeError('Require a separately completed and cleaned prior campaign')
            receipt, _ = previous.checked_final_collection()
            binding = state['independentCleanup']
            cleanup_path = previous.directory / binding['file']
            if cleanup_path.parent != previous.directory or hashlib.sha256(cleanup_path.read_bytes()).hexdigest() != binding['sha256']:
                raise RuntimeError('Prior independent cleanup binding changed')
            cleanup = json.loads(cleanup_path.read_text())
            if (cleanup.get('verified') is not True or cleanup.get('campaign') != state['name']
                or cleanup.get('sourceCommit') != state['sourceCommit'] or not cleanup.get('checks')
                or not all(row.get('passed') is True for row in cleanup['checks'])):
                raise RuntimeError('Prior independent cleanup did not verify')
            indices = [name for name in receipt['files'] if name.startswith('native-index-') and name.endswith('.json')]
            if len(indices) != 1:
                raise RuntimeError('Require one sealed prior native inventory')
            rows = json.loads((previous.directory / indices[0]).read_text())['jobs']
            if sorted(j['jobId'] for j in rows) != state['knownJobIds'] or receipt['nativeJobIds'] != state['knownJobIds']:
                raise RuntimeError('Prior native inventory changed')
            for job in rows:
                if (job['jobId'] in expected or job['status'] not in ('SUCCEEDED', 'FAILED')
                    or job['jobQueue'] != self.c.state['queue'] or job['jobDefinition'] != state['definition']
                    or job['createdAt'] >= self.c.state['createdAt'] * 1000):
                    raise RuntimeError('Prior native work is duplicated, active or incorrectly bound')
                expected[job['jobId']] = hashlib.sha256(dump(job).encode()).hexdigest()
            sources.append({'campaign': state['name'], 'sourceCommit': state['sourceCommit'],
                'finalCollection': state['finalCollection'], 'independentCleanup': binding})
        jobs = self.queue_jobs()
        if sorted(j['jobId'] for j in jobs) != sorted(expected) or any(
            hashlib.sha256(dump(j).encode()).hexdigest() != expected[j['jobId']] for j in jobs):
            raise RuntimeError('Live queue history differs from the sealed prior inventories')
        persist(self.c.directory / 'capacity/prior-terminal-history.json', {
            'format': 'pqb-prior-terminal-history-v2', 'campaign': self.c.state['name'],
            'sourceCommit': self.plan['sourceCommit'], 'sources': sources, 'jobSha256': expected,
            'scope': 'Historical terminal jobs; excluded from current native accounting'}, exclusive=True)

    def verify_queue_inventory(self, jobs, terminal=False):
        path = self.c.directory / 'capacity/prior-terminal-history.json'
        historical = {}
        if path.exists():
            history = json.loads(path.read_text())
            if (history['format'] != 'pqb-prior-terminal-history-v2' or history['campaign'] != self.c.state['name']
                or history['sourceCommit'] != self.plan['sourceCommit']):
                raise RuntimeError('Prior terminal history binding changed')
            historical = history['jobSha256']
            if terminal:
                receipt, _ = self.c.checked_final_collection()
                if 'capacity/prior-terminal-history.json' not in receipt['files']:
                    raise RuntimeError('Prior terminal history was not sealed before cleanup')
        current = []
        for job in jobs:
            if job.get('jobQueue') != self.c.state['queue']:
                raise RuntimeError('Isolated work changed or remains active; queue identity differs')
            if job['jobId'] in historical:
                if job['status'] not in ('SUCCEEDED', 'FAILED') or hashlib.sha256(dump(job).encode()).hexdigest() != historical[job['jobId']]:
                    raise RuntimeError('Prior terminal history changed')
            elif self.c.state.get('definition') and job['jobDefinition'] == self.c.state['definition']:
                current.append(job['jobId'])
            else:
                raise RuntimeError('Isolated work changed or remains active; reconcile prior queue history')
        if (len({j['jobId'] for j in jobs}) != len(jobs) or set(historical) - {j['jobId'] for j in jobs}
            or set(historical).intersection(self.c.state.get('knownJobIds', []))
            or (terminal and (any(j['status'] in ACTIVE for j in jobs) or sorted(current) != self.c.state.get('knownJobIds', [])))):
            raise RuntimeError('Isolated work changed or remains active; collect/reconcile before deletion')

    def collect(self, stamp):
        target = self.c.directory / 'capacity'; target.mkdir(exist_ok=True)
        pool, queue = self.pool(), self.queue(); hosts = []
        if pool and pool.get('ecsClusterArn'):
            ecs = self.metadata_session().client('ecs', config=self.c.read_sdk_config)
            ids = sorted({i for status in ['ACTIVE', 'DRAINING', 'REGISTERING', 'DEREGISTERING', 'REGISTRATION_FAILED']
                for page in ecs.get_paginator('list_container_instances').paginate(cluster=pool['ecsClusterArn'], status=status) for i in page['containerInstanceArns']})
            for offset in range(0, len(ids), 100):
                result = ecs.describe_container_instances(cluster=pool['ecsClusterArn'], containerInstances=ids[offset:offset + 100])
                if result.get('failures'): raise RuntimeError('Container inventory incomplete')
                hosts.extend(r['ec2InstanceId'] for r in result['containerInstances'] if r.get('ec2InstanceId'))
        groups = self.scaling_groups()
        hosts.extend(i['InstanceId'] for g in groups for i in g['Instances'])
        tagged = self.c.client('ec2').describe_instances(Filters=[{'Name': 'tag:PqbValidation', 'Values': [self.c.state['name']]}])
        hosts.extend(i['InstanceId'] for r in tagged['Reservations'] for i in r['Instances'])
        hosts = sorted(set(hosts) | set(self.c.state['capacity'].get('instanceIds', [])))
        instances = self.c.client('ec2').describe_instances(InstanceIds=hosts) if hosts else {'Reservations': []}
        if sorted(i['InstanceId'] for r in instances['Reservations'] for i in r['Instances']) != hosts:
            raise RuntimeError('Recorded host inventory incomplete; retain and reconcile')
        volumes = {b['Ebs']['VolumeId'] for r in instances['Reservations'] for i in r['Instances'] for b in i.get('BlockDeviceMappings', []) if 'Ebs' in b}
        self.c.state['capacity'].update(instanceIds=hosts, volumeIds=sorted(volumes | set(self.c.state['capacity'].get('volumeIds', []))))
        if pool and pool.get('ecsClusterArn'): self.c.state['capacity']['ecsClusterArn'] = pool['ecsClusterArn']
        self.c.save()
        activities = []; scaling = self.metadata_session().client('autoscaling', config=self.c.read_sdk_config)
        for g in groups:
            activities.extend(a for p in scaling.get_paginator('describe_scaling_activities').paginate(AutoScalingGroupName=g['AutoScalingGroupName']) for a in p['Activities'])
        path = target / (stamp + '.json')
        persist(path, {'pool': pool, 'queue': queue, 'instances': instances, 'scalingGroups': groups, 'scalingActivities': activities}, exclusive=True)
        return path

    def remove(self):
        self.c.checked_final_collection()
        if clean_source() != self.plan['sourceCommit']: raise RuntimeError('Cleanup source changed')
        self.production_unchanged()
        if not self.c.state['capacity'].get('queueRemoved'):
            queue = self.queue()
            if (self.c.directory / 'requests/capacity-delete-queue.intent.json').exists():
                # A known asynchronous delete may finish after our wait times out.
                # mutate returns only its original successful receipt, never a replay.
                params = {'jobQueue': self.plan['queueArn']}
                self.c.mutate('capacity-delete-queue', 'batch', 'delete_job_queue', invoke=lambda: self.batch.delete_job_queue(**params), **params)
                self.wait(self.queue, lambda q: q is None, 'Queue deletion pending')
            elif queue:
                jobs = self.queue_jobs()
                self.verify_queue_inventory(jobs, terminal=True)
                snapshot = self.collect(str(time.time_ns()))
                persist(self.c.directory / ('capacity/removal-seal-' + str(time.time_ns()) + '.json'),
                    {'baseFinalCollection': self.c.state['finalCollection'], 'snapshot': str(snapshot.relative_to(self.c.directory)),
                     'snapshotSha256': hashlib.sha256(snapshot.read_bytes()).hexdigest(), 'jobs': jobs}, exclusive=True)
                params = {'jobQueue': self.plan['queueArn'], 'state': 'DISABLED'}
                self.c.mutate('capacity-disable-queue', 'batch', 'update_job_queue', invoke=lambda: self.batch.update_job_queue(**params), **params)
                self.wait(self.queue, lambda q: q and q['state'] == 'DISABLED' and q['status'] != 'UPDATING', 'Queue disabling pending')
                params = {'jobQueue': self.plan['queueArn']}
                self.c.mutate('capacity-delete-queue', 'batch', 'delete_job_queue', invoke=lambda: self.batch.delete_job_queue(**params), **params)
                self.wait(self.queue, lambda q: q is None, 'Queue deletion pending')
            elif self.c.state.get('preflightExecution') or self.c.state.get('solveExecution'):
                raise RuntimeError('Executed queue disappeared without a deletion receipt; reconcile')
            self.c.state['capacity']['queueRemoved'] = True; self.c.save()
        pool = self.pool()
        if (self.c.directory / 'requests/capacity-delete.intent.json').exists():
            params = {'computeEnvironment': self.plan['computeArn']}
            self.c.mutate('capacity-delete', 'batch', 'delete_compute_environment', invoke=lambda: self.batch.delete_compute_environment(**params), **params)
            self.wait(self.pool, lambda p: p is None, 'Pool deletion pending')
        elif pool:
            snapshot = self.collect(str(time.time_ns()))
            persist(self.c.directory / ('capacity/pool-removal-seal-' + str(time.time_ns()) + '.json'),
                {'baseFinalCollection': self.c.state['finalCollection'], 'snapshot': str(snapshot.relative_to(self.c.directory)),
                 'snapshotSha256': hashlib.sha256(snapshot.read_bytes()).hexdigest()}, exclusive=True)
            params = {'computeEnvironment': self.plan['computeArn'], 'state': 'DISABLED'}
            self.c.mutate('capacity-disable', 'batch', 'update_compute_environment', invoke=lambda: self.batch.update_compute_environment(**params), **params)
            self.wait(self.pool, lambda p: p and p['state'] == 'DISABLED' and p['status'] != 'UPDATING', 'Pool disabling pending')
            params = {'computeEnvironment': self.plan['computeArn']}
            self.c.mutate('capacity-delete', 'batch', 'delete_compute_environment', invoke=lambda: self.batch.delete_compute_environment(**params), **params)
            self.wait(self.pool, lambda p: p is None, 'Pool deletion pending')
        self.verify_removed()

    def verify_removed(self):
        from botocore.exceptions import ClientError
        self.production_unchanged()
        if self.pool() or self.queue() or self.scaling_groups(): raise RuntimeError('Isolated capacity remains')
        ids = self.c.state['capacity'].get('instanceIds', [])
        instances = self.c.client('ec2').describe_instances(InstanceIds=ids)['Reservations'] if ids else []
        if sorted(i['InstanceId'] for r in instances for i in r['Instances']) != sorted(ids):
            raise RuntimeError('Recorded host inventory incomplete; no cleanup credit')
        if any(i['State']['Name'] != 'terminated' for r in instances for i in r['Instances']): raise RuntimeError('Recorded hosts not terminated')
        for volume in self.c.state['capacity'].get('volumeIds', []):
            try: self.c.client('ec2').describe_volumes(VolumeIds=[volume])
            except ClientError as error:
                if error.response['Error']['Code'] != 'InvalidVolume.NotFound': raise
            else: raise RuntimeError('Recorded volume remains')
        target = self.c.directory / 'capacity'; target.mkdir(exist_ok=True)
        persist(target / ('cleanup-' + str(time.time_ns()) + '.json'), {'poolAbsent': True, 'queueAbsent': True,
            'productionUnchanged': True, 'recordedHostsTerminated': ids, 'recordedVolumesAbsent': self.c.state['capacity'].get('volumeIds', [])}, exclusive=True)
        self.c.state['capacity'].update(status='removed-verified', queueRemoved=True); self.c.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['plan', 'verify_grant', 'create', 'reconcile_history', 'remove', 'verify_removed'])
    parser.add_argument('directory', type=Path)
    parser.add_argument('--generated-policy', type=Path)
    parser.add_argument('--requested-policy', type=Path)
    parser.add_argument('--boundary-baseline', type=Path)
    parser.add_argument('--validation-subnet', help='Administrator-provisioned public subnet for the isolated pool only')
    parser.add_argument('--previous-campaign', type=Path, action='append')
    args = parser.parse_args(); capacity = Capacity(Campaign(args.directory))
    if args.validation_subnet and args.mode != 'plan': parser.error('--validation-subnet is only valid with plan')
    if args.mode == 'plan':
        if not args.generated_policy or not args.requested_policy or not args.boundary_baseline:
            parser.error('plan requires --generated-policy, --requested-policy and --boundary-baseline')
        capacity.make_plan(args.generated_policy, args.requested_policy, args.boundary_baseline, args.validation_subnet)
    elif args.mode == 'reconcile_history':
        if not args.previous_campaign: parser.error('reconcile_history requires --previous-campaign')
        capacity.reconcile_history(args.previous_campaign)
    else: getattr(capacity, args.mode)()


if __name__ == '__main__':
    main()
