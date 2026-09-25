"""Private single-object artifact transfer when SSM payload throughput is too low."""
import argparse
import json
from pathlib import Path
import subprocess
from control import aws, ROOT, save


def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['upload','cleanup']);p.add_argument('--state',type=Path,required=True);p.add_argument('--artifact',type=Path)
    a=p.parse_args();s=json.loads(a.state.read_text())
    if subprocess.check_output(['git','status','--porcelain'],cwd=ROOT): raise ValueError('Dirty checkout')
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    if head!=subprocess.check_output(['git','rev-parse','@{upstream}'],cwd=ROOT,text=True).strip(): raise ValueError('Unpushed source')
    name=s['name'];bucket=name+'-905846953990'
    if a.mode=='upload':
        if s.get('transferBucket'): raise ValueError('Reconcile previous transfer')
        s.update(transferBucket=bucket,transferControllerCommit=head);save(a.state,s)
        aws('s3api','create-bucket',Bucket=bucket,CreateBucketConfiguration={'LocationConstraint':'eu-west-1'})
        aws('s3api','put-public-access-block',Bucket=bucket,PublicAccessBlockConfiguration={k:True for k in ['BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets']})
        aws('s3api','put-bucket-encryption',Bucket=bucket,ServerSideEncryptionConfiguration={'Rules':[{'ApplyServerSideEncryptionByDefault':{'SSEAlgorithm':'AES256'}}]})
        aws('s3api','put-bucket-policy',Bucket=bucket,Policy=json.dumps({'Version':'2012-10-17','Statement':[{'Effect':'Deny','Principal':'*','Action':'s3:*','Resource':[f'arn:aws:s3:::{bucket}',f'arn:aws:s3:::{bucket}/*'],'Condition':{'Bool':{'aws:SecureTransport':'false'}}}]}))
        subprocess.run(['aws','--profile','snf','--region','eu-west-1','s3','cp',str(a.artifact),f's3://{bucket}/image.tar.gz','--only-show-errors'],check=True)
        policy=json.loads((ROOT/'ops/aws-gpu-benchmark/instance-policy.json').read_text())
        policy['Statement'][1]['NotAction'].append('s3:GetObject')
        policy['Statement'].append({'Effect':'Allow','Action':'s3:GetObject','Resource':f'arn:aws:s3:::{bucket}/image.tar.gz'})
        aws('iam','put-role-policy',RoleName=name+'-host',PolicyName='benchmark-only',PolicyDocument=json.dumps(policy))
        s['transferReady']=True;save(a.state,s)
        print('Image uploaded; instance can read only',f's3://{bucket}/image.tar.gz')
    else:
        aws('s3api','delete-object',Bucket=bucket,Key='image.tar.gz')
        aws('s3api','delete-bucket',Bucket=bucket)
        s['transferCleaned']=True;save(a.state,s)

if __name__=='__main__': main()
