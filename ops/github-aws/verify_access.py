#!/usr/bin/env python3
"""Check the QSB human access policies with IAM's policy simulator.

Without --live, simulates the rendered documents. With --live, simulates the
installed qsb-operator and qsb-viewonly roles (which also covers ViewOnlyAccess).
Read-only; works from the qsb-viewonly role. Prints case names and decisions only.
"""
import argparse
import json
import subprocess
from pathlib import Path

from access import access

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--profile', required=True)
p.add_argument('--inventory', type=Path, required=True)
p.add_argument('--live', action='store_true')
a = p.parse_args()
c = json.loads(a.inventory.read_text())
out = access(c)
account, region = c['account'], c['region']
arn = lambda service, resource: f'arn:aws:{service}:{region}:{account}:{resource}'
iam = lambda resource: f'arn:aws:iam::{account}:{resource}'
ctx = lambda key, *values: {'ContextKeyName': key, 'ContextKeyValues': list(values), 'ContextKeyType': 'string'}
tagged = [ctx('aws:ResourceTag/Project', 'qsb-gpu')]
request_tag = [ctx('aws:RequestTag/Project', 'qsb-gpu')]
region_ctx = [ctx('aws:RequestedRegion', region)]
gpu_bound = [ctx('iam:PermissionsBoundary', iam('policy/qsb/bootstrap/qsb-gpu-boundary'))]
gpu_role = iam('role/qsb/runtime/qsb-gpu-job')
queue = arn('batch', 'job-queue/qsb-gpu')

operator_cases = [
    ('submit smoke job', 'batch:SubmitJob', queue, True, []),
    ('submit to other queue', 'batch:SubmitJob', arn('batch', 'job-queue/other'), False, []),
    ('update compute environment', 'batch:UpdateComputeEnvironment', arn('batch', 'compute-environment/qsb-gpu'), True, []),
    ('terminate tagged job', 'batch:TerminateJob', arn('batch', 'job/abc'), True, tagged),
    ('terminate untagged job', 'batch:TerminateJob', arn('batch', 'job/abc'), False, []),
    ('push solver image', 'ecr:PutImage', arn('ecr', 'repository/qsb-solver'), True, []),
    ('push other image', 'ecr:PutImage', arn('ecr', 'repository/other'), False, []),
    ('tagged security group', 'ec2:CreateSecurityGroup', arn('ec2', 'security-group/*'), True, request_tag),
    ('untagged security group', 'ec2:CreateSecurityGroup', arn('ec2', 'security-group/*'), False, []),
    ('gpu egress rule', 'ec2:AuthorizeSecurityGroupEgress', arn('ec2', 'security-group/sg-1'), True, tagged),
    ('any ingress rule', 'ec2:AuthorizeSecurityGroupIngress', arn('ec2', 'security-group/sg-1'), False, tagged),
    ('launch instance directly', 'ec2:RunInstances', arn('ec2', 'instance/*'), False, request_tag),
    ('watchdog rule', 'events:PutRule', arn('events', 'rule/qsb-gpu-watchdog'), True, []),
    ('other rule', 'events:PutRule', arn('events', 'rule/other'), False, []),
    ('bounded gpu role', 'iam:CreateRole', gpu_role, True, gpu_bound),
    ('unbounded gpu role', 'iam:CreateRole', gpu_role, False, []),
    ('gpu role with runtime boundary', 'iam:CreateRole', gpu_role, 'explicitDeny',
     [ctx('iam:PermissionsBoundary', iam('policy/qsb/bootstrap/qsb-runtime-boundary'))]),
    ('assume a runtime role', 'sts:AssumeRole', iam('role/qsb/runtime/qsb-research-api'), 'explicitDeny', []),
    ('pass non-gpu role to tasks', 'iam:PassRole', iam('role/qsb/runtime/qsb-research-api'), False,
     [ctx('iam:PassedToService', 'ecs-tasks.amazonaws.com')]),
    ('terminate job with other tag', 'batch:TerminateJob', arn('batch', 'job/abc'), False,
     [ctx('aws:ResourceTag/Project', 'other')]),
    ('pass gpu role to lambda', 'iam:PassRole', gpu_role, True, [ctx('iam:PassedToService', 'lambda.amazonaws.com')]),
    ('pass gpu role to batch', 'iam:PassRole', gpu_role, False, [ctx('iam:PassedToService', 'batch.amazonaws.com')]),
    ('add gpu boundary', 'iam:PutRolePermissionsBoundary', gpu_role, True, gpu_bound),
    ('remove boundary', 'iam:DeleteRolePermissionsBoundary', gpu_role, False, []),
    ('pass gpu role to tasks', 'iam:PassRole', gpu_role, True, [ctx('iam:PassedToService', 'ecs-tasks.amazonaws.com')]),
    ('pass gpu role to backup', 'iam:PassRole', gpu_role, False, [ctx('iam:PassedToService', 'backup.amazonaws.com')]),
    ('edit operator role', 'iam:PutRolePolicy', iam('role/qsb/bootstrap/qsb-operator'), False, gpu_bound),
    ('edit gpu boundary', 'iam:CreatePolicyVersion', iam('policy/qsb/bootstrap/qsb-gpu-boundary'), False, []),
    ('edit operator user', 'iam:AttachUserPolicy', iam('user/qsb/operators/' + c['operator_user']), False, []),
    ('create access key', 'iam:CreateAccessKey', iam('user/anyone'), False, []),
    ('create user', 'iam:CreateUser', iam('user/anyone'), False, []),
    ('qsb function deploy', 'lambda:UpdateFunctionCode', arn('lambda', 'function:qsb-research-api'), True, []),
    ('state write', 's3:PutObject', f"arn:aws:s3:::{c['state_bucket']}/qsb/gpu/terraform.tfstate", True, []),
    ('gpu job input', 's3:PutObject', f'arn:aws:s3:::qsb-gpu-{account}-{region}-jobs/inputs/x', True, []),
    ('unrelated bucket', 's3:PutObject', 'arn:aws:s3:::unrelated/x', False, []),
]
viewonly_cases = [
    ('describe queues', 'batch:DescribeJobQueues', '*', True, []),
    ('list schedules', 'scheduler:ListSchedules', '*', True, []),
    ('simulate policy', 'iam:SimulateCustomPolicy', '*', True, []),
    ('read object', 's3:GetObject', 'arn:aws:s3:::any/x', False, []),
    ('read item', 'dynamodb:GetItem', arn('dynamodb', 'table/qsb-records'), False, []),
    ('read secret', 'secretsmanager:GetSecretValue', arn('secretsmanager', 'secret:any'), False, []),
    ('read logs', 'logs:GetLogEvents', arn('logs', 'log-group:any:*'), False, []),
    ('submit job', 'batch:SubmitJob', queue, False, []),
    ('read object version', 's3:GetObjectVersion', 'arn:aws:s3:::any/x', False, []),
    ('read stack template', 'cloudformation:GetTemplate', arn('cloudformation', 'stack/any/*'), 'explicitDeny', []),
    ('assume any role', 'sts:AssumeRole', iam('role/any'), 'explicitDeny', []),
]
gpu_cases = [
    ('boundary: job input read', 's3:GetObject', f'arn:aws:s3:::qsb-gpu-{account}-{region}-jobs/inputs/x', True, []),
    ('boundary: job input write', 's3:PutObject', f'arn:aws:s3:::qsb-gpu-{account}-{region}-jobs/inputs/x', False, []),
    ('boundary: ecs agent', 'ecs:Poll', '*', True, region_ctx),
    ('boundary: submit job', 'batch:SubmitJob', queue, False, []),
    ('boundary: secret', 'secretsmanager:GetSecretValue', arn('secretsmanager', 'secret:any'), False, []),
]


