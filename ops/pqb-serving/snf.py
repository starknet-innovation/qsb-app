"""Explicit isolated-account serving assessment. No production app or wallet deployment."""
import argparse
import base64
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import time
import uuid

from control import ACTIVE, Campaign, ROOT, clean_source, dump, persist


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def tags(c): return {'Project': 'qsb-gpu', 'PqbValidation': c.state['name'], 'SourceCommit': c.state['sourceCommit']}
def tag_list(c): return [{'Key': k, 'Value': v} for k, v in tags(c).items()]
def allow(actions, resources, **extra): return dict(Effect='Allow', Action=actions, Resource=resources, **extra)
def policy(statements): return {'Version': '2012-10-17', 'Statement': statements}
def role(c, suffix): return c.iam(c.state['name'] + '-' + suffix)


def original(c, key, response=True):
    value = json.loads((c.directory / f"requests/{key}.{'response' if response else 'intent'}.json").read_text())
    return value['result'] if response else value['params']


def check_owned(tags_value, c):
    actual = dict((t['Key'], t['Value']) for t in tags_value) if isinstance(tags_value, list) else tags_value
    if any(actual.get(k) != v for k, v in tags(c).items()): raise RuntimeError('Bootstrap resource ownership changed')


def require_mode(c):
    identity = c.client('sts').get_caller_identity()
    if c.config.get('snfIsolation') is not True or identity['Arn'] != f'arn:aws:iam::{c.account}:root':
        raise RuntimeError('Isolated bootstrap requires the explicitly selected account root session')
    return identity


def gpu_instances(c):
    return [i for p in c.client('ec2').get_paginator('describe_instances').paginate(Filters=[
        {'Name': 'instance-state-name', 'Values': ['pending', 'running', 'stopping', 'stopped']},
        {'Name': 'instance-type', 'Values': ['g*', 'p*']}]) for r in p['Reservations'] for i in r['Instances']]


def check_baseline(c, require_idle=False):
    if not require_idle: return
    name = c.state['name'] if c.state else None
    for instance in gpu_instances(c):
        if dict((t['Key'], t['Value']) for t in instance.get('Tags', [])).get('PqbValidation') != name or name is None:
            raise RuntimeError('Other GPU resources exist; leave them untouched and stop assessment')
    for operation, key, identifier in [('describe_compute_environments', 'computeEnvironments', 'computeEnvironmentName'),
                                      ('describe_job_queues', 'jobQueues', 'jobQueueName')]:
        for page in c.client('batch').get_paginator(operation).paginate():
            for resource in page[key]:
                if resource.get('tags', {}).get('PqbValidation') != name or name is None:
                    raise RuntimeError('Other Batch resources exist; isolated assessment requires an empty baseline')


def inspect(c):
    from capacity import PROFILE
    identity = require_mode(c); check_baseline(c, True)
    ec2 = c.client('ec2')
    vpcs = ec2.describe_vpcs(Filters=[{'Name': 'is-default', 'Values': ['true']}])['Vpcs']
    if len(vpcs) != 1 or vpcs[0]['State'] != 'available': raise RuntimeError('One available default VPC required')
    vpc = vpcs[0]['VpcId']
    offered = {r['Location'] for p in ec2.get_paginator('describe_instance_type_offerings').paginate(
        LocationType='availability-zone', Filters=[{'Name': 'instance-type', 'Values': [PROFILE['instanceType']]}]) for r in p['InstanceTypeOfferings']}
    subnets = [s for s in ec2.describe_subnets(Filters=[{'Name': 'vpc-id', 'Values': [vpc]},
        {'Name': 'default-for-az', 'Values': ['true']}])['Subnets'] if s['AvailabilityZone'] in offered]
    if not subnets or any(s['State'] != 'available' or not s['MapPublicIpOnLaunch'] for s in subnets):
        raise RuntimeError('Available public default subnets supporting selected instance required')
    image_id = json.loads((c.directory / 'host-image.json').read_text())['imageId']
    images = ec2.describe_images(ImageIds=[image_id])['Images']
    if len(images) != 1 or images[0]['State'] != 'available' or images[0]['Architecture'] != 'x86_64' or images[0].get('ImageOwnerAlias') != 'amazon' or 'ecs-gpu' not in images[0]['Name']:
        raise RuntimeError('Pinned Amazon ECS GPU x86_64 image required')
    quota = c.client('service-quotas').get_service_quota(ServiceCode='ec2', QuotaCode='L-DB2E81BA')['Quota']
    if quota['Value'] < PROFILE['vcpusPerHost']: raise RuntimeError('Insufficient quota for native preflight')
    try: repo = c.client('ecr').describe_repositories(repositoryNames=['qsb-solver'])['repositories'][0]
    except c.client('ecr').exceptions.RepositoryNotFoundException: repo = None
    reference = json.loads((c.directory / 'reference-runtime.json').read_text())
    if any(reference['activeJobs'].values()) or reference['runningExecutions']:
        raise RuntimeError('Reference app baseline must be idle')
    persist(c.directory / 'snf-inspect.json', {'kind': 'isolated-account-bootstrap-input-v1', 'identity': identity,
        'observedAt': int(time.time()), 'vpc': vpc, 'subnets': subnets, 'image': images[0], 'quota': quota,
        'repository': repo, 'referenceSha256': sha(c.directory / 'reference-runtime.json')}, exclusive=True)


