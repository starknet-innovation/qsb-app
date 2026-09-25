#!/usr/bin/env python3
"""Create the QSB GitHub identity from policies rendered by this clean commit.

Requires an administrator profile. Never changes existing IAM identities.
Runtime inventory and generated policies must remain outside the checkout.
"""
import argparse
import json
import subprocess
from pathlib import Path
from render import render

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--profile',required=True)
p.add_argument('--inventory',type=Path,required=True)
p.add_argument('--apply',action='store_true')
a=p.parse_args();c=json.loads(a.inventory.read_text())
root=Path(__file__).resolve().parents[2]
if subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip():
    raise SystemExit('Commit and push the clean checkout before bootstrap')
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
branch=subprocess.check_output(['git','branch','--show-current'],cwd=root,text=True).strip()
remote=subprocess.check_output(['git','ls-remote','origin','refs/heads/'+branch],cwd=root,text=True).split()
if not remote or remote[0]!=commit: raise SystemExit('Commit is not pushed to the matching remote branch')

def aws(*args):
    r=subprocess.check_output(['aws','--profile',a.profile,'--region',c['region'],'--output','json',*args],text=True)
    return json.loads(r) if r.strip() else {}

if aws('sts','get-caller-identity')['Account']!=c['account']:raise SystemExit('Account mismatch')
policies=render(c)
print(json.dumps({'commit':commit,'role':'qsb-github-deploy','subject':c['subject'],'apply':a.apply}),flush=True)
if not a.apply:raise SystemExit()
# Fail closed if a same-named identity already exists; reconcile it separately.
roles=aws('iam','list-roles')['Roles']
if any(r['RoleName']=='qsb-github-deploy' for r in roles):raise SystemExit('Role already exists; inspect before updating')
existing=aws('iam','list-policies','--scope','Local')['Policies']
if any(x['PolicyName']=='qsb-runtime-boundary' for x in existing):raise SystemExit('Boundary already exists; inspect before updating')
bucket=c['state_bucket']
if any(b['Name']==bucket for b in aws('s3api','list-buckets')['Buckets']):raise SystemExit('State bucket already exists; inspect before updating')
aws('s3api','create-bucket','--bucket',bucket,'--create-bucket-configuration',json.dumps({'LocationConstraint':c['region']}))
aws('s3api','put-public-access-block','--bucket',bucket,'--public-access-block-configuration',json.dumps(dict(BlockPublicAcls=True,IgnorePublicAcls=True,BlockPublicPolicy=True,RestrictPublicBuckets=True)))
aws('s3api','put-bucket-versioning','--bucket',bucket,'--versioning-configuration','Status=Enabled')
aws('s3api','put-bucket-encryption','--bucket',bucket,'--server-side-encryption-configuration',json.dumps({'Rules':[{'ApplyServerSideEncryptionByDefault':{'SSEAlgorithm':'AES256'}}]}))
aws('s3api','put-bucket-tagging','--bucket',bucket,'--tagging',json.dumps({'TagSet':[{'Key':'Application','Value':'qsb-vault'},{'Key':'SourceCommit','Value':commit}]}))
aws('s3api','put-bucket-policy','--bucket',bucket,'--policy',json.dumps({'Version':'2012-10-17','Statement':[{'Sid':'RequireTLS','Effect':'Deny','Principal':'*','Action':'s3:*','Resource':['arn:aws:s3:::'+bucket,'arn:aws:s3:::'+bucket+'/*'],'Condition':{'Bool':{'aws:SecureTransport':'false'}}}]}))
b=aws('iam','create-policy','--policy-name','qsb-runtime-boundary','--path','/qsb/bootstrap/','--policy-document',json.dumps(policies['boundary']),'--description','Maximum QSB runtime permissions; GitHub cannot edit this boundary')['Policy']['Arn']
r=aws('iam','create-role','--role-name','qsb-github-deploy','--path','/qsb/bootstrap/','--assume-role-policy-document',json.dumps(policies['trust']),'--max-session-duration','3600','--description','GitHub main only; QSB Terraform deployment; no static credentials','--tags',json.dumps([{'Key':'Application','Value':'qsb-vault'},{'Key':'SourceCommit','Value':commit}]))['Role']['Arn']
aws('iam','put-role-policy','--role-name','qsb-github-deploy','--policy-name','qsb-terraform-deployment','--policy-document',json.dumps(policies['deploy']))
print(json.dumps({'role':r,'runtime_boundary':b,'state_bucket':bucket,'commit':commit}),flush=True)
