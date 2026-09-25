#!/usr/bin/env python3
"""Render reviewed QSB deployment policies from a private account inventory.

No AWS mutations. Use an inventory with account, region, subject, distributions,
apis, origin_access_controls, response_headers_policies and state_bucket.
"""
import argparse
import json
from pathlib import Path


def render(c):
    account, region = c['account'], c['region']
    arn = lambda service, resource: f'arn:aws:{service}:{region}:{account}:{resource}'
    iam = lambda resource: f'arn:aws:iam::{account}:{resource}'
    cf = lambda resource: f'arn:aws:cloudfront::{account}:{resource}'
    role = iam('role/qsb/bootstrap/qsb-github-deploy')
    boundary = iam('policy/qsb/bootstrap/qsb-runtime-boundary')
    runtime_roles = iam('role/qsb/runtime/qsb-*')
    statements = []
    def allow(sid, actions, resources, condition=None, target=None):
        s = dict(Sid=sid, Effect='Allow', Action=actions, Resource=resources)
        if condition: s['Condition'] = condition
        (statements if target is None else target).append(s)
    named = {
        'lambda': ['function:qsb-*', 'function:QsbVault*', 'function:QsbXverse*'],
        'dynamodb': ['table/qsb-*', 'table/QsbVault*'],
        'states': ['stateMachine:qsb-*', 'stateMachine:QsbVault*', 'stateMachine:QsbXverse*'],
        'cloudwatch': ['alarm:qsb-*', 'alarm:QsbVault*', 'alarm:QsbXverse*'],
    }
    for service, resources in named.items():
        allow(service.title()+'Qsb', [service+':*'], [arn(service,r) for r in resources])
    allow('QsbBuckets', ['s3:*'], [f'arn:aws:s3:::qsb-*-{account}-{region}-*',f'arn:aws:s3:::qsb-*-{account}-{region}-*/*', 'arn:aws:s3:::qsbvaultweb-*','arn:aws:s3:::qsbvaultweb-*/*','arn:aws:s3:::qsbvaulttestnet4web-*','arn:aws:s3:::qsbvaulttestnet4web-*/*'])
    log_arns = [arn('logs','log-group:'+x) for x in ['/qsb/qsb-*','/aws/lambda/qsb-*','/aws/vendedlogs/states/qsb-*','QsbVault*','QsbXverse*']]
    allow('QsbLogs', ['logs:*'], log_arns)
    allow('RegionalDiscovery', ['logs:DescribeLogGroups','lambda:ListFunctions','states:ListStateMachines','cloudwatch:DescribeAlarms'], ['*'], {'StringEquals':{'aws:RequestedRegion':region}})
    # AWS has no tag/name authorization for OAC/response-header policy IDs.
    # Admin registers exact IDs; no wildcard permission to modify other projects.
    edge = [cf('distribution/'+x) for x in c['distributions']]
    edge += [cf('origin-access-control/'+x) for x in c['origin_access_controls']]
    edge += [cf('response-headers-policy/'+x) for x in c['response_headers_policies']]
    allow('RegisteredQsbCloudFront', ['cloudfront:*'], edge)
    allow('CloudFrontDiscovery', ['cloudfront:ListDistributions','cloudfront:ListOriginAccessControls','cloudfront:ListResponseHeadersPolicies','cloudfront:ListCachePolicies','cloudfront:GetCachePolicy','cloudfront:GetOriginRequestPolicy'], ['*'])
    api_resources = [f'arn:aws:apigateway:{region}::/apis/{x}'+suffix for x in c['apis'] for suffix in ['', '/*']]
    allow('RegisteredQsbApis', ['apigateway:GET','apigateway:POST','apigateway:PUT','apigateway:PATCH','apigateway:DELETE'],api_resources)
    allow('ApiDiscovery',['apigateway:GET'],[f'arn:aws:apigateway:{region}::/apis'])
    allow('CreateBoundedRuntimeRoles',['iam:CreateRole','iam:PutRolePolicy','iam:AttachRolePolicy','iam:UpdateAssumeRolePolicy','iam:PutRolePermissionsBoundary'],[runtime_roles],{'StringEquals':{'iam:PermissionsBoundary':boundary}})
    allow('ManageRuntimeRoles',['iam:GetRole','iam:ListInstanceProfilesForRole','iam:GetRolePolicy','iam:ListRolePolicies','iam:ListAttachedRolePolicies','iam:ListRoleTags','iam:TagRole','iam:UntagRole','iam:DeleteRolePolicy','iam:DetachRolePolicy','iam:DeleteRole','iam:UpdateRole','iam:UpdateRoleDescription'],[runtime_roles])
    allow('ReadRuntimeBoundary',['iam:GetPolicy','iam:GetPolicyVersion'],[boundary])
    allow('PassRuntimeRoles',['iam:PassRole'],[runtime_roles],{'StringEquals':{'iam:PassedToService':['lambda.amazonaws.com','states.amazonaws.com']}})
    allow('StateList',['s3:ListBucket','s3:GetBucketLocation'],['arn:aws:s3:::'+c['state_bucket']])
    allow('StateObjects',['s3:GetObject','s3:PutObject'],['arn:aws:s3:::'+c['state_bucket']+'/qsb/*'])
    allow('StateLocks',['s3:DeleteObject'],['arn:aws:s3:::'+c['state_bucket']+'/qsb/*.tflock'])
    statements.append(dict(Sid='ProtectBootstrapAndBoundaries',Effect='Deny',Action=['iam:*'],Resource=[role,iam('policy/qsb/bootstrap/*')]))
    statements.append(dict(Sid='NeverRemoveRuntimeBoundary',Effect='Deny',Action=['iam:DeleteRolePermissionsBoundary'],Resource=[runtime_roles]))
    # Runtime identities may access QSB application data, not IAM/control planes.
    runtime = []
    # Must cover every DynamoDB action the runtime role policies (terraform/policies/*.json) allow; reservations
    # add a SYSTEM# ConditionCheck, so ConditionCheckItem is required or every reservation is refused.
    allow('Records',['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:ConditionCheckItem','dynamodb:BatchGetItem','dynamodb:BatchWriteItem','dynamodb:Query','dynamodb:Scan','dynamodb:DescribeTable'],[arn('dynamodb','table/qsb-*')],target=runtime)
    allow('Functions',['lambda:InvokeFunction'],[arn('lambda','function:qsb-*')],target=runtime)
    allow('Workflow',['states:StartExecution','states:DescribeExecution'],[arn('states','stateMachine:qsb-*'),arn('states','execution:qsb-*:*')],target=runtime)
    allow('RuntimeLogs',['logs:CreateLogStream','logs:PutLogEvents'],log_arns,target=runtime)
    allow('BatchRead',['batch:DescribeJobs','batch:DescribeJobDefinitions','batch:DescribeJobQueues','batch:DescribeComputeEnvironments','batch:ListJobs'],['*'],{'StringEquals':{'aws:RequestedRegion':region}},runtime)
    allow('BatchSubmit',['batch:SubmitJob'],[arn('batch','job-queue/qsb-gpu'),arn('batch','job-definition/qsb-gpu-solver:*')],target=runtime)
    allow('BatchTag',['batch:TagResource'],[arn('batch','job/*')],{'StringEquals':{'aws:RequestTag/Project':'qsb-gpu'},'ForAllValues:StringEquals':{'aws:TagKeys':['Project','QsbRequest','InputSha256']}},runtime)
    allow('BatchCancel',['batch:CancelJob','batch:TerminateJob'],[arn('batch','job/*')],{'StringEquals':{'aws:ResourceTag/Project':'qsb-gpu'}},runtime)
    allow('GpuInputs',['s3:PutObject'],[f'arn:aws:s3:::qsb-gpu-{account}-{region}-jobs/inputs/*'],target=runtime)
    allow('GpuOutputs',['s3:GetObject'],[f'arn:aws:s3:::qsb-gpu-{account}-{region}-jobs/outputs/*'],target=runtime)
    # AWS log-delivery control APIs have no resource-level authorization.
    allow('WorkflowLogDelivery',['logs:CreateLogDelivery','logs:GetLogDelivery','logs:UpdateLogDelivery','logs:DeleteLogDelivery','logs:ListLogDeliveries','logs:PutResourcePolicy','logs:DescribeResourcePolicies','logs:DescribeLogGroups'],['*'],{'StringEquals':{'aws:RequestedRegion':region}},runtime)
    trust={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Federated':iam('oidc-provider/token.actions.githubusercontent.com')},'Action':'sts:AssumeRoleWithWebIdentity','Condition':{'StringEquals':{'token.actions.githubusercontent.com:aud':'sts.amazonaws.com','token.actions.githubusercontent.com:sub':c['subject']}}}]}
    return {'trust':trust,'deploy':{'Version':'2012-10-17','Statement':statements},'boundary':{'Version':'2012-10-17','Statement':runtime}}


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('inventory',type=Path);p.add_argument('output',type=Path)
    a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
    for name,policy in render(json.loads(a.inventory.read_text())).items():
        (a.output/(name+'.json')).write_text(json.dumps(policy,indent=2)+'\n')
