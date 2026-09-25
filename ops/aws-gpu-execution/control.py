"""One-shot benchmark infrastructure; all state stays outside the repository."""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'ops/aws-gpu-benchmark'))
from launch import boot_script
ACCOUNT='905846953990'
REGION='eu-west-1'
AMI='ami-0c530031fa871c4fa'
SUBNET='subnet-031df8f2f14d67553'
VPC='vpc-0255d113ce6e93f90'


def aws(service, operation, **request):
    result=subprocess.run(['aws','--profile','snf','--region',REGION,'--output','json',
        '--no-cli-pager',service,operation,'--cli-input-json',json.dumps(request)],
        capture_output=True,text=True,env={**os.environ,'AWS_MAX_ATTEMPTS':'1'},timeout=90)
    if result.returncode:
        raise RuntimeError(f'{service} {operation}: {result.stderr}')
    return json.loads(result.stdout) if result.stdout.strip() else {}


def save(path,state):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(state,indent=2)+'\n');tmp.replace(path)


def policy(statements):
    return json.dumps({'Version':'2012-10-17','Statement':statements})


def trust(service):
    return policy([{'Effect':'Allow','Principal':{'Service':service},'Action':'sts:AssumeRole'}])


def role(name,principal,document):
    aws('iam','create-role',RoleName=name,AssumeRolePolicyDocument=trust(principal))
    aws('iam','put-role-policy',RoleName=name,PolicyName='benchmark-only',PolicyDocument=document)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['prepare','arm','launch','cleanup'])
    parser.add_argument('--state',type=Path,required=True)
    args=parser.parse_args();path=args.state
    if aws('sts','get-caller-identity')['Account']!=ACCOUNT: raise ValueError('Wrong account')
    if subprocess.check_output(['git','status','--porcelain'],cwd=ROOT): raise ValueError('Dirty checkout')
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    remote=subprocess.check_output(['git','rev-parse','@{upstream}'],cwd=ROOT,text=True).strip()
    if commit!=remote: raise ValueError('Source not pushed')
    if args.mode=='prepare':
        if path.exists(): raise ValueError('Existing experiment: reconcile state')
        token=str(uuid.uuid4());name='qsb-bench-'+token[:8]
        s={'token':token,'name':name,'controllerCommit':commit,'phase':'preparing'}
        path.parent.mkdir(parents=True,exist_ok=True);save(path,s)
        role(name+'-host','ec2.amazonaws.com',(ROOT/'ops/aws-gpu-benchmark/instance-policy.json').read_text())
        aws('iam','create-instance-profile',InstanceProfileName=name)
        aws('iam','add-role-to-instance-profile',InstanceProfileName=name,RoleName=name+'-host')
        s['securityGroup']=aws('ec2','create-security-group',GroupName=name,Description='Isolated QSB benchmark; no inbound',VpcId=VPC)['GroupId'];save(path,s)
        role(name+'-cleanup','lambda.amazonaws.com',policy([
            {'Effect':'Allow','Action':'ec2:DescribeInstances','Resource':'*'},
            {'Effect':'Allow','Action':'ec2:TerminateInstances','Resource':f'arn:aws:ec2:{REGION}:{ACCOUNT}:instance/*',
             'Condition':{'StringEquals':{'ec2:ResourceTag/QsbBenchmarkToken':token}}}]))
        function_arn=f'arn:aws:lambda:{REGION}:{ACCOUNT}:function:{name}'
        schedule_trust=policy([{'Effect':'Allow','Principal':{'Service':'scheduler.amazonaws.com'},'Action':'sts:AssumeRole',
            'Condition':{'StringEquals':{'aws:SourceAccount':ACCOUNT},'ArnEquals':{'aws:SourceArn':f'arn:aws:scheduler:{REGION}:{ACCOUNT}:schedule-group/default'}}}])
        aws('iam','create-role',RoleName=name+'-schedule',AssumeRolePolicyDocument=schedule_trust)
        aws('iam','put-role-policy',RoleName=name+'-schedule',PolicyName='benchmark-only',PolicyDocument=policy([
            {'Effect':'Allow','Action':'lambda:InvokeFunction','Resource':function_arn}]))
        s.update(phase='prepared',functionArn=function_arn);save(path,s)
    else:
        s=json.loads(path.read_text());name=s['name']
        if s['controllerCommit']!=commit: raise ValueError('Controller commit changed: reconcile first')
        if args.mode=='arm':
            if s['phase']!='prepared': raise ValueError('Already armed or launched')
            # Start the fixed deadline before launch. Repeating arm is forbidden.
            deadline=datetime.now(timezone.utc)+timedelta(minutes=55)
            s.update(deadline=int(deadline.timestamp()),phase='arming');save(path,s)
            archive=path.parent/'cleanup.zip'
            with zipfile.ZipFile(archive,'w') as z: z.write(Path(__file__).with_name('cleanup.py'),'cleanup.py')
            result=subprocess.run(['aws','--profile','snf','--region',REGION,'lambda','create-function',
                '--function-name',name,'--runtime','python3.12','--role',f'arn:aws:iam::{ACCOUNT}:role/{name}-cleanup',
                '--handler','cleanup.handler','--timeout','60','--zip-file','fileb://'+str(archive),
                '--environment',json.dumps({'Variables':{'RUN_TOKEN':s['token'],'DEADLINE':str(s['deadline'])}}),
                '--output','json'],capture_output=True,text=True)
            if result.returncode: raise RuntimeError(result.stderr)
            actual=json.loads(result.stdout)
            if actual['CodeSha256']!=base64.b64encode(hashlib.sha256(archive.read_bytes()).digest()).decode(): raise ValueError('Lambda source mismatch')
            subprocess.run(['aws','--profile','snf','--region',REGION,'lambda','wait','function-active-v2','--function-name',name],check=True,timeout=120)
            expected={'Name':name,'GroupName':'default','ScheduleExpression':f'at({deadline:%Y-%m-%dT%H:%M:%S})',
                'ScheduleExpressionTimezone':'UTC','FlexibleTimeWindow':{'Mode':'OFF'},'State':'ENABLED','ActionAfterCompletion':'DELETE',
                'Target':{'Arn':s['functionArn'],'RoleArn':f'arn:aws:iam::{ACCOUNT}:role/{name}-schedule','Input':'{}',
                          'RetryPolicy':{'MaximumEventAgeInSeconds':300,'MaximumRetryAttempts':3}}}
            aws('scheduler','create-schedule',**expected)
            actual=aws('scheduler','get-schedule',Name=name,GroupName='default')
            for k,v in expected.items():
                if actual[k]!=v: raise ValueError('Schedule mismatch '+k)
            s.update(phase='armed',schedule=expected);save(path,s)
        elif args.mode=='launch':
            if s['phase']!='armed': raise ValueError('Launch intent exists or cleanup unarmed')
            if s['deadline']-time.time()<45*60: raise ValueError('Insufficient time before deadline')
            quota=aws('service-quotas','get-service-quota',ServiceCode='ec2',QuotaCode='L-DB2E81BA')['Quota']['Value']
            if quota<4: raise ValueError('Quota not effective')
            if aws('ec2','describe-instances',Filters=[{'Name':'tag:QsbBenchmarkToken','Values':[s['token']]}])['Reservations']: raise ValueError('Existing launch')
            actual=aws('scheduler','get-schedule',Name=name,GroupName='default')
            for k,v in s['schedule'].items():
                if actual[k]!=v: raise ValueError('Schedule changed')
            image=aws('ec2','describe-images',ImageIds=[AMI])['Images'][0]
            if image['Architecture']!='x86_64' or image['OwnerId']!='898082745236': raise ValueError('Unexpected AMI')
            groups=aws('ec2','describe-security-groups',GroupIds=[s['securityGroup']])['SecurityGroups']
            if groups[0]['IpPermissions']: raise ValueError('Ingress forbidden')
            # Guest timer shares the prearmed deadline, even if boot is delayed.
            start=datetime.fromtimestamp(s['deadline'],timezone.utc)-timedelta(minutes=55)
            request={'ImageId':AMI,'InstanceType':'g5.xlarge','MinCount':1,'MaxCount':1,'ClientToken':s['token'],
                'SubnetId':SUBNET,'SecurityGroupIds':[s['securityGroup']], 'IamInstanceProfile':{'Name':name},
                'InstanceInitiatedShutdownBehavior':'terminate','DisableApiTermination':False,
                'MetadataOptions':{'HttpTokens':'required','HttpPutResponseHopLimit':1},'UserData':boot_script(start),
                'BlockDeviceMappings':[{'DeviceName':image['RootDeviceName'],'Ebs':{'VolumeSize':80,'VolumeType':'gp3','Encrypted':True,'DeleteOnTermination':True}}],
                'TagSpecifications':[{'ResourceType':'instance','Tags':[{'Key':'Name','Value':name},{'Key':'QsbBenchmarkToken','Value':s['token']},{'Key':'SourceCommit','Value':commit}]}]}
            s.update(phase='launch-intent',request=request);save(path,s)
            instance=aws('ec2','run-instances',**request)['Instances'][0]
            s.update(phase='launched',instanceId=instance['InstanceId'],launchTime=instance['LaunchTime']);save(path,s)
        elif args.mode=='cleanup':
            instances=[i for r in aws('ec2','describe-instances',Filters=[{'Name':'tag:QsbBenchmarkToken','Values':[s['token']]}])['Reservations'] for i in r['Instances']]
            for i in instances:
                if i['State']['Name']!='terminated':
                    aws('ec2','terminate-instances',InstanceIds=[i['InstanceId']])
                    raise RuntimeError('Termination requested; rerun cleanup after EC2 reaches terminated')
            volumes=aws('ec2','describe-volumes',Filters=[{'Name':'attachment.instance-id','Values':[i['InstanceId'] for i in instances]}])['Volumes'] if instances else []
            if volumes: raise ValueError('Attached volumes remain')
            # Caller also checks recorded volume IDs for detached/orphaned volumes.
            for volume_id in s.get('volumeIds',[]):
                found=aws('ec2','describe-volumes',Filters=[{'Name':'volume-id','Values':[volume_id]}])['Volumes']
                if found: raise ValueError('Recorded volume still exists')
            schedules=aws('scheduler','list-schedules',NamePrefix=name)['Schedules']
            for schedule in schedules:
                if schedule['Name']==name: aws('scheduler','delete-schedule',Name=name,GroupName='default')
            functions=aws('lambda','list-functions')['Functions']
            if any(f['FunctionName']==name for f in functions): aws('lambda','delete-function',FunctionName=name)
            aws('iam','remove-role-from-instance-profile',InstanceProfileName=name,RoleName=name+'-host')
            aws('iam','delete-instance-profile',InstanceProfileName=name)
            for suffix in ['-host','-cleanup','-schedule']:
                aws('iam','delete-role-policy',RoleName=name+suffix,PolicyName='benchmark-only')
                aws('iam','delete-role',RoleName=name+suffix)
            aws('ec2','delete-security-group',GroupId=s['securityGroup'])
            s.update(phase='cleaned',cleanupVerifiedAt=datetime.now(timezone.utc).isoformat());save(path,s)
    print(json.dumps(s,indent=2))

if __name__=='__main__': main()
