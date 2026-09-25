#!/usr/bin/env python3
"""Check QSB deployment authorization with IAM's policy simulator.

--role-arn tests the live identity policy. Without it, test rendered policies.
The OIDC trust assertions are structural; only GitHub can supply a real token.
"""
import argparse
import json
import subprocess
from pathlib import Path
from render import render

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--profile',required=True);p.add_argument('--inventory',type=Path,required=True)
p.add_argument('--role-arn');a=p.parse_args();c=json.loads(a.inventory.read_text());pol=render(c)
account,region=c['account'],c['region']
trust=pol['trust']['Statement'][0]
assert trust['Action']=='sts:AssumeRoleWithWebIdentity'
assert trust['Condition']['StringEquals']['token.actions.githubusercontent.com:sub']==c['subject']
assert c['subject'].endswith(':ref:refs/heads/main') and '*' not in c['subject']
assert trust['Condition']['StringEquals']['token.actions.githubusercontent.com:aud']=='sts.amazonaws.com'
boundary=f'arn:aws:iam::{account}:policy/qsb/bootstrap/qsb-runtime-boundary'
role=f'arn:aws:iam::{account}:role/qsb/runtime/qsb-research-api'
ctx=[{'ContextKeyName':'iam:PermissionsBoundary','ContextKeyValues':[boundary],'ContextKeyType':'string'}]
cases=[
 ('removed queue','sqs:CreateQueue',f'arn:aws:sqs:{region}:{account}:qsb-research-dispatch',False,[]),
 ('removed registry','ecr:CreateRepository',f'arn:aws:ecr:{region}:{account}:repository/qsb-research-runtime',False,[]),
 ('removed schedule','events:PutRule',f'arn:aws:events:{region}:{account}:rule/qsb-research-cleanup',False,[]),
 ('removed image auth','ecr:GetAuthorizationToken','*',False,[]),
 ('removed network discovery','ec2:DescribeVpcs','*',False,[]),
 ('pass removed host','iam:PassRole',role,False,[{'ContextKeyName':'iam:PassedToService','ContextKeyValues':['ec2.amazonaws.com'],'ContextKeyType':'string'}]),
 ('pass removed backup','iam:PassRole',role,False,[{'ContextKeyName':'iam:PassedToService','ContextKeyValues':['backup.amazonaws.com'],'ContextKeyType':'string'}]),
 ('pass workflow','iam:PassRole',role,True,[{'ContextKeyName':'iam:PassedToService','ContextKeyValues':['states.amazonaws.com'],'ContextKeyType':'string'}]),
 ('qsb function','lambda:UpdateFunctionCode',f'arn:aws:lambda:{region}:{account}:function:qsb-research-api',True,[]),
 ('other function','lambda:UpdateFunctionCode',f'arn:aws:lambda:{region}:{account}:function:unrelated-api',False,[]),
 ('qsb table','dynamodb:CreateTable',f'arn:aws:dynamodb:{region}:{account}:table/qsb-research-records',True,[]),
 ('other table','dynamodb:DeleteTable',f'arn:aws:dynamodb:{region}:{account}:table/other',False,[]),
 ('qsb website','s3:PutObject',f'arn:aws:s3:::qsb-research-{account}-{region}-web/index.html',True,[]),
 ('other bucket','s3:PutObject','arn:aws:s3:::unrelated-bucket/index.html',False,[]),
 ('state write','s3:PutObject',f'arn:aws:s3:::{c["state_bucket"]}/qsb/main/terraform.tfstate',True,[]),
 ('state deletion','s3:DeleteObject',f'arn:aws:s3:::{c["state_bucket"]}/qsb/main/terraform.tfstate',False,[]),
 ('state bucket policy','s3:PutBucketPolicy',f'arn:aws:s3:::{c["state_bucket"]}',False,[]),
 ('bounded role creation','iam:CreateRole',role,True,ctx),
 ('unbounded role creation','iam:CreateRole',role,False,[]),
 ('bounded runtime policy','iam:PutRolePolicy',role,True,ctx),
 ('boundary removal','iam:DeleteRolePermissionsBoundary',role,False,[]),
 ('boundary modification','iam:CreatePolicyVersion',boundary,False,[]),
 ('self modification','iam:PutRolePolicy',f'arn:aws:iam::{account}:role/qsb/bootstrap/qsb-github-deploy',False,[]),
 ('other role','iam:PutRolePolicy',f'arn:aws:iam::{account}:role/unrelated',False,ctx),
 ('pass runtime','iam:PassRole',role,True,[{'ContextKeyName':'iam:PassedToService','ContextKeyValues':['lambda.amazonaws.com'],'ContextKeyType':'string'}]),
 ('pass administrator','iam:PassRole',f'arn:aws:iam::{account}:role/Administrator',False,[{'ContextKeyName':'iam:PassedToService','ContextKeyValues':['lambda.amazonaws.com'],'ContextKeyType':'string'}]),
 ('qsb distribution','cloudfront:UpdateDistribution',f'arn:aws:cloudfront::{account}:distribution/{c["distributions"][0]}',True,[]),
 ('other distribution','cloudfront:UpdateDistribution',f'arn:aws:cloudfront::{account}:distribution/UNRELATED',False,[]),
 ('qsb api','apigateway:PATCH',f'arn:aws:apigateway:{region}::/apis/{c["apis"][0]}',True,[]),
 ('other api','apigateway:PATCH',f'arn:aws:apigateway:{region}::/apis/unrelated',False,[]),
 ('credential creation','iam:CreateAccessKey',f'arn:aws:iam::{account}:user/anyone',False,[]),
]
for name,action,resource,allowed,context in cases:
 args=['simulate-principal-policy','--policy-source-arn',a.role_arn] if a.role_arn else ['simulate-custom-policy','--policy-input-list',json.dumps(pol['deploy'])]
 args+=['--action-names',action,'--resource-arns',resource]
 if context:args+=['--context-entries',json.dumps(context)]
 out=json.loads(subprocess.check_output(['aws','--profile',a.profile,'--region',region,'--output','json','iam',*args],text=True))
 decision=out['EvaluationResults'][0]['EvalDecision']
 assert (decision=='allowed')==allowed,(name,decision,out['EvaluationResults'][0].get('MissingContextValues'))
 print(name+': '+decision,flush=True)
print(f'Passed {len(cases)} IAM simulations and exact OIDC trust assertions.',flush=True)
