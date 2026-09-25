#!/usr/bin/env python3
"""Render the human access identities for the QSB account from the private inventory.

No AWS mutations. Uses the render.py inventory plus `operator_user`, the name of
the one IAM user (path /qsb/operators/) that may assume these roles with MFA, and
`gpu_vpc`, the VPC the GPU stack's security group lives in:

- qsb-viewonly: AWS ViewOnlyAccess plus the Batch/Scheduler/IAM describe calls it
  lacks, with an explicit deny on reading data (objects, items, secrets, logs, code).
- qsb-operator: the qsb-github-deploy scope, plus the operator-applied GPU stack
  (terraform/gpu) and its smoke submissions. No ingress, instance launches,
  users or static credentials. GPU runtime roles must carry qsb-gpu-boundary.
"""
import argparse
import json
from pathlib import Path

from render import render

VIEW_ONLY_MANAGED = 'arn:aws:iam::aws:policy/job-function/ViewOnlyAccess'
SIGN_IN_MANAGED = 'arn:aws:iam::aws:policy/SignInLocalDevelopmentAccess'
ECS_INSTANCE_MANAGED = 'arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role'
MANAGED_POLICY_LIMIT = 6144  # IAM counts characters excluding whitespace.
GPU_TAG = {'Project': 'qsb-gpu'}


def size(document):
    return len(json.dumps(document, separators=(',', ':')).replace(' ', ''))


def chunk(statements, limit=6000):
    """Pack statements into as few managed policy documents as fit the IAM size limit."""
    docs, current = [], []
    for statement in statements:
        trial = current + [statement]
        if current and size({'Version': '2012-10-17', 'Statement': trial}) > limit:
            docs.append(current)
            current = [statement]
        else:
            current = trial
    if current:
        docs.append(current)
    return [{'Version': '2012-10-17', 'Statement': s} for s in docs]