def simulate(label, documents, role, cases):
    for name, action, resource, allowed, context in cases:
        if a.live and role:
            args = ['simulate-principal-policy', '--policy-source-arn', iam(f'role/qsb/bootstrap/{role}')]
        else:
            args = ['simulate-custom-policy', '--policy-input-list', *[json.dumps(d) for d in documents]]
        args += ['--action-names', action, '--resource-arns', resource]
        if context:
            args += ['--context-entries', json.dumps(context)]
        r = subprocess.run(['aws', '--profile', a.profile, '--region', region, '--output', 'json', 'iam', *args],
                           capture_output=True, text=True)
        if r.returncode:
            raise SystemExit(f'{label}/{name}: simulator call failed')
        decision = json.loads(r.stdout)['EvaluationResults'][0]['EvalDecision']
        # A string expectation names the exact decision, so a guard deny can't pass as an implicit one.
        ok = decision == allowed if isinstance(allowed, str) else (decision == 'allowed') == allowed
        assert ok, (label, name, decision)
        print(f'{label}: {name}: {decision}', flush=True)


simulate('operator', out['operator']['policies'], 'qsb-operator', operator_cases)
simulate('viewonly', out['viewonly']['policies'], 'qsb-viewonly', viewonly_cases)
simulate('gpu-boundary', [out['gpu_boundary']['document']], None, gpu_cases)
user_cases = [
    ('assume operator', 'sts:AssumeRole', iam('role/qsb/bootstrap/qsb-operator'), True, []),
    ('assume the reconcile role', 'sts:AssumeRole', iam('role/qsb/runtime/qsb-research-operator-reconcile'),
     'explicitDeny', []),
    ('assume operator-made runtime role', 'sts:AssumeRole', iam('role/qsb/runtime/qsb-research-api'), 'explicitDeny', []),
    ('read records directly', 'dynamodb:GetItem', arn('dynamodb', 'table/qsb-research-records'), 'explicitDeny', []),
    ('invoke a function directly', 'lambda:InvokeFunction', arn('lambda', 'function:qsb-research-api'), 'explicitDeny', []),
    ('create access key', 'iam:CreateAccessKey', iam('user/qsb/operators/' + c['operator_user']), 'explicitDeny', []),
]
simulate('user', [out['user']['inline']], None, user_cases)
total = len(operator_cases) + len(viewonly_cases) + len(gpu_cases) + len(user_cases)
print(f'Passed {total} IAM simulations.', flush=True)