def prepare(c, source, fixture, manifest):
    from capacity import PROFILE
    require_mode(c); check_baseline(c, True)
    snapshot = json.loads((c.directory / 'snf-inspect.json').read_text())
    if time.time() - snapshot['observedAt'] > 900 or snapshot['referenceSha256'] != sha(c.directory / 'reference-runtime.json'):
        raise RuntimeError('Fresh unchanged isolated-account inputs required')
    name = 'qsb-pqb-v-' + uuid.uuid4().hex[:12]; created = int(time.time())
    c.state = {'format': 'pqb-serving-campaign-v1', 'name': name, 'sourceCommit': source,
        'operatorHash': hashlib.sha256(dump(c.config).encode()).hexdigest(), 'createdAt': created, 'deadline': created + 14400,
        'reservedUsd': 200, 'reservationStatus': 'reserved', 'preflightGpuSeconds': 900, 'solveGpuSeconds': 540000,
        'fixtureSha256': sha(c.directory / 'public-fixture.json'), 'coordinatorSha256': manifest['files']['coordinator.zip'],
        'apiArtifactSha256': manifest['files']['api.zip'], 'descriptor': fixture['descriptor'],
        'queue': c.arn('batch', 'job-queue/' + PROFILE['name']), 'bucket': name + '-artifacts',
        'tables': [name + '-preflight', name + '-solve'], 'roles': [name + '-' + n for n in ['coordinator', 'workflow', 'deadline', 'scheduler']],
        'function': name + '-coordinator', 'cleanupFunction': name + '-deadline', 'workflow': name,
        'schedule': name + '-deadline', 'watchdogSchedule': name + '-watchdog', 'phase': 'prepared',
        'capacity': {'status': 'bootstrapping'}, 'snfBootstrap': {'inspectSha256': sha(c.directory / 'snf-inspect.json'),
            'boundaryArn': f'arn:aws:iam::{c.account}:policy/qsb/runtime/{name}-runtime-boundary'}}
    retained = c.directory / 'build-artifacts'; retained.mkdir()
    for filename in ['manifest.json', 'api.zip', 'coordinator.zip', 'reference.zip', 'webhooks.zip']:
        shutil.copyfile(ROOT / 'terraform/.build' / filename, retained / filename)
        with (retained / filename).open('rb') as f: os.fsync(f.fileno())
    fd = os.open(retained, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
    persist(c.state_path, c.state, exclusive=True); c.validate_scope()
    print(dump({'prepared': name, 'deadline': c.state['deadline'], 'reservedUsd': 200, 'scope': 'SNF isolated consumer stack'}))


def boundary(c):
    n = c.state['name']; q = c.state['queue']; definition = c.arn('batch', 'job-definition/qsb-gpu-solver:*')
    statements = [allow(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'], [c.arn('dynamodb', 'table/' + t) for t in c.state['tables']]),
        allow(['lambda:InvokeFunction'], [c.arn('lambda', 'function:' + c.state[k]) for k in ['function', 'cleanupFunction']]),
        allow(['states:StartExecution'], c.arn('states', 'stateMachine:' + c.state['workflow'])),
        allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [c.arn('logs', 'log-group:/aws/lambda/' + c.state[k] + ':*') for k in ['function', 'cleanupFunction']]),
        allow(['logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery', 'logs:DeleteLogDelivery', 'logs:ListLogDeliveries', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups'], '*'),
        allow(['batch:DescribeJobs', 'batch:DescribeJobDefinitions', 'batch:DescribeJobQueues', 'batch:DescribeComputeEnvironments', 'batch:ListJobs'], '*'),
        allow(['batch:SubmitJob'], [q, definition]),
        allow(['batch:CancelJob', 'batch:TerminateJob'], c.arn('batch', 'job/*'), Condition={'StringEquals': {'aws:ResourceTag/Project': 'qsb-gpu'}}),
        allow(['batch:TagResource'], [q, definition, c.arn('batch', 'job/*')], Condition={'StringEquals': {'aws:RequestTag/Project': 'qsb-gpu'}, 'ForAllValues:StringEquals': {'aws:TagKeys': ['Project', 'QsbRequest', 'InputSha256']}}),
        allow(['s3:PutObject'], f"arn:aws:s3:::{c.state['bucket']}/inputs/*"), allow(['s3:GetObject'], f"arn:aws:s3:::{c.state['bucket']}/outputs/*")]
    for statement in statements:
        condition = statement.setdefault('Condition', {})
        condition.setdefault('StringEquals', {})['aws:RequestedRegion'] = c.region
        condition['DateLessThan'] = {'aws:CurrentTime': datetime.fromtimestamp(c.state['deadline'] + 3600, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
    return policy(statements)


def worker_policies(c):
    bucket = f"arn:aws:s3:::{c.state['bucket']}"; repo = c.arn('ecr', 'repository/qsb-solver')
    return {'task': policy([allow(['s3:GetObject'], bucket + '/inputs/*'), allow(['s3:PutObject'], bucket + '/outputs/*')]),
        'execute': policy([allow(['ecr:GetAuthorizationToken'], '*'), allow(['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'], repo),
            allow(['logs:CreateLogStream', 'logs:PutLogEvents'], c.arn('logs', 'log-group:/aws/batch/' + c.state['name'] + ':*'))])}


def compute_resources(c, snapshot):
    from capacity import PROFILE
    b = c.state['snfBootstrap']
    return {'type': 'EC2', 'allocationStrategy': PROFILE['allocationStrategy'], 'instanceTypes': [PROFILE['instanceType']],
        'minvCpus': 0, 'desiredvCpus': 0, 'maxvCpus': PROFILE['maxVcpus'],
        'subnets': sorted(s['SubnetId'] for s in snapshot['subnets']), 'securityGroupIds': [b['securityGroup']],
        'instanceRole': b['instanceProfileArn'], 'launchTemplate': {'launchTemplateId': b['launchTemplate'], 'version': '1', 'overrides': []},
        'ec2Configuration': [{'imageType': 'ECS_AL2023_NVIDIA', 'imageIdOverride': snapshot['image']['ImageId']}]}


def bootstrap(c):
    from capacity import PROFILE
    c.before_deadline(); require_mode(c); check_baseline(c, True)
    if c.state['phase'] != 'prepared' or c.state['capacity']['status'] != 'bootstrapping': raise RuntimeError('Invalid bootstrap phase')
    snapshot = json.loads((c.directory / 'snf-inspect.json').read_text()); n = c.state['name']; b = c.state['snfBootstrap']
    if sha(c.directory / 'snf-inspect.json') != b['inspectSha256']: raise RuntimeError('Bootstrap inputs changed')
    target = c.directory / 'capacity'; target.mkdir(exist_ok=True)
    c.mutate('snf-bucket', 's3', 'create_bucket', Bucket=c.state['bucket'], CreateBucketConfiguration={'LocationConstraint': c.region})
    c.mutate('snf-bucket-tags', 's3', 'put_bucket_tagging', Bucket=c.state['bucket'], Tagging={'TagSet': tag_list(c)})
    c.mutate('snf-bucket-private', 's3', 'put_public_access_block', Bucket=c.state['bucket'], PublicAccessBlockConfiguration={k: True for k in ['BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets']})
    c.mutate('snf-bucket-encryption', 's3', 'put_bucket_encryption', Bucket=c.state['bucket'], ServerSideEncryptionConfiguration={'Rules': [{'ApplyServerSideEncryptionByDefault': {'SSEAlgorithm': 'AES256'}}]})
    c.mutate('snf-bucket-tls', 's3', 'put_bucket_policy', Bucket=c.state['bucket'], Policy=json.dumps(policy([dict(Effect='Deny', Principal='*', Action='s3:*', Resource=[f"arn:aws:s3:::{c.state['bucket']}", f"arn:aws:s3:::{c.state['bucket']}/*"], Condition={'Bool': {'aws:SecureTransport': 'false'}})])))
    if snapshot['repository'] is None:
        c.mutate('snf-repository', 'ecr', 'create_repository', repositoryName='qsb-solver', imageTagMutability='IMMUTABLE', encryptionConfiguration={'encryptionType': 'AES256'}, tags=tag_list(c))
    created = c.mutate('snf-boundary', 'iam', 'create_policy', PolicyName=n + '-runtime-boundary', Path='/qsb/runtime/', PolicyDocument=json.dumps(boundary(c)), Tags=tag_list(c))
    if created['Policy']['Arn'] != b['boundaryArn']: raise RuntimeError('Boundary identity mismatch')
    for suffix in ['host', 'task', 'execute']:
        service = 'ec2.amazonaws.com' if suffix == 'host' else 'ecs-tasks.amazonaws.com'
        trust = policy([dict(Effect='Allow', Principal={'Service': service}, Action='sts:AssumeRole')])
        if suffix != 'host': trust['Statement'][0]['Condition'] = {'StringEquals': {'aws:SourceAccount': c.account}, 'ArnLike': {'aws:SourceArn': c.arn('ecs', '*')}}
        c.mutate('snf-role-' + suffix, 'iam', 'create_role', RoleName=n + '-' + suffix, Path='/qsb/runtime/', AssumeRolePolicyDocument=json.dumps(trust), Tags=tag_list(c))
    c.mutate('snf-host-policy', 'iam', 'attach_role_policy', RoleName=n + '-host', PolicyArn='arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role')
    for suffix, document in worker_policies(c).items():
        c.mutate('snf-policy-' + suffix, 'iam', 'put_role_policy', RoleName=n + '-' + suffix, PolicyName='validation', PolicyDocument=json.dumps(document))
    profile = c.mutate('snf-profile', 'iam', 'create_instance_profile', InstanceProfileName=n + '-host', Path='/qsb/runtime/', Tags=tag_list(c))
    b['instanceProfileArn'] = profile['InstanceProfile']['Arn']; c.save()
    c.mutate('snf-profile-role', 'iam', 'add_role_to_instance_profile', InstanceProfileName=n + '-host', RoleName=n + '-host')
    sg = c.mutate('snf-security-group', 'ec2', 'create_security_group', GroupName=n, Description='Public PQB assessment; no ingress', VpcId=snapshot['vpc'], TagSpecifications=[{'ResourceType': 'security-group', 'Tags': tag_list(c)}])
    b['securityGroup'] = sg['GroupId']; c.save()
    c.mutate('snf-restrict-egress', 'ec2', 'revoke_security_group_egress', GroupId=b['securityGroup'], IpPermissions=[{'IpProtocol': '-1', 'IpRanges': [{'CidrIp': '0.0.0.0/0'}]}])
    c.mutate('snf-https-egress', 'ec2', 'authorize_security_group_egress', GroupId=b['securityGroup'], IpPermissions=[{'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443, 'IpRanges': [{'CidrIp': '0.0.0.0/0'}]}])
    user_data = 'MIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="QSB"\n\n--QSB\nContent-Type: text/x-shellscript; charset="us-ascii"\n\n#!/bin/bash\necho ECS_AWSVPC_BLOCK_IMDS=true >> /etc/ecs/ecs.config\n--QSB--\n'
    lt = c.mutate('snf-launch-template', 'ec2', 'create_launch_template', LaunchTemplateName=n, ClientToken=n,
        TagSpecifications=[{'ResourceType': 'launch-template', 'Tags': tag_list(c)}], LaunchTemplateData={
            'BlockDeviceMappings': [{'DeviceName': '/dev/xvda', 'Ebs': {'VolumeSize': 80, 'VolumeType': 'gp3', 'Encrypted': True, 'DeleteOnTermination': True}}],
            'MetadataOptions': {'HttpTokens': 'required', 'HttpPutResponseHopLimit': 1}, 'UserData': base64.b64encode(user_data.encode()).decode()})
    b['launchTemplate'] = lt['LaunchTemplate']['LaunchTemplateId']; c.save()
    host_template = c.client('ec2').describe_launch_template_versions(LaunchTemplateId=b['launchTemplate'], Versions=['1'])['LaunchTemplateVersions'][0]['LaunchTemplateData']
    expected_template = original(c, 'snf-launch-template', False)['LaunchTemplateData']
    if set(host_template) != set(expected_template) or host_template['UserData'] != expected_template['UserData']:
        raise RuntimeError('Unexpected initial host-template fields')
    persist(target / 'snf-host-template.json', host_template, exclusive=True)
    group = '/aws/batch/' + n
    c.mutate('snf-job-logs', 'logs', 'create_log_group', logGroupName=group, tags=tags(c))
    c.mutate('snf-job-retention', 'logs', 'put_retention_policy', logGroupName=group, retentionInDays=7)
    definition = c.mutate('snf-initial-definition', 'batch', 'register_job_definition', jobDefinitionName='qsb-gpu-solver', type='container', platformCapabilities=['EC2'],
        containerProperties={'image': f"{c.account}.dkr.ecr.{c.region}.amazonaws.com/qsb-solver@{c.state['descriptor']['image'].split('@')[1]}",
            'command': json.loads((ROOT / 'server/aws-batch-command.json').read_text()), 'jobRoleArn': role(c, 'task'), 'executionRoleArn': role(c, 'execute'),
            'readonlyRootFilesystem': True, 'privileged': False, 'resourceRequirements': [{'type': 'VCPU', 'value': '4'}, {'type': 'MEMORY', 'value': '12000'}, {'type': 'GPU', 'value': '1'}],
            'linuxParameters': {'tmpfs': [{'containerPath': '/tmp', 'size': 2048, 'mountOptions': ['rw', 'nosuid', 'nodev']}]},
            'logConfiguration': {'logDriver': 'awslogs', 'options': {'awslogs-group': group, 'awslogs-region': c.region, 'awslogs-stream-prefix': 'solver'}}},
        retryStrategy={'attempts': 1}, timeout={'attemptDurationSeconds': 900}, propagateTags=True, tags=tags(c))
    b['initialDefinition'] = definition['jobDefinitionArn']; c.save()
    plan = {'format': 'pqb-snf-isolated-capacity-v1', 'sourceCommit': c.state['sourceCommit'],
        'computeArn': c.arn('batch', 'compute-environment/' + PROFILE['name']), 'queueArn': c.state['queue'],
        'computeResources': compute_resources(c, snapshot), 'runtimeBoundary': boundary(c), 'expiresAt': c.state['deadline'] + 3600,
        'hostTemplateSha256': sha(target / 'snf-host-template.json')}
    persist(c.directory / 'capacity-plan.json', plan, exclusive=True)
    c.state['capacity'] = {'status': 'planned', 'planSha256': sha(c.directory / 'capacity-plan.json')}; c.save()


def validate_plan(plan, c):
    from capacity import PROFILE
    snapshot = json.loads((c.directory / 'snf-inspect.json').read_text())
    expected = {'format': 'pqb-snf-isolated-capacity-v1', 'sourceCommit': c.state['sourceCommit'],
        'computeArn': c.arn('batch', 'compute-environment/' + PROFILE['name']), 'queueArn': c.state['queue'],
        'computeResources': compute_resources(c, snapshot), 'runtimeBoundary': boundary(c), 'expiresAt': c.state['deadline'] + 3600,
        'hostTemplateSha256': sha(c.directory / 'capacity/snf-host-template.json')}
    if plan != expected or sha(c.directory / 'snf-inspect.json') != c.state['snfBootstrap']['inspectSha256']:
        raise RuntimeError('Isolated bootstrap plan changed')
    b = c.state['snfBootstrap']
    if (b['boundaryArn'] != f"arn:aws:iam::{c.account}:policy/qsb/runtime/{c.state['name']}-runtime-boundary"
        or b['securityGroup'] != original(c, 'snf-security-group')['GroupId']
        or b['launchTemplate'] != original(c, 'snf-launch-template')['LaunchTemplate']['LaunchTemplateId']
        or b['instanceProfileArn'] != original(c, 'snf-profile')['InstanceProfile']['Arn']
        or b['initialDefinition'] != original(c, 'snf-initial-definition')['jobDefinitionArn']):
        raise RuntimeError('Bootstrap resource identities differ from original successful responses')


def check_authority(c, plan):
    require_mode(c); validate_plan(plan, c)
    arn = c.state['snfBootstrap']['boundaryArn']; iam = c.client('iam')
    version = iam.get_policy(PolicyArn=arn)['Policy']['DefaultVersionId']
    if iam.get_policy_version(PolicyArn=arn, VersionId=version)['PolicyVersion']['Document'] != plan['runtimeBoundary']:
        raise RuntimeError('Isolated runtime boundary changed')
    for suffix in ['host', 'task', 'execute']:
        name = c.state['name'] + '-' + suffix
        actual = iam.get_role(RoleName=name)['Role']; check_owned(actual.get('Tags', []), c)
        if actual['AssumeRolePolicyDocument'] != json.loads(original(c, 'snf-role-' + suffix, False)['AssumeRolePolicyDocument']):
            raise RuntimeError('Isolated worker trust changed')
        if iam.list_role_policies(RoleName=name)['PolicyNames'] != ([] if suffix == 'host' else ['validation']):
            raise RuntimeError('Unexpected isolated worker inline policy')
        attached = iam.list_attached_role_policies(RoleName=name)['AttachedPolicies']
        if [p['PolicyArn'] for p in attached] != (['arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role'] if suffix == 'host' else []):
            raise RuntimeError('Unexpected isolated worker managed policy')
    for suffix, expected in worker_policies(c).items():
        if iam.get_role_policy(RoleName=c.state['name'] + '-' + suffix, PolicyName='validation')['PolicyDocument'] != expected:
            raise RuntimeError('Isolated worker policy changed')
    b = c.state['snfBootstrap']
    profile = iam.get_instance_profile(InstanceProfileName=c.state['name'] + '-host')['InstanceProfile']
    if profile['Arn'] != b['instanceProfileArn'] or [r['Arn'] for r in profile['Roles']] != [role(c, 'host')]:
        raise RuntimeError('Isolated host profile changed')
    group = c.client('ec2').describe_security_groups(GroupIds=[b['securityGroup']])['SecurityGroups'][0]
    check_owned(group.get('Tags', []), c)
    if (group['IpPermissions'] or len(group['IpPermissionsEgress']) != 1
        or {k: v for k, v in group['IpPermissionsEgress'][0].items() if v} !=
            {'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443, 'IpRanges': [{'CidrIp': '0.0.0.0/0'}]}):
        raise RuntimeError('Isolated host network policy changed')
    versions = c.client('ec2').describe_launch_template_versions(LaunchTemplateId=b['launchTemplate'], Versions=['1'])['LaunchTemplateVersions']
    if len(versions) != 1 or versions[0]['LaunchTemplateData'] != json.loads((c.directory / 'capacity/snf-host-template.json').read_text()):
        raise RuntimeError('Isolated host template changed')
    if time.time() >= plan['expiresAt']: raise RuntimeError('Isolated runtime authority expired')
    persist(c.directory / ('capacity/authority-' + str(time.time_ns()) + '.json'), {'verified': True,
        'runtimeBoundary': plan['runtimeBoundary'], 'hostGroup': group, 'hostProfile': profile,
        'hostTemplate': versions, 'workerPolicies': worker_policies(c)}, exclusive=True)


def capture(c):
    from capacity import Capacity
    c.before_deadline(); cap = Capacity(c); cap.check_ready(); cap.verify_queue_inventory(cap.queue_jobs())
    reference = json.loads((c.directory / 'reference-runtime.json').read_text())
    if sha(c.directory / 'reference-runtime.json') != json.loads((c.directory / 'snf-inspect.json').read_text())['referenceSha256']:
        raise RuntimeError('Reference workflow/limit template changed')
    definition = c.client('batch').describe_job_definitions(jobDefinitions=[c.state['snfBootstrap']['initialDefinition']])['jobDefinitions']
    persist(c.directory / 'live-runtime-private.json', {'kind': 'SNF isolated consumer infrastructure; workflow and limits from the reference app',
        'referenceSha256': sha(c.directory / 'reference-runtime.json'), 'coordinatorEnv': reference['coordinatorEnv'],
        'queue': [cap.queue()], 'definition': definition, 'computeEnvironments': [cap.pool()], 'workflow': reference['workflow'],
        'activeJobs': {s: [] for s in ACTIVE}, 'runningExecutions': []}, exclusive=True)


def collect_bootstrap(c, stamp):
    """Fresh positive ownership checks also work after partial, unpaid bootstrap failures."""
    from botocore.exceptions import ClientError
    n = c.state['name']; iam = c.client('iam'); ec2 = c.client('ec2')
    def optional(client, operation, **kwargs):
        try: return getattr(client, operation)(**kwargs)
        except ClientError as error:
            if error.response['Error']['Code'] in ['NoSuchEntity', 'NoSuchBucket']: return None
            raise
    result = {'roles': {}, 'profile': None, 'boundary': None, 'groups': [], 'templates': [], 'definitions': [], 'bucket': None}
    for suffix in ['host', 'task', 'execute']:
        found = optional(iam, 'get_role', RoleName=n + '-' + suffix)
        if found:
            check_owned(found['Role'].get('Tags', []), c)
            inline = iam.list_role_policies(RoleName=n + '-' + suffix)['PolicyNames']
            if set(inline) - {'validation'}: raise RuntimeError('Unexpected bootstrap role policy')
            result['roles'][suffix] = {'role': found, 'policies': {p: iam.get_role_policy(RoleName=n + '-' + suffix, PolicyName=p) for p in inline},
                'attached': iam.list_attached_role_policies(RoleName=n + '-' + suffix)['AttachedPolicies']}
    found = optional(iam, 'get_instance_profile', InstanceProfileName=n + '-host')
    if found:
        check_owned(found['InstanceProfile'].get('Tags', []), c); result['profile'] = found
    found = optional(iam, 'get_policy', PolicyArn=c.state['snfBootstrap']['boundaryArn'])
    if found:
        expected_arn = f'arn:aws:iam::{c.account}:policy/qsb/runtime/{n}-runtime-boundary'
        if found['Policy']['Arn'] != expected_arn: raise RuntimeError('Boundary identity changed')
        version = iam.get_policy_version(PolicyArn=expected_arn, VersionId=found['Policy']['DefaultVersionId'])
        if version['PolicyVersion']['Document'] != boundary(c): raise RuntimeError('Bootstrap boundary changed')
        result['boundary'] = found
    result['groups'] = ec2.describe_security_groups(Filters=[{'Name': 'group-name', 'Values': [n]}, {'Name': 'vpc-id', 'Values': [json.loads((c.directory / 'snf-inspect.json').read_text())['vpc']]}])['SecurityGroups']
    result['templates'] = ec2.describe_launch_templates(Filters=[{'Name': 'launch-template-name', 'Values': [n]}])['LaunchTemplates']
    if len(result['groups']) > 1 or len(result['templates']) > 1: raise RuntimeError('Ambiguous bootstrap resources')
    for resource in result['groups'] + result['templates']: check_owned(resource.get('Tags', []), c)
    for page in c.client('batch').get_paginator('describe_job_definitions').paginate(jobDefinitionName='qsb-gpu-solver', status='ACTIVE'):
        for definition in page['jobDefinitions']:
            if definition.get('tags', {}).get('PqbValidation') == n:
                check_owned(definition['tags'], c); result['definitions'].append(definition)
    # ListBuckets establishes account ownership without reading unrelated object data.
    own_bucket = any(b['Name'] == c.state['bucket'] for p in c.client('s3').get_paginator('list_buckets').paginate() for b in p['Buckets'])
    if own_bucket:
        if not (c.directory / 'requests/snf-bucket.response.json').exists() or 'result' not in json.loads((c.directory / 'requests/snf-bucket.response.json').read_text()):
            raise RuntimeError('Bucket creation outcome needs separate reconciliation')
        result['bucket'] = c.state['bucket']
    target = c.directory / 'capacity'; target.mkdir(exist_ok=True)
    persist(target / ('bootstrap-' + stamp + '.json'), result, exclusive=True)
    return result


def remove(c):
    """Only after runtime and capacity removal; preserve the immutable ECR mirror."""
    if c.state['phase'] != 'removal-requested':
        if c.state['phase'] != 'prepared' or c.state.get('definition') or any((c.directory / 'requests').glob('*-execution.intent.json')):
            raise RuntimeError('Remove and seal the campaign runtime and fleet before bootstrap resources')
        c.checked_final_collection()
        from capacity import Capacity, PROFILE
        if (c.directory / 'capacity-plan.json').exists(): Capacity(c).remove()
        else:
            if ((c.directory / 'requests/capacity-create.intent.json').exists()
                or c.client('batch').describe_compute_environments(computeEnvironments=[PROFILE['name']])['computeEnvironments']
                or c.client('batch').describe_job_queues(jobQueues=[PROFILE['name']])['jobQueues']):
                raise RuntimeError('Unresolved partial capacity; do not remove bootstrap')
            c.state['capacity'].update(status='removed-verified', queueRemoved=True); c.save()
        c.remove()
    if c.state['capacity']['status'] != 'removed-verified': raise RuntimeError('Fleet cleanup not verified')
    c.checked_final_collection(); require_mode(c)
    if clean_source() != c.state['sourceCommit']: raise RuntimeError('Bootstrap cleanup source changed')
    from capacity import Capacity
    if (c.directory / 'capacity-plan.json').exists(): validate_plan(Capacity(c).plan, c)
    b = c.state['snfBootstrap']; n = c.state['name']
    resources = collect_bootstrap(c, str(time.time_ns()))
    for definition in resources['definitions']:
        c.mutate('snf-remove-definition-' + definition['jobDefinitionArn'].split(':')[-1], 'batch', 'deregister_job_definition', jobDefinition=definition['jobDefinitionArn'])
    if resources['profile']:
        if [r['Arn'] for r in resources['profile']['InstanceProfile']['Roles']] not in ([], [role(c, 'host')]): raise RuntimeError('Unexpected profile role')
        if resources['profile']['InstanceProfile']['Roles']:
            c.mutate('snf-remove-profile-role', 'iam', 'remove_role_from_instance_profile', InstanceProfileName=n + '-host', RoleName=n + '-host')
        c.mutate('snf-remove-profile', 'iam', 'delete_instance_profile', InstanceProfileName=n + '-host')
    for suffix, resource in resources['roles'].items():
        for attached in resource['attached']:
            if suffix != 'host' or attached['PolicyArn'] != 'arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role': raise RuntimeError('Unexpected attached bootstrap policy')
            c.mutate('snf-detach-host-policy', 'iam', 'detach_role_policy', RoleName=n + '-host', PolicyArn=attached['PolicyArn'])
        for policy_name in resource['policies']:
            c.mutate('snf-remove-policy-' + suffix, 'iam', 'delete_role_policy', RoleName=n + '-' + suffix, PolicyName=policy_name)
        c.mutate('snf-remove-role-' + suffix, 'iam', 'delete_role', RoleName=n + '-' + suffix)
    if resources['boundary']: c.mutate('snf-remove-boundary', 'iam', 'delete_policy', PolicyArn=b['boundaryArn'])
    for template in resources['templates']: c.mutate('snf-remove-launch-template', 'ec2', 'delete_launch_template', LaunchTemplateId=template['LaunchTemplateId'])
    for group in resources['groups']: c.mutate('snf-remove-security-group', 'ec2', 'delete_security_group', GroupId=group['GroupId'])
    if resources['bucket'] and any(p.get('Contents') for p in c.client('s3').get_paginator('list_objects_v2').paginate(Bucket=c.state['bucket'])):
        raise RuntimeError('Unexpected bucket contents remain; collect and reconcile rather than delete blindly')
    if resources['bucket']: c.mutate('snf-remove-bucket', 's3', 'delete_bucket', Bucket=c.state['bucket'])
    group = '/aws/batch/' + n
    found = [g for p in c.client('logs').get_paginator('describe_log_groups').paginate(logGroupNamePrefix=group) for g in p['logGroups'] if g['logGroupName'] == group]
    if found:
        check_owned(c.client('logs').list_tags_log_group(logGroupName=group)['tags'], c)
        c.mutate('snf-remove-job-logs', 'logs', 'delete_log_group', logGroupName=group)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['bootstrap', 'capture', 'remove']); parser.add_argument('directory', type=Path)
    args = parser.parse_args(); c = Campaign(args.directory)
    if c.config.get('snfIsolation') is not True: raise RuntimeError('Explicit isolated-account mode required')
    globals()[args.mode](c)


if __name__ == '__main__': main()
