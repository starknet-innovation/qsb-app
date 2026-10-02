#!/usr/bin/env python3
"""Render reviewed QSB deployment policies from a private account inventory.

No AWS mutations. Use an inventory with account, region, subject, distributions,
origin_access_controls, response_headers_policies, api_functions and state_bucket.
"""
import argparse
import json
import re
from pathlib import Path


def registered(c, kind):
    """The inventory's IDs of one kind of edge resource, or a placeholder that matches nothing.

    A new account has none registered until the administrator's first apply. IAM refuses an empty
    Resource, and leaving the statements out would change the policy count when IDs are registered."""
    return c[kind] or ['UNREGISTERED']


def api_functions(c):
    """The app stacks' API functions (terraform/compute.tf names them <name>-api), each with a role of the same
    name: the only ones that may read the MARA credential. Unlike CloudFront IDs, the names are known before the
    first apply, so they're required: a missing or malformed list stops the render rather than lock the API out."""
    names = c.get('api_functions')
    if not (isinstance(names, list) and names and all(isinstance(n, str) and re.fullmatch(r'qsb-(?!gpu-)[a-z0-9-]+-api', n)
                                                      for n in names)):
        raise SystemExit('The inventory needs api_functions: the API function names, such as ["qsb-app-api"]')
    return names


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
    # The AWS provider calls ValidateStateMachineDefinition at plan time whenever a state machine's definition
    # changes; the action takes no resource, so the qsb-* StatesQsb grant doesn't cover it.
    allow('RegionalDiscovery', ['logs:DescribeLogGroups','lambda:ListFunctions','states:ListStateMachines','states:ValidateStateMachineDefinition','cloudwatch:DescribeAlarms'], ['*'], {'StringEquals':{'aws:RequestedRegion':region}})
    # AWS has no tag/name authorization for OAC/response-header policy IDs.
    # Admin registers exact IDs; no wildcard permission to modify other projects.
    edge = [cf('distribution/'+x) for x in registered(c, 'distributions')]
    edge += [cf('origin-access-control/'+x) for x in registered(c, 'origin_access_controls')]
    edge += [cf('response-headers-policy/'+x) for x in registered(c, 'response_headers_policies')]
    allow('RegisteredQsbCloudFront', ['cloudfront:*'], edge)
    allow('CloudFrontDiscovery', ['cloudfront:ListDistributions','cloudfront:ListOriginAccessControls','cloudfront:ListResponseHeadersPolicies','cloudfront:ListCachePolicies','cloudfront:GetCachePolicy','cloudfront:GetOriginRequestPolicy'], ['*'])
    allow('CreateBoundedRuntimeRoles',['iam:CreateRole','iam:PutRolePolicy','iam:AttachRolePolicy','iam:UpdateAssumeRolePolicy','iam:PutRolePermissionsBoundary'],[runtime_roles],{'StringEquals':{'iam:PermissionsBoundary':boundary}})
    allow('ManageRuntimeRoles',['iam:GetRole','iam:ListInstanceProfilesForRole','iam:GetRolePolicy','iam:ListRolePolicies','iam:ListAttachedRolePolicies','iam:ListRoleTags','iam:TagRole','iam:UntagRole','iam:DeleteRolePolicy','iam:DetachRolePolicy','iam:DeleteRole','iam:UpdateRole','iam:UpdateRoleDescription'],[runtime_roles])
    allow('ReadRuntimeBoundary',['iam:GetPolicy','iam:GetPolicyVersion'],[boundary])
    # Scheduler runs the webhook dispatcher's schedule with its own runtime role (terraform/webhooks.tf). A separate
    # name-scoped PassRole adds nothing, since this role can create a runtime role of any qsb-* name, and it would
    # push qsb-operator (access.py) into another managed policy, which update_installed.py can't add.
    allow('PassRuntimeRoles',['iam:PassRole'],[runtime_roles],{'StringEquals':{'iam:PassedToService':['lambda.amazonaws.com','states.amazonaws.com','scheduler.amazonaws.com']}})
    # EventBridge Scheduler schedules named qsb-* in the default group. Schedules carry no tags.
    allow('QsbSchedules',['scheduler:CreateSchedule','scheduler:GetSchedule','scheduler:UpdateSchedule','scheduler:DeleteSchedule'],[arn('scheduler','schedule/default/qsb-*')])
    allow('StateList',['s3:ListBucket','s3:GetBucketLocation'],['arn:aws:s3:::'+c['state_bucket']])
    allow('StateObjects',['s3:GetObject','s3:PutObject'],['arn:aws:s3:::'+c['state_bucket']+'/qsb/*'])
    allow('StateLocks',['s3:DeleteObject'],['arn:aws:s3:::'+c['state_bucket']+'/qsb/*.tflock'])
    statements.append(dict(Sid='ProtectBootstrapAndBoundaries',Effect='Deny',Action=['iam:*'],Resource=[role,iam('policy/qsb/bootstrap/*')]))
    statements.append(dict(Sid='NeverRemoveRuntimeBoundary',Effect='Deny',Action=['iam:DeleteRolePermissionsBoundary'],Resource=[runtime_roles]))
    # The API's function URL takes AWS_IAM auth, which CloudFront signs for through origin access control. Never a
    # public one. Null=false limits the deny to requests that name an auth type: an update that names none keeps
    # the URL's current one, and CreateFunctionUrlConfig always names one.
    statements.append(dict(Sid='OnlyIamFunctionUrls',Effect='Deny',Action=['lambda:CreateFunctionUrlConfig','lambda:UpdateFunctionUrlConfig'],Resource=['*'],Condition={'StringNotEquals':{'lambda:FunctionUrlAuthType':'AWS_IAM'},'Null':{'lambda:FunctionUrlAuthType':'false'}}))
    # Function grants only for the services that invoke QSB functions: CloudFront, through origin access control to
    # the API's function URL, and EventBridge, for the GPU watchdog. lambda:* on qsb-* would otherwise let a deploy
    # grant any account the function URL, and with it a way around CloudFront.
    statements.append(dict(Sid='OnlyRequiredLambdaPrincipals',Effect='Deny',Action=['lambda:AddPermission'],Resource=['*'],Condition={'StringNotEquals':{'lambda:Principal':['cloudfront.amazonaws.com','events.amazonaws.com']}}))
    # Runtime identities may access QSB application data, not IAM/control planes.
    runtime = []
    # Must cover every DynamoDB action the runtime role policies (terraform/policies/*.json) allow. Transactions
    # condition-check rows they don't write (the vault row at submit), so ConditionCheckItem is required.
    allow('Records',['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem','dynamodb:DeleteItem','dynamodb:ConditionCheckItem','dynamodb:BatchGetItem','dynamodb:BatchWriteItem','dynamodb:Query','dynamodb:Scan','dynamodb:DescribeTable'],[arn('dynamodb','table/qsb-*')],target=runtime)
    allow('Functions',['lambda:InvokeFunction'],[arn('lambda','function:qsb-*')],target=runtime)
    allow('Workflow',['states:StartExecution','states:DescribeExecution'],[arn('states','stateMachine:qsb-*'),arn('states','execution:qsb-*:*')],target=runtime)
    allow('RuntimeLogs',['logs:CreateLogStream','logs:PutLogEvents'],log_arns,target=runtime)
    allow('BatchRead',['batch:DescribeJobs','batch:DescribeJobDefinitions','batch:DescribeJobQueues','batch:DescribeComputeEnvironments','batch:ListJobs'],['*'],{'StringEquals':{'aws:RequestedRegion':region}},runtime)
    allow('BatchSubmit',['batch:SubmitJob'],[arn('batch','job-queue/qsb-gpu'),arn('batch','job-definition/qsb-gpu-solver:*')],target=runtime)
    # SubmitJob with tags is authorized for TagResource on the queue and job definition as well as the job.
    allow('BatchTag',['batch:TagResource'],[arn('batch','job/*'),arn('batch','job-queue/qsb-gpu'),arn('batch','job-definition/qsb-gpu-solver:*')],{'StringEquals':{'aws:RequestTag/Project':'qsb-gpu'},'ForAllValues:StringEquals':{'aws:TagKeys':['Project','QsbRequest','InputSha256']}},runtime)
    allow('BatchCancel',['batch:CancelJob','batch:TerminateJob'],[arn('batch','job/*')],{'StringEquals':{'aws:ResourceTag/Project':'qsb-gpu'}},runtime)
    allow('GpuInputs',['s3:PutObject'],[f'arn:aws:s3:::qsb-gpu-{account}-{region}-jobs/inputs/*'],target=runtime)
    allow('GpuOutputs',['s3:GetObject'],[f'arn:aws:s3:::qsb-gpu-{account}-{region}-jobs/outputs/*'],target=runtime)
    # The API's MARA Slipstream credential: read-only, one administrator-created secret, and only for the
    # registered API roles, from their own function's execution environment. Lambda sets lambda:SourceFunctionArn
    # on those calls (and a few it makes for the function, such as its logs), never on a session taken elsewhere.
    # Naming the functions, not qsb-*-api, means a deploy can't add a role and function of its own that read it
    # for another account. A role still needs its own grant, which Terraform gives only to the API. This limits
    # runtime roles, not deployers: whoever can deploy the API's code can read it.
    api = api_functions(c)
    allow('MinerCredential',['secretsmanager:GetSecretValue'],[arn('secretsmanager','secret:qsb/slipstream-??????')],
          {'ArnEquals':{'aws:PrincipalArn':[iam(f'role/qsb/runtime/{n}') for n in api],
                        'lambda:SourceFunctionArn':[arn('lambda',f'function:{n}') for n in api]}},runtime)
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