def access(c):
    account, region, user = c['account'], c['region'], c['operator_user']
    arn = lambda service, resource: f'arn:aws:{service}:{region}:{account}:{resource}'
    iam = lambda resource: f'arn:aws:iam::{account}:{resource}'
    in_region = {'StringEquals': {'aws:RequestedRegion': region}}
    user_arn = iam('user/qsb/operators/' + user)
    viewonly_role, operator_role = iam('role/qsb/bootstrap/qsb-viewonly'), iam('role/qsb/bootstrap/qsb-operator')
    gpu_boundary = iam('policy/qsb/bootstrap/qsb-gpu-boundary')
    runtime_boundary = iam('policy/qsb/bootstrap/qsb-runtime-boundary')
    gpu_roles = iam('role/qsb/runtime/qsb-gpu-*')
    gpu_profiles = iam('instance-profile/qsb/runtime/qsb-gpu-*')
    jobs_bucket = f'arn:aws:s3:::qsb-gpu-{account}-{region}-jobs'
    batch_log = arn('logs', 'log-group:/aws/batch/qsb-gpu')
    watchdog_log = arn('logs', 'log-group:/aws/lambda/qsb-gpu-watchdog')

    def allow(sid, actions, resources, condition=None):
        s = dict(Sid=sid, Effect='Allow', Action=actions, Resource=resources)
        if condition:
            s['Condition'] = condition
        return s

    def deny(sid, actions, resources):
        return dict(Sid=sid, Effect='Deny', Action=actions, Resource=resources)

    trust = {'Version': '2012-10-17', 'Statement': [{
        'Effect': 'Allow', 'Principal': {'AWS': user_arn}, 'Action': 'sts:AssumeRole',
        'Condition': {'Bool': {'aws:MultiFactorAuthPresent': 'true'},
                      # Require recent MFA context when supplied; aws login refresh semantics need live verification.
                      'NumericLessThanIfExists': {'aws:MultiFactorAuthAge': '3600'}}}]}

    # The user can sign in (console, `aws login`) and assume the two bootstrap roles, which the
    # operator cannot edit; nothing else. The explicit denies also override any resource policy
    # or runtime-role trust the operator might write naming this user. Reconcile runs as qsb-operator.
    user_actions = ['sts:AssumeRole', 'iam:ChangePassword', 'iam:GetUser', 'iam:GetAccountPasswordPolicy',
                    'signin:Authenticate', 'signin:AuthorizeOAuth2Access', 'signin:CreateOAuth2Token']
    user_policy = {'Version': '2012-10-17', 'Statement': [
        allow('AssumeQsbRoles', ['sts:AssumeRole'], [viewonly_role, operator_role]),
        dict(Sid='OnlyTheseRoles', Effect='Deny', Action=['sts:AssumeRole'], NotResource=[viewonly_role, operator_role]),
        dict(Sid='NothingElse', Effect='Deny', NotAction=user_actions, Resource=['*']),
        allow('OwnPassword', ['iam:ChangePassword', 'iam:GetUser'], [user_arn]),
        allow('PasswordPolicy', ['iam:GetAccountPasswordPolicy'], ['*']),
    ]}

    viewonly = {'Version': '2012-10-17', 'Statement': [
        allow('DescribeGaps', [
            'batch:DescribeComputeEnvironments', 'batch:DescribeJobQueues', 'batch:DescribeJobDefinitions',
            'batch:DescribeJobs', 'batch:ListJobs', 'batch:ListTagsForResource',
            'scheduler:ListSchedules', 'scheduler:ListScheduleGroups', 'scheduler:GetSchedule',
            'ecr:DescribeImages', 'iam:GetRole', 'iam:GetRolePolicy', 'iam:GetPolicy', 'iam:GetPolicyVersion',
            'iam:GetInstanceProfile', 'iam:GetUser', 'iam:GetAccessKeyLastUsed',
            'iam:SimulateCustomPolicy', 'iam:SimulatePrincipalPolicy',
            'ce:GetCostAndUsage', 'ce:GetCostForecast'], ['*']),
        # ViewOnlyAccess is metadata-only today; keep data reads denied even if AWS widens it.
        deny('NoDataReads', [
            's3:GetObject*', 'athena:GetQueryResults', 'cloudformation:GetTemplate', 'ec2:GetConsoleOutput',
            'ec2:GetConsoleScreenshot', 'dynamodb:GetRecords', 'ssm:GetParameterHistory',
            'secretsmanager:BatchGetSecretValue', 'logs:StartLiveTail', 'logs:GetLogRecord', 'logs:Unmask',
            'lambda:GetLayerVersion',
            'dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:Scan',
            'dynamodb:PartiQLSelect', 'dynamodb:ExportTableToPointInTime',
            'secretsmanager:GetSecretValue', 'ssm:GetParameter', 'ssm:GetParameters',
            'ssm:GetParametersByPath', 'kms:Decrypt', 'logs:GetLogEvents', 'logs:FilterLogEvents',
            'logs:StartQuery', 'logs:GetQueryResults', 'lambda:GetFunction',
            'states:DescribeExecution', 'states:GetExecutionHistory',
            'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:GetAuthorizationToken'], ['*']),
        deny('NoRoleChaining', ['sts:AssumeRole'], ['*']),
    ]}

    deploy = [s for s in render(c)['deploy']['Statement'] if s['Effect'] == 'Allow']
    gpu = [
        allow('GpuBatch', ['batch:*'], [arn('batch', 'compute-environment/qsb-gpu'), arn('batch', 'job-queue/qsb-gpu'),
                                        arn('batch', 'job-definition/qsb-gpu-solver'), arn('batch', 'job-definition/qsb-gpu-solver:*')]),
        allow('GpuBatchRead', ['batch:Describe*', 'batch:List*'], ['*'], in_region),
        allow('GpuSmokeJobs', ['batch:TagResource', 'batch:CancelJob', 'batch:TerminateJob'], [arn('batch', 'job/*')],
              {'StringEquals': {'aws:ResourceTag/Project': 'qsb-gpu'}}),
        allow('GpuSmokeJobTags', ['batch:TagResource'], [arn('batch', 'job/*')],
              {'StringEquals': {'aws:RequestTag/Project': 'qsb-gpu'}}),
        allow('GpuRegistry', ['ecr:*'], [arn('ecr', 'repository/qsb-solver')]),
        allow('RegistryLogin', ['ecr:GetAuthorizationToken'], ['*']),
        allow('GpuLogs', ['logs:*'], [batch_log, batch_log + ':*']),
        allow('GpuEvents', ['events:*'], [arn('events', 'rule/qsb-gpu-*')]),
        allow('Ec2Read', ['ec2:Describe*', 'ec2:GetLaunchTemplateData'], ['*'], in_region),
        allow('CreateTaggedSecurityGroup', ['ec2:CreateSecurityGroup'], [arn('ec2', 'security-group/*')],
              {'StringEquals': {'aws:RequestTag/Project': 'qsb-gpu'}}),
        allow('SecurityGroupInGpuVpc', ['ec2:CreateSecurityGroup'], [arn('ec2', 'vpc/' + c['gpu_vpc'])]),
        allow('CreateTaggedLaunchTemplate', ['ec2:CreateLaunchTemplate'], [arn('ec2', 'launch-template/*')],
              {'StringEquals': {'aws:RequestTag/Project': 'qsb-gpu'}}),
        allow('TagOnGpuCreate', ['ec2:CreateTags'], [arn('ec2', 'security-group/*'), arn('ec2', 'launch-template/*')],
              {'StringEquals': {'ec2:CreateAction': ['CreateSecurityGroup', 'CreateLaunchTemplate']}}),
        # Egress only: this role has no ingress, RunInstances or network-creation grant.
        allow('ManageGpuNetworkObjects', [
            'ec2:AuthorizeSecurityGroupEgress', 'ec2:RevokeSecurityGroupEgress', 'ec2:DeleteSecurityGroup',
            'ec2:UpdateSecurityGroupRuleDescriptionsEgress', 'ec2:CreateTags', 'ec2:DeleteTags',
            'ec2:CreateLaunchTemplateVersion', 'ec2:ModifyLaunchTemplate', 'ec2:DeleteLaunchTemplate',
            'ec2:DeleteLaunchTemplateVersions'],
            [arn('ec2', 'security-group/*'), arn('ec2', 'launch-template/*'), arn('ec2', 'security-group-rule/*')],
            {'StringEquals': {'aws:ResourceTag/Project': 'qsb-gpu'}}),
        allow('CreateBoundedGpuRoles', ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy',
                                        'iam:UpdateAssumeRolePolicy', 'iam:PutRolePermissionsBoundary'],
              [gpu_roles], {'StringEquals': {'iam:PermissionsBoundary': gpu_boundary}}),
        allow('GpuInstanceProfiles', ['iam:CreateInstanceProfile', 'iam:DeleteInstanceProfile', 'iam:GetInstanceProfile',
                                      'iam:AddRoleToInstanceProfile', 'iam:RemoveRoleFromInstanceProfile',
                                      'iam:TagInstanceProfile', 'iam:UntagInstanceProfile',
                                      'iam:ListInstanceProfileTags'], [gpu_profiles]),
        allow('PassGpuRoles', ['iam:PassRole'], [gpu_roles],
              {'StringEquals': {'iam:PassedToService': ['ec2.amazonaws.com', 'ecs-tasks.amazonaws.com']}}),
        allow('BatchServiceRoles', ['iam:CreateServiceLinkedRole'], ['*'],
              {'StringEquals': {'iam:AWSServiceName': ['batch.amazonaws.com', 'ecs.amazonaws.com']}}),
    ]
    guards = [
        dict(Sid='OnlyRequiredLambdaPrincipals', Effect='Deny', Action=['lambda:AddPermission'],
             Resource=['*'], Condition={'StringNotEquals': {
                 'lambda:Principal': ['apigateway.amazonaws.com', 'events.amazonaws.com']}}),
        deny('NoFunctionUrlsOrExternalResourcePolicies', [
            'lambda:CreateFunctionUrlConfig', 'lambda:UpdateFunctionUrlConfig',
            'dynamodb:PutResourcePolicy', 'ecr:SetRepositoryPolicy'], ['*']),
        deny('ProtectBootstrapIdentities', ['iam:*'], [iam('role/qsb/bootstrap/*'), iam('policy/qsb/bootstrap/*'),
                                                        iam('user/qsb/*')]),
        deny('NeverRemoveBoundaries', ['iam:DeleteRolePermissionsBoundary'], [iam('role/qsb/runtime/*')]),
        # The inherited deploy grant also matches qsb-gpu-*; GPU roles may carry only the GPU boundary.
        dict(Sid='GpuRolesOnlyWithGpuBoundary', Effect='Deny',
             Action=['iam:CreateRole', 'iam:PutRolePermissionsBoundary', 'iam:PutRolePolicy', 'iam:AttachRolePolicy',
                     'iam:UpdateAssumeRolePolicy'], Resource=[gpu_roles],
             Condition={'StringNotEquals': {'iam:PermissionsBoundary': gpu_boundary}}),
        # Editing a runtime role's trust must not let the operator become that role.
        deny('NoRoleChaining', ['sts:AssumeRole'], ['*']),
        deny('NoStaticCredentialsOrUsers', [
            'iam:CreateUser', 'iam:CreateAccessKey', 'iam:UpdateAccessKey', 'iam:CreateLoginProfile',
            'iam:UpdateLoginProfile', 'iam:CreateServiceSpecificCredential', 'iam:UploadSSHPublicKey',
            'iam:CreateVirtualMFADevice', 'iam:DeactivateMFADevice', 'iam:AttachUserPolicy', 'iam:PutUserPolicy',
            'iam:AddUserToGroup', 'iam:CreatePolicyVersion', 'iam:SetDefaultPolicyVersion'], ['*']),
        deny('NoIngressOrInstances', ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RunInstances',
                                      'ec2:CreateVpc', 'ec2:CreateInternetGateway', 'ec2:CreateNatGateway',
                                      'ec2:AllocateAddress'], ['*']),
    ]
    operator = chunk(deploy + gpu + guards)

    # Everything the GPU stack's runtime roles use: the ECS instance managed policy,
    # the job/execution/watchdog inline policies, and nothing outside the GPU stack.
    gpu_boundary_doc = {'Version': '2012-10-17', 'Statement': [
        allow('EcsInstanceAgent', ['ec2:DescribeTags', 'ecs:CreateCluster', 'ecs:DeregisterContainerInstance',
                                   'ecs:DiscoverPollEndpoint', 'ecs:Poll', 'ecs:RegisterContainerInstance',
                                   'ecs:StartTelemetrySession', 'ecs:UpdateContainerInstancesState', 'ecs:Submit*',
                                   'ecs:ListTagsForResource'], ['*'], in_region),
        allow('EcsInstanceTags', ['ecs:TagResource'], ['*'],
              {'StringEquals': {'ecs:CreateAction': ['CreateCluster', 'RegisterContainerInstance']}}),
        allow('PullSolver', ['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
              [arn('ecr', 'repository/qsb-solver')]),
        allow('RegistryLogin', ['ecr:GetAuthorizationToken'], ['*']),
        allow('GpuLogStreams', ['logs:CreateLogStream', 'logs:PutLogEvents'],
              [batch_log + ':*', watchdog_log + ':*']),
        allow('JobInputs', ['s3:GetObject'], [jobs_bucket + '/inputs/*']),
        allow('JobOutputs', ['s3:PutObject'], [jobs_bucket + '/outputs/*']),
        allow('WatchdogRead', ['batch:ListJobs', 'batch:DescribeJobs'], ['*'], in_region),
        allow('WatchdogTerminate', ['batch:TerminateJob'], [arn('batch', 'job/*')],
              {'StringEquals': {'aws:ResourceTag/Project': 'qsb-gpu'}}),
    ]}

    return {
        'user': {'name': user, 'path': '/qsb/operators/', 'managed': [SIGN_IN_MANAGED], 'inline': user_policy},
        'viewonly': {'name': 'qsb-viewonly', 'path': '/qsb/bootstrap/', 'trust': trust, 'managed': [VIEW_ONLY_MANAGED],
                     'policies': [viewonly], 'max_session': 14400},
        'operator': {'name': 'qsb-operator', 'path': '/qsb/bootstrap/', 'trust': trust, 'managed': [],
                     'policies': operator, 'max_session': 3600},
        'gpu_boundary': {'name': 'qsb-gpu-boundary', 'path': '/qsb/bootstrap/', 'document': gpu_boundary_doc},
        'runtime_boundary': runtime_boundary,
    }


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('inventory', type=Path)
    p.add_argument('output', type=Path)
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=True)
    out = access(json.loads(a.inventory.read_text()))
    (a.output / 'user.json').write_text(json.dumps(out['user']['inline'], indent=2) + '\n')
    (a.output / 'trust.json').write_text(json.dumps(out['viewonly']['trust'], indent=2) + '\n')
    (a.output / 'gpu-boundary.json').write_text(json.dumps(out['gpu_boundary']['document'], indent=2) + '\n')
    for role in ('viewonly', 'operator'):
        for i, doc in enumerate(out[role]['policies'], 1):
            (a.output / f'{role}-{i}.json').write_text(json.dumps(doc, indent=2) + '\n')
