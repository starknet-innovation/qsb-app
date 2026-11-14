#!/usr/bin/env python3
"""Bounded public fixture through the deployed coordinator; no API submit or broadcast."""
import argparse
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid
import zipfile
from datetime import datetime, timezone
from control import Campaign, ROOT, ACTIVE, clean_source, check_operator_config, dump, persist, incomplete_success
from production_guard import checked_request

def checked_event(row,settings):
    event=row.get('event',{});subject=event.get('subjectId')
    prefix='withdrawal.' if subject==settings['jobId'] else 'deposit.' if subject==settings['vaultId'] else None
    if (set(row)!={'pk','sk','version','event','expiresAt'} or row['pk']!=settings['pk'] or row['version']!=0
        or not prefix or event.get('type')!=prefix+event.get('status','')
        or not re.fullmatch(r'evt_[a-f0-9]{32}',event.get('id',''))
        or not row['sk'].startswith('EVENT#') or not row['sk'].endswith('#'+event['id'])
        or set(event)-{'id','type','subjectId','status','stage','at'}):raise RuntimeError('Refuse unrelated owner event')
    return row

class Production:
    client = Campaign.client
    mutate = Campaign.mutate
    log_pages = Campaign.log_pages
    collect_artifacts = Campaign.collect_artifacts

    def __init__(self, directory):
        import boto3
        from botocore.config import Config
        self.directory = directory.resolve()
        if self.directory.is_relative_to(ROOT): raise RuntimeError('Keep receipts outside Git')
        self.config = json.loads((self.directory / 'operator.json').read_text());check_operator_config(self.config)
        if self.config.get('snfIsolation'): raise RuntimeError('Use the existing London production operator')
        self.account, self.region = self.config['account'], self.config['region']
        self.session = boto3.Session(profile_name=self.config['profile'], region_name=self.region);self.clients = {}
        self.sdk_config = Config(connect_timeout=5, read_timeout=30, retries={'total_max_attempts': 1})
        self.read_sdk_config = Config(connect_timeout=5, read_timeout=30, retries={'mode': 'standard', 'total_max_attempts': 5})
        if self.client('sts').get_caller_identity()['Account'] != self.account: raise RuntimeError('Wrong account')
        self.state_path = self.directory / 'campaign.json';self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else None
        if self.state: self.scope()

    def arn(self, service, resource): return f'arn:aws:{service}:{self.region}:{self.account}:{resource}'
    def iam(self, name): return f'arn:aws:iam::{self.account}:role/qsb/runtime/{name}'
    def save(self): persist(self.state_path, self.state)
    def fixture(self): return json.loads((self.directory / 'public-fixture.json').read_text())
    def scope(self):
        s=self.state;name=s['name']
        if s['format']!='pqb-deployed-campaign-v1' or not re.fullmatch('qsb-pqb-v-[a-f0-9]{12}',name): raise RuntimeError('Not a deployed public campaign')
        if (s['operatorHash']!=hashlib.sha256(dump(self.config).encode()).hexdigest() or s['deadline']!=s['createdAt']+14400
            or s['stopAt']!=s['deadline']-1800 or s['expiresAt']!=s['stopAt']+900 or s['reservedUsd']!=200): raise RuntimeError('Frozen scope/bounds changed')
        if s['guardFunction']!=name+'-deadline' or s['roles']!=[name+'-deadline',name+'-scheduler'] or s['schedule']!=name+'-deadline': raise RuntimeError('Dedicated guard scope changed')
        if s['settings']['name']!=name or s['settings']['rootExecution']!=s['workflow'].replace(':stateMachine:',':execution:')+':public-'+name:raise RuntimeError('Public execution scope changed')
        if s['tables']!=[s['settings']['table']] or s['definition']!=s['settings']['definition'] or s['queue']!=s['settings']['queue']: raise RuntimeError('Production binding changed')
        if s['settings']['pk']!='OWNER#'+s['settings']['owner'] or s['settings']['sk']!='JOB#'+s['settings']['jobId'] or s['settings']['ledgerSk']!='PUBLIC_VALIDATION#'+name: raise RuntimeError('Public key scope changed')
        if hashlib.sha256((self.directory/'public-fixture.json').read_bytes()).hexdigest()!=s['fixtureSha256']: raise RuntimeError('Fixture changed')
        if json.loads((self.directory/'binding.json').read_text())!={k:s[k] for k in ['settings','sourceCommit','deployedSourceCommit','fixtureSha256','coordinatorSha256','apiArtifactSha256','descriptor','bucket']}: raise RuntimeError('Production binding file changed')
    def source(self):
        if clean_source()!=self.state['sourceCommit']: raise RuntimeError('Require exact clean pushed controller')
    def binding(self):
        snap=json.loads((self.directory/self.state['snapshot']).read_text())
        for name in ['coordinator','api','reference']:
            actual=self.client('lambda').get_function_configuration(FunctionName='qsb-app-'+name)
            Campaign.check_function(actual,snap['functions'][name])
        actual=self.client('stepfunctions').describe_state_machine(stateMachineArn=self.state['workflow'])
        if actual['definition']!=snap['workflow']['definition'] or actual['roleArn']!=snap['workflow']['roleArn']: raise RuntimeError('Deployed workflow changed')
        defs=self.client('batch').describe_job_definitions(jobDefinitions=[self.state['definition']])['jobDefinitions']
        if defs!=snap['definition'] or defs[0]['status']!='ACTIVE': raise RuntimeError('Deployed definition changed')
        ce=self.client('batch').describe_compute_environments(computeEnvironments=[snap['computeEnvironments'][0]['computeEnvironmentArn']])['computeEnvironments'][0]
        old=snap['computeEnvironments'][0]
        if ce['state']!='ENABLED' or ce['status']!='VALID' or {k:v for k,v in ce['computeResources'].items() if k!='desiredvCpus'}!={k:v for k,v in old['computeResources'].items() if k!='desiredvCpus'}: raise RuntimeError('Production capacity configuration changed')

    def prepare(self):
        if self.state: raise RuntimeError('Never restart a campaign')
        source=clean_source();Campaign.inspect(self);subprocess.run(['node','--import','tsx','ops/pqb-serving/fixture.ts','preflight-input',str(self.directory)],cwd=ROOT,env={**os.environ,'QSB_NETWORK':'mainnet'},check=True);snap=json.loads((self.directory/'live-runtime-private.json').read_text());fixture=self.fixture()
        subprocess.run(['node','--import','tsx','ops/pqb-serving/fixture.ts','validate',str(self.directory)],cwd=ROOT,env={**os.environ,'QSB_NETWORK':'mainnet'},check=True)
        manifest=json.loads((ROOT/'terraform/.build/manifest.json').read_text())
        if not manifest['clean'] or manifest['commit']!=source or manifest['identities']['solver']['id']!=fixture['descriptor']['id']: raise RuntimeError('Exact clean PQB build required')
        for f,h in manifest['files'].items():
            if hashlib.sha256((ROOT/'terraform/.build'/f).read_bytes()).hexdigest()!=h: raise RuntimeError('Build byte mismatch')
        functions={n:self.client('lambda').get_function_configuration(FunctionName='qsb-app-'+n) for n in ['api','coordinator','reference']}
        for n,c in functions.items():
            if base64.b64decode(c['CodeSha256']).hex()!=manifest['files'][n+'.zip']: raise RuntimeError('Deployed artifact differs from tested build')
        env=snap['coordinatorEnv'];desc=fixture['descriptor']
        if (env.get('SOLVER_RELEASE_ID')!=desc['id'] or env.get('QSB_MAINNET_ENABLED')!='true' or any(snap['activeJobs'].values()) or snap['runningExecutions']
            or env.get('QSB_OWNER_MAX_ACTIVE_JOBS') or env.get('QSB_OWNER_MAX_GPU_SECONDS') or env.get('QSB_OWNER_ALLOWLIST') or 'QSB_BATCH_SHARED_POOL_VALIDATION' in env): raise RuntimeError('Production baseline is not compatible or quiescent')
        definition=snap['definition'][0]
        if definition['status']!='ACTIVE' or definition['containerProperties']['image'].split('@')[-1]!=desc['image'].split('@')[-1]: raise RuntimeError('Wrong deployed image')
        production=json.loads((self.directory/'deployment.json').read_text())
        with self.client('s3').get_object(Bucket=production['stateBucket'],Key='qsb/main/terraform.tfstate')['Body'] as body:deployed=json.loads(body.read())
        if deployed['outputs']['source_commit']['value']!=production['sourceCommit']: raise RuntimeError('Deployment source changed')
        owner=fixture['event']['owner'];pk='OWNER#'+owner
        query=self.client('dynamodb').query(TableName=env['TABLE_NAME'],KeyConditionExpression='pk = :pk',ExpressionAttributeValues={':pk':{'S':pk}},Select='COUNT',ConsistentRead=True)
        if query['Count'] or query.get('LastEvaluatedKey'): raise RuntimeError('Public fixture owner is not an empty partition')
        name='qsb-pqb-v-'+uuid.uuid4().hex[:12];created=int(time.time());workflow=snap['workflow']['stateMachineArn'];root=workflow.replace(':stateMachine:',':execution:')+':public-'+name
        settings={'name':name,'table':env['TABLE_NAME'],'pk':pk,'sk':'JOB#'+fixture['event']['jobId'],'ledgerSk':'PUBLIC_VALIDATION#'+name,
            'owner':owner,'jobId':fixture['event']['jobId'],'vaultId':fixture['rows'][0]['vault']['id'],'manifestHash':fixture['rows'][1]['job']['manifestHash'],
            'definition':env['AWS_BATCH_JOB_DEFINITION'],'queue':env['AWS_BATCH_JOB_QUEUE'],'workflow':workflow,'rootExecution':root,
            'deadline':created+14400,'stopAt':created+12600,'expiresAt':created+13500}
        self.state={'format':'pqb-deployed-campaign-v1','name':name,'sourceCommit':source,'deployedSourceCommit':production['sourceCommit'],
            'operatorHash':hashlib.sha256(dump(self.config).encode()).hexdigest(),'createdAt':created,'deadline':settings['deadline'],'stopAt':settings['stopAt'],'expiresAt':settings['expiresAt'],
            'reservedUsd':200,'reservationStatus':'reserved','fixtureSha256':hashlib.sha256((self.directory/'public-fixture.json').read_bytes()).hexdigest(),
            'coordinatorSha256':manifest['files']['coordinator.zip'],'apiArtifactSha256':manifest['files']['api.zip'],'descriptor':desc,
            'queue':settings['queue'],'definition':settings['definition'],'bucket':env['AWS_BATCH_JOB_BUCKET'],'image':definition['containerProperties']['image'],
            'tables':[settings['table']],'roles':[name+'-deadline',name+'-scheduler'],'guardFunction':name+'-deadline','schedule':name+'-deadline',
            'workflow':workflow,'settings':settings,'logs':[],'phase':'prepared','knownJobIds':[],'knownRequests':[]}
        snap['functions']=functions;persist(self.directory/'deployed-binding.json',snap,exclusive=True)
        # Preserve the inspect receipt; the collector only needs the same reviewed structure.
        self.state['snapshot']='deployed-binding.json'
        groups=snap['computeEnvironments'][0]['computeResources']['securityGroupIds'];persist(self.directory/'instance-baseline.json',self.client('ec2').describe_instances(Filters=[{'Name':'instance.group-id','Values':groups}]),exclusive=True)
        out=self.directory/'build-artifacts';out.mkdir()
        for f in ['manifest.json','api.zip','coordinator.zip','reference.zip','webhooks.zip']:shutil.copyfile(ROOT/'terraform/.build'/f,out/f)
        persist(self.directory/'binding.json',{k:self.state[k] for k in ['settings','sourceCommit','deployedSourceCommit','fixtureSha256','coordinatorSha256','apiArtifactSha256','descriptor','bucket']},exclusive=True)
        persist(self.state_path,self.state,exclusive=True);self.scope();print(dump({'prepared':name,'deadline':self.state['deadline'],'stopAt':self.state['stopAt'],'reservedUsd':200}).strip())

    def guard(self,action):
        payload=json.dumps({'action':action}).encode()
        def call():
            from botocore.config import Config
            if not hasattr(self,'guard_client'): self.guard_client=self.session.client('lambda',config=Config(connect_timeout=5,read_timeout=240,retries={'total_max_attempts':1}))
            r=self.guard_client.invoke(FunctionName=self.state['guardFunction'],InvocationType='RequestResponse',Payload=payload)
            with r['Payload'] as body:value=json.loads(body.read())
            if r.get('FunctionError'): raise RuntimeError('Guard failed: '+json.dumps(value))
            return {'StatusCode':r['StatusCode'],'value':value}
        from botocore.exceptions import ClientError
        until=time.monotonic()+200
        while True:
            try:
                return self.mutate('guard-'+action+'-'+str(time.time_ns()),'lambda','invoke',invoke=call,FunctionName=self.state['guardFunction'],Payload=payload)['value']
            except ClientError as error:
                # The guard cannot submit work. A refused invocation is safe to
                # re-observe with a fresh receipt while its scheduled drain runs.
                if error.response['Error']['Code']!='TooManyRequestsException' or time.monotonic()>until:raise
                time.sleep(5)


    def arm(self):
        self.source();self.binding();s=self.state;settings=s['settings']
        if s['phase']!='prepared' or time.time()>s['stopAt']-1800:raise RuntimeError('Invalid arm window')
        from boto3.dynamodb.types import TypeSerializer
        ser=TypeSerializer().serialize;ledger={'pk':settings['pk'],'sk':settings['ledgerSk'],'case':s['name'],'manifestHash':settings['manifestHash'],'expiresAt':s['deadline']+86400}
        self.mutate('registry','dynamodb','put_item',TableName=settings['table'],Item={k:ser(v) for k,v in ledger.items()},ConditionExpression='attribute_not_exists(pk)')
        tags=[{'Key':'Project','Value':'qsb-vault'},{'Key':'PqbValidation','Value':s['name']},{'Key':'SourceCommit','Value':s['sourceCommit']}]
        boundary=f'arn:aws:iam::{self.account}:policy/qsb/bootstrap/qsb-runtime-boundary'
        for name,service in zip(s['roles'],['lambda.amazonaws.com','scheduler.amazonaws.com']):
            self.mutate('role-'+name,'iam','create_role',RoleName=name,Path='/qsb/runtime/',PermissionsBoundary=boundary,AssumeRolePolicyDocument=json.dumps({'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Service':service},'Action':'sts:AssumeRole'}]}),Tags=tags)
        def allow(actions,resources,**kw):return dict(Effect='Allow',Action=actions,Resource=resources,**kw)
        table=self.arn('dynamodb','table/'+settings['table']);log='/aws/lambda/'+s['guardFunction'];logarn=self.arn('logs','log-group:'+log+':*')
        policies=[[allow(['dynamodb:GetItem','dynamodb:UpdateItem'],table,Condition={'ForAllValues:StringEquals':{'dynamodb:LeadingKeys':[settings['pk']]}}),
            allow(['batch:ListJobs','batch:DescribeJobs'],'*'),allow(['batch:TerminateJob'],self.arn('batch','job/*'),Condition={'StringEquals':{'aws:ResourceTag/Project':'qsb-gpu'}}),
            allow(['states:DescribeExecution'],settings['workflow'].replace(':stateMachine:',':execution:')+':*'),allow(['logs:CreateLogStream','logs:PutLogEvents'],logarn)],
            [allow(['lambda:InvokeFunction'],self.arn('lambda','function:'+s['guardFunction']))]]
        for i,statements in enumerate(policies):self.mutate('policy-'+str(i),'iam','put_role_policy',RoleName=s['roles'][i],PolicyName='validation',PolicyDocument=json.dumps({'Version':'2012-10-17','Statement':statements}))
        self.mutate('logs','logs','create_log_group',logGroupName=log,tags={t['Key']:t['Value'] for t in tags});time.sleep(10)
        code=io.BytesIO()
        with zipfile.ZipFile(code,'w',zipfile.ZIP_DEFLATED) as z:z.writestr('production_guard.py',(ROOT/'ops/pqb-serving/production_guard.py').read_bytes())
        raw=code.getvalue();(self.directory/'guard.zip').write_bytes(raw)
        result=self.mutate('guard-function','lambda','create_function',FunctionName=s['guardFunction'],Runtime='python3.13',Architectures=['arm64'],Handler='production_guard.handler',Role=self.iam(s['roles'][0]),Timeout=180,MemorySize=256,Code={'ZipFile':raw},Environment={'Variables':{'SETTINGS':json.dumps(settings)}},Tags={t['Key']:t['Value'] for t in tags})
        if base64.b64decode(result['CodeSha256']).hex()!=hashlib.sha256(raw).hexdigest():raise RuntimeError('Guard code mismatch')
        self.client('lambda').get_waiter('function_active_v2').wait(FunctionName=s['guardFunction'],WaiterConfig={'Delay':2,'MaxAttempts':30})
        self.mutate('guard-concurrency','lambda','put_function_concurrency',FunctionName=s['guardFunction'],ReservedConcurrentExecutions=1)
        self.mutate('schedule','scheduler','create_schedule',Name=s['schedule'],ScheduleExpression='rate(1 minute)',ScheduleExpressionTimezone='UTC',StartDate=datetime.fromtimestamp(time.time()+60,timezone.utc),EndDate=datetime.fromtimestamp(s['deadline']+3600,timezone.utc),FlexibleTimeWindow={'Mode':'OFF'},Target={'Arn':self.arn('lambda','function:'+s['guardFunction']),'RoleArn':self.iam(s['roles'][1]),'Input':'{}','RetryPolicy':{'MaximumEventAgeInSeconds':3600,'MaximumRetryAttempts':10}})
        value=self.guard('observe')
        if value['publicRow'] or value['executions'] or value['foreignActiveIds']:raise RuntimeError('Unexpected pre-start activity')
        s['phase']='armed';self.save();print('Public guard armed; no GPU submission yet')

    def check_guard_roles(self):
        boundary=f'arn:aws:iam::{self.account}:policy/qsb/bootstrap/qsb-runtime-boundary'
        for i,role in enumerate(self.state['roles']):
            actual=self.client('iam').get_role(RoleName=role)['Role'];requested=json.loads((self.directory/('requests/role-'+role+'.intent.json')).read_text())['params']
            if (actual['Path']!='/qsb/runtime/' or actual['PermissionsBoundary']['PermissionsBoundaryArn']!=boundary
                or actual['AssumeRolePolicyDocument']!=json.loads(requested['AssumeRolePolicyDocument'])):raise RuntimeError('Guard trust/boundary changed')
            policy=self.client('iam').get_role_policy(RoleName=role,PolicyName='validation')['PolicyDocument'];expected=json.loads((self.directory/('requests/policy-'+str(i)+'.intent.json')).read_text())['params']
            if policy!=json.loads(expected['PolicyDocument']) or self.client('iam').list_attached_role_policies(RoleName=role)['AttachedPolicies'] or self.client('iam').list_role_policies(RoleName=role)['PolicyNames']!=['validation']:raise RuntimeError('Guard policy changed')

    def start(self):
        self.source();self.binding();s=self.state
        if s['phase']!='armed' or time.time()>s['stopAt']-1800:raise RuntimeError('Invalid start')
        recorded=json.loads((self.directory/'requests/guard-function.response.json').read_text())['result'];Campaign.check_function(self.client('lambda').get_function_configuration(FunctionName=s['guardFunction']),recorded)
        scheduled=self.client('scheduler').get_schedule(Name=s['schedule']);requested=json.loads((self.directory/'requests/schedule.intent.json').read_text())['params']
        if scheduled['State']!='ENABLED' or (any(scheduled[k]!=requested[k] for k in ['ScheduleExpression','Target']) or scheduled['EndDate'].timestamp()!=datetime.fromisoformat(requested['EndDate']).timestamp()):raise RuntimeError('Guard schedule changed')
        self.check_guard_roles()
        value=self.guard('observe')
        if value['foreignActiveIds'] or value['publicRow'] or value['executions']:raise RuntimeError('Start baseline not empty')
        from boto3.dynamodb.types import TypeSerializer
        ser=TypeSerializer().serialize;items=[]
        for original in self.fixture()['rows']:
            row=copy.deepcopy(original);row['expiresAt']=s['expiresAt'];items.append({'Put':{'TableName':s['settings']['table'],'Item':{k:ser(v) for k,v in row.items()},'ConditionExpression':'attribute_not_exists(pk)'}})
        self.mutate('fixture-rows','dynamodb','transact_write_items',TransactItems=items)
        # The exact public row and reservation exist durably before this paid trigger.
        result=self.mutate('execution','stepfunctions','start_execution',stateMachineArn=s['workflow'],name='public-'+s['name'],input=json.dumps(self.fixture()['event']))
        if result['executionArn']!=s['settings']['rootExecution']:raise RuntimeError('Unexpected root execution')
        s['phase']='running';self.save();print(dump({'phase':'running','deadline':s['deadline']}).strip())

    def orphan_inputs(self,s3,fixture,allow_missing):return []
    def collect_public_orphans(self, row):
        # ETag is only a metadata prefilter for exact canonical public envelopes;
        # SHA256 and canonical content are checked before retaining/deleting a body.
        if row:
            persist(self.directory/'current-public-job.json',row)
            subprocess.run(['node','--import','tsx','ops/pqb-serving/fixture.ts','input-template',str(self.directory)],cwd=ROOT,env={**os.environ,'QSB_NETWORK':'mainnet'},check=True,capture_output=True)
        objects=self.directory/'objects';objects.mkdir(exist_ok=True)
        templates=[self.directory/'preflight-input.json',*self.directory.glob('input-template-*.json'),*(p for p in objects.glob('inputs__*.json') if re.fullmatch(r'inputs__[a-f0-9-]{36}\.json',p.name))]
        expected={};seen=set()
        maximum=int(json.loads((self.directory/'deployed-binding.json').read_text())['coordinatorEnv']['MAX_JOB_GPU_SECONDS'])//900+1
        for path in templates:
            original=json.loads(path.read_text())['input'];base=dict(original);base['attempt']=0
            identity=hashlib.sha256(json.dumps(base,separators=(',',':'),ensure_ascii=False).encode()).hexdigest();cache=self.directory/('fingerprints-'+identity+'.json')
            if identity in seen:continue
            seen.add(identity)
            if cache.exists():values=json.loads(cache.read_text())
            else:
                values={}
                for attempt in range(maximum):
                    value=dict(base);value['attempt']=attempt;raw=json.dumps({'input':value},separators=(',',':'),ensure_ascii=False).encode()
                    values[hashlib.md5(raw,usedforsecurity=False).hexdigest()]=hashlib.sha256(raw).hexdigest()
                persist(cache,values,exclusive=True)
            expected.update(values)
        s3=self.client('s3')
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=self.state['bucket'],Prefix='inputs/'):
            for obj in page.get('Contents',[]):
                if obj['LastModified'].timestamp()<self.state['createdAt'] or not re.fullmatch(r'inputs/[a-f0-9-]{36}\.json',obj['Key']):continue
                target=objects/obj['Key'].replace('/','__')
                if target.exists():continue
                wanted=expected.get(obj['ETag'].strip('"'))
                if not wanted:continue
                response=s3.get_object(Bucket=self.state['bucket'],Key=obj['Key'],IfMatch=obj['ETag'])
                with response['Body'] as body:raw=body.read()
                if hashlib.sha256(raw).hexdigest()!=wanted or json.loads(raw)['input']['manifestHash']!=self.state['settings']['manifestHash']:raise RuntimeError('Public orphan content hash mismatch')
                with target.open('xb') as out:out.write(raw);out.flush();os.fsync(out.fileno())
                metadata=s3.head_object(Bucket=self.state['bucket'],Key=obj['Key'])
                if metadata.get('VersionId')!=response.get('VersionId'):raise RuntimeError('Public object version changed')
                persist(objects/(target.name+'.head.json'),metadata,exclusive=True)

    def reconcile_completed_requests(self):
        # Recover slots removed between observations from exact public object bytes
        # and independent immutable Batch metadata, never from arbitrary job names.
        from production_guard import owned
        known={json.dumps(r,sort_keys=True) for r in self.state['knownRequests']};recovered=set()
        inputs={}
        for path in (self.directory/'objects').glob('inputs__*.json'):
            if not re.fullmatch(r'inputs__[a-f0-9-]{36}\.json',path.name):continue
            raw=path.read_bytes();value=json.loads(raw)
            if value['input']['manifestHash']!=self.state['settings']['manifestHash']:raise RuntimeError('Foreign collected input')
            inputs['inputs/'+path.name[len('inputs__'):]]=hashlib.sha256(raw).hexdigest()
        ids=set()
        for status in ['SUCCEEDED','FAILED']:
            for page in self.client('batch').get_paginator('list_jobs').paginate(jobQueue=self.state['queue'],jobStatus=status):
                ids.update(x['jobId'] for x in page['jobSummaryList'])
        ordered=sorted(ids)
        for offset in range(0,len(ordered),100):
            chunk=ordered[offset:offset+100];jobs=self.client('batch').describe_jobs(jobs=chunk)['jobs']
            if sorted(j['jobId'] for j in jobs)!=chunk:raise RuntimeError('Incomplete reconciliation inventory')
            for job in jobs:
                if job.get('createdAt',0)<self.state['createdAt']*1000:continue
                env={x['name']:x['value'] for x in job.get('container',{}).get('environment',[])};key=env.get('QSB_INPUT_KEY')
                if key not in inputs or inputs[key]!=env.get('QSB_INPUT_SHA256'):continue
                request={'jobName':job['jobName'],'inputKey':key,'inputSha256':inputs[key],'definition':job['jobDefinition'],'queue':job['jobQueue']}
                checked_request(request,self.state['settings'])
                if not owned(job,[request],self.state['settings']):raise RuntimeError('Recovered native ownership mismatch')
                encoded=json.dumps(request,sort_keys=True)
                if encoded not in known:recovered.add(encoded)
        if recovered:
            settings=self.state['settings']
            self.mutate('recover-requests-'+str(time.time_ns()),'dynamodb','update_item',TableName=settings['table'],
                Key={'pk':{'S':settings['pk']},'sk':{'S':settings['ledgerSk']}},UpdateExpression='ADD #records :records',
                ConditionExpression='manifestHash = :hash AND #case = :case',ExpressionAttributeNames={'#records':'records','#case':'case'},
                ExpressionAttributeValues={':records':{'SS':sorted(recovered)},':hash':{'S':settings['manifestHash']},':case':{'S':self.state['name']}})
        return bool(recovered)

    def collect(self):
        self.binding();v=self.guard('collect');s=self.state;stamp=str(time.time_ns());persist(self.directory/('observation-'+stamp+'.json'),v,exclusive=True)
        for r in v['records']:checked_request(r,s['settings'])
        s['knownRequests']=v['records'];s['knownJobIds']=sorted(set(s['knownJobIds'])|{j['jobId'] for j in v['jobs']});self.save()
        self.collect_artifacts(v['jobs'],stamp)
        self.collect_public_orphans(v['publicRow'])
        if self.reconcile_completed_requests():
            v=self.guard('collect');s['knownRequests']=v['records'];s['knownJobIds']=sorted(set(s['knownJobIds'])|{j['jobId'] for j in v['jobs']});self.save();self.collect_artifacts(v['jobs'],stamp+'1');stamp+='1';persist(self.directory/('observation-'+stamp+'.json'),v,exclusive=True)
        if v['publicRow']:persist(self.directory/('solve-job-'+stamp+'.json'),v['publicRow'],exclusive=True)
        bad=[j for j in v['jobs'] if j['status']=='FAILED' and j.get('statusReason')!='QSB operator/coordinator cancellation']
        for j in v['jobs']:
            f=self.directory/'objects'/('outputs__'+j['jobId']+'.json')
            if incomplete_success(j,json.loads(f.read_text()) if f.exists() else None):bad.append(j)
        j=(v['publicRow'] or {}).get('job',{});running=any(e['status']=='RUNNING' for e in v['executions']) or any(x['status'] in ACTIVE for x in v['jobs'])
        print(dump({'phase':s['phase'],'status':j.get('status'),'stage':j.get('stage'),'submissions':j.get('gpuSubmissions'),'jobs':len(v['jobs']),'active':sum(x['status'] in ACTIVE for x in v['jobs']),'executions':len(v['executions'])}).strip())
        if bad or j.get('status') in ('failed','paused') or v['foreignActiveIds'] or any(e['status'] in ('FAILED','TIMED_OUT','ABORTED') for e in v['executions']):raise RuntimeError('Public workflow halted or unrelated work appeared; stop and reconcile')
        if j.get('status')=='awaiting_authorization' and not running:
            if len(v['jobs'])!=j.get('gpuSubmissions') or len(v['records'])!=j.get('gpuSubmissions'):raise RuntimeError('Paid inventory incomplete; never credit a selected subset')
            subprocess.run(['node','--import','tsx','ops/pqb-serving/fixture.ts','audit',str(self.directory),'native-index-'+stamp+'.json'],cwd=ROOT,env={**os.environ,'QSB_NETWORK':'mainnet'},check=True)
            persist(self.directory/'final-job.json',v['publicRow'],exclusive=True)
            subprocess.run(['node','--import','tsx','ops/pqb-serving/fixture.ts','verify',str(self.directory)],cwd=ROOT,env={**os.environ,'QSB_NETWORK':'mainnet'},check=True)
            s['phase']='complete';s['finalObservation']='observation-'+stamp+'.json';self.save()
        return v

    def stop(self):
        result=self.guard('stop')
        if result.get('drained') is not True and not result.get('drainedAt'):raise RuntimeError('Drain not verified')
        persist(self.directory/('stop-'+str(time.time_ns())+'.json'),result,exclusive=True);self.state['drained']=True;self.save()

    def seal(self):
        if not self.state.get('drained'):raise RuntimeError('Drain before sealing')
        value=self.guard('collect');stamp=str(time.time_ns());row=value['publicRow']
        if any(j['status'] in ACTIVE for j in value['jobs']) or any(e['status']=='RUNNING' for e in value['executions']):raise RuntimeError('Public work not terminal')
        row=row or value.get('lastPublicRow')
        self.collect_public_orphans(row)
        if self.reconcile_completed_requests():value=self.guard('collect')
        paid=value.get('paidSubmissions',0)
        if len(value['jobs'])!=paid or len(value['records'])!=paid:raise RuntimeError('Public paid inventory unresolved')
        if not row and (self.directory/'requests/execution.intent.json').exists():raise RuntimeError('Executed fixture state missing')
        self.state['knownRequests']=value['records'];self.state['knownJobIds']=sorted(j['jobId'] for j in value['jobs']);self.save()
        self.collect_artifacts(value['jobs'],stamp);self.collect_public_orphans(row)
        from production_guard import decode
        rows={}
        for sk in [self.state['settings']['sk'],'VAULT#'+self.state['settings']['vaultId'],self.state['settings']['ledgerSk']]:
            item=self.client('dynamodb').get_item(TableName=self.state['settings']['table'],Key={'pk':{'S':self.state['settings']['pk']},'sk':{'S':sk}},ConsistentRead=True).get('Item')
            if item:rows[sk]=item
            elif sk==self.state['settings']['ledgerSk'] or ((self.directory/'requests/execution.intent.json').exists() and time.time()<self.state['expiresAt']):raise RuntimeError('Fixture evidence row missing before TTL or registry missing')
        for item in self.owner_rows():
            if item['sk']['S'].startswith('EVENT#'):
                checked_event({k:decode(v) for k,v in item.items()},self.state['settings']);rows[item['sk']['S']]=item
            elif item['sk']['S'] not in rows:raise RuntimeError('Unrelated public partition row')
        persist(self.directory/'final-rows.json',rows,exclusive=True);persist(self.directory/'final-observation.json',value,exclusive=True)
        group='/aws/lambda/'+self.state['guardFunction'];persist(self.directory/'guard-logs.json',self.log_pages(logGroupName=group),exclusive=True)
        files=[f for f in self.directory.rglob('*') if f.is_file() and f.name not in ('campaign.json','final-collection.json') and not f.name.endswith('.lock')]
        receipt={'sourceCommit':self.state['sourceCommit'],'name':self.state['name'],'nativeJobIds':self.state['knownJobIds'],'paidSubmissions':paid,'files':{str(f.relative_to(self.directory)):hashlib.sha256(f.read_bytes()).hexdigest() for f in files}}
        persist(self.directory/'final-collection.json',receipt,exclusive=True);self.state['finalCollectionSha256']=hashlib.sha256((self.directory/'final-collection.json').read_bytes()).hexdigest();self.state['phase']='sealed';self.save();print('Public collection sealed; production resources retained')

    def remove(self):
        from production_guard import decode
        if self.state['phase']!='sealed' or not self.state.get('drained'):raise RuntimeError('Require sealed terminal collection')
        raw=(self.directory/'final-collection.json').read_bytes()
        if hashlib.sha256(raw).hexdigest()!=self.state['finalCollectionSha256']:raise RuntimeError('Collection receipt changed')
        receipt=json.loads(raw)
        if any(hashlib.sha256((self.directory/f).read_bytes()).hexdigest()!=h for f,h in receipt['files'].items()):raise RuntimeError('Retained bytes changed')
        settings=self.state['settings'];schedule=self.client('scheduler').get_schedule(Name=self.state['schedule'])
        if schedule['Target']['Arn']!=self.arn('lambda','function:'+self.state['guardFunction']) or schedule['Target']['RoleArn']!=self.iam(self.state['roles'][1]):raise RuntimeError('Guard target changed')
        Campaign.check_function(self.client('lambda').get_function_configuration(FunctionName=self.state['guardFunction']),json.loads((self.directory/'requests/guard-function.response.json').read_text())['result'])
        self.mutate('remove-schedule','scheduler','delete_schedule',Name=self.state['schedule'])
        self.mutate('remove-function','lambda','delete_function',FunctionName=self.state['guardFunction'])
        for i,head_path in enumerate(sorted((self.directory/'objects').glob('*.head.json'))):
            key=head_path.name[:-10].replace('__','/');body=json.loads(head_path.with_name(head_path.name[:-10]).read_text());head=json.loads(head_path.read_text())
            if not re.fullmatch(r'(inputs|outputs)/[a-f0-9-]{36}\.json',key):raise RuntimeError('Unexpected public object key')
            if key.startswith('inputs/'):
                if body['input']['manifestHash']!=settings['manifestHash']:raise RuntimeError('Another input')
            elif body['jobId'] not in receipt['nativeJobIds']:raise RuntimeError('Another output')
            current=self.client('s3').head_object(Bucket=self.state['bucket'],Key=key)
            if current.get('VersionId')!=head.get('VersionId') or current['ETag']!=head['ETag']:raise RuntimeError('Object changed after collection')
            args={'Bucket':self.state['bucket'],'Key':key}
            if 'VersionId' in head:args['VersionId']=head['VersionId']
            self.mutate('remove-object-'+str(i),'s3','delete_object',**args)
        rows=json.loads((self.directory/'final-rows.json').read_text())
        for i,(sk,item) in enumerate(rows.items()):
            decoded={k:decode(v) for k,v in item.items()};values={}
            if sk==settings['sk']:
                condition='#j.#id = :id AND #j.manifestHash = :hash AND #j.#status = :status AND #v = :version'
                names={'#j':'job','#status':'status','#v':'version','#id':'id'};values={':id':{'S':settings['jobId']},':hash':{'S':settings['manifestHash']},':status':{'S':decoded['job']['status']},':version':{'N':str(decoded['version'])}}
                if decoded['job']['status'] in ('queued','searching'):raise RuntimeError('Fixture still active')
            elif sk.startswith('VAULT#'):
                condition='#vault.#id = :id AND #vault.scriptHash = :hash AND #v = :version';names={'#vault':'vault','#v':'version','#id':'id'};values={':id':{'S':settings['vaultId']},':hash':{'S':decoded['vault']['scriptHash']},':version':{'N':str(decoded['version'])}}
            elif sk.startswith('EVENT#'):
                checked_event(decoded,settings);condition='#event = :event AND #v = :version';names={'#event':'event','#v':'version'};values={':event':item['event'],':version':item['version']}
            elif sk==settings['ledgerSk']:
                condition='manifestHash = :hash AND #c = :case AND drainedAt = :drained';names={'#c':'case'};values={':hash':{'S':settings['manifestHash']},':case':{'S':self.state['name']},':drained':item['drainedAt']}
                if item.get('records'):condition+=' AND #records = :records';names['#records']='records';values[':records']=item['records']
            else:raise RuntimeError('Refuse unrelated row deletion')
            self.mutate('remove-row-'+str(i),'dynamodb','delete_item',TableName=settings['table'],Key={'pk':{'S':settings['pk']},'sk':{'S':sk}},ConditionExpression=condition,ExpressionAttributeNames=names,ExpressionAttributeValues=values)
        for role in self.state['roles']:
            actual=self.client('iam').get_role(RoleName=role)['Role']
            if actual['Path']!='/qsb/runtime/' or {x['Key']:x['Value'] for x in actual.get('Tags',[])}.get('PqbValidation')!=self.state['name']:raise RuntimeError('Runtime role ownership changed')
            if self.client('iam').list_role_policies(RoleName=role)['PolicyNames']!=['validation'] or self.client('iam').list_attached_role_policies(RoleName=role)['AttachedPolicies']:raise RuntimeError('Unexpected runtime policy')
            self.mutate('remove-policy-'+role,'iam','delete_role_policy',RoleName=role,PolicyName='validation');self.mutate('remove-role-'+role,'iam','delete_role',RoleName=role)
        group='/aws/lambda/'+self.state['guardFunction']
        if self.client('logs').list_tags_log_group(logGroupName=group)['tags'].get('PqbValidation')!=self.state['name']:raise RuntimeError('Log ownership changed')
        self.mutate('remove-logs','logs','delete_log_group',logGroupName=group)
        self.state['phase']='removal-requested';self.save();print('Removed only public fixture objects/rows and dedicated guard resources; verify independently')

    def owner_rows(self):
        settings=self.state['settings'];rows=[]
        for page in self.client('dynamodb').get_paginator('query').paginate(TableName=settings['table'],KeyConditionExpression='pk = :pk',ExpressionAttributeValues={':pk':{'S':settings['pk']}},ConsistentRead=True):rows+=page['Items']
        return rows

    def events(self):
        # Reconciliation after an older removal: never restart or submit work.
        from production_guard import decode
        if self.state['phase']!='removal-requested' or not self.state.get('drained'):raise RuntimeError('Remove and drain before event reconciliation')
        raw=(self.directory/'final-collection.json').read_bytes()
        if hashlib.sha256(raw).hexdigest()!=self.state['finalCollectionSha256']:raise RuntimeError('Sealed scope changed')
        if any(page['executions'] for page in self.client('stepfunctions').get_paginator('list_executions').paginate(stateMachineArn=self.state['workflow'],statusFilter='RUNNING')):raise RuntimeError('Wait for workflow completion')
        rows=self.owner_rows();settings=self.state['settings']
        for item in rows:checked_event({k:decode(v) for k,v in item.items()},settings)
        persist(self.directory/('event-reconciliation-'+str(time.time_ns())+'.json'),rows,exclusive=True)
        for item in rows:
            self.mutate('remove-event-'+hashlib.sha256(item['sk']['S'].encode()).hexdigest(),'dynamodb','delete_item',TableName=settings['table'],Key={k:item[k] for k in ['pk','sk']},ConditionExpression='#event = :event AND #v = :version',ExpressionAttributeNames={'#event':'event','#v':'version'},ExpressionAttributeValues={':event':item['event'],':version':item['version']})
        print('Only attributed synthetic owner events removed; verify the full partition independently')

    def abort(self):
        # Before fixture insertion there can be no compute trigger from this controller.
        if any((self.directory/('requests/'+n+'.intent.json')).exists() for n in ['fixture-rows','execution']):raise RuntimeError('Use guarded drain/seal for an inserted or started fixture')
        from botocore.exceptions import ClientError
        def optional(service,operation,**args):
            try:return getattr(self.client(service),operation)(**args)
            except ClientError as e:
                if e.response['Error']['Code'] in ('ResourceNotFoundException','NoSuchEntity'):return None
                if service=='iam' and operation=='get_role' and e.response['Error']['Code'] in ('AccessDenied','AccessDeniedException'):
                    import boto3
                    session=boto3.Session(profile_name='qsb-viewonly-euw2',region_name=self.region)
                    if session.client('sts',config=self.read_sdk_config).get_caller_identity()['Account']!=self.account:raise RuntimeError('Wrong metadata account')
                    try:return session.client('iam',config=self.read_sdk_config).get_role(**args)
                    except ClientError as missing:
                        if missing.response['Error']['Code']=='NoSuchEntity':return None
                        raise
                raise
        settings=self.state['settings'];rows=self.client('dynamodb').query(TableName=settings['table'],KeyConditionExpression='pk = :pk',ExpressionAttributeValues={':pk':{'S':settings['pk']}},ProjectionExpression='pk, sk',ConsistentRead=True)
        if rows.get('LastEvaluatedKey') or any(x['sk']['S']!=settings['ledgerSk'] for x in rows['Items']):raise RuntimeError('Unexpected public owner rows; reconcile')
        resources={'schedule':optional('scheduler','get_schedule',Name=self.state['schedule']),
            'function':optional('lambda','get_function_configuration',FunctionName=self.state['guardFunction']),
            'roles':{r:optional('iam','get_role',RoleName=r) for r in self.state['roles']}}
        if resources['schedule']:
            target=resources['schedule']['Target']
            if target['Arn']!=self.arn('lambda','function:'+self.state['guardFunction']) or target['RoleArn']!=self.iam(self.state['roles'][1]):raise RuntimeError('Unexpected guard schedule')
        if resources['function']:
            tags=self.client('lambda').list_tags(Resource=self.arn('lambda','function:'+self.state['guardFunction']))['Tags']
            if tags.get('PqbValidation')!=self.state['name'] or base64.b64decode(resources['function']['CodeSha256']).hex()!=hashlib.sha256((self.directory/'guard.zip').read_bytes()).hexdigest():raise RuntimeError('Unexpected guard function')
        persist(self.directory/('abort-inventory-'+str(time.time_ns())+'.json'),resources,exclusive=True)
        if resources['schedule']:self.mutate('abort-schedule','scheduler','delete_schedule',Name=self.state['schedule'])
        if resources['function']:self.mutate('abort-function','lambda','delete_function',FunctionName=self.state['guardFunction'])
        for role,value in resources['roles'].items():
            if not value:continue
            actual=value['Role']
            if actual['Path']!='/qsb/runtime/' or {x['Key']:x['Value'] for x in actual.get('Tags',[])}.get('PqbValidation')!=self.state['name']:raise RuntimeError('Unexpected guard role')
            policies=self.client('iam').list_role_policies(RoleName=role)['PolicyNames']
            if set(policies)-{'validation'} or self.client('iam').list_attached_role_policies(RoleName=role)['AttachedPolicies']:raise RuntimeError('Unexpected role policy')
            if policies:self.mutate('abort-policy-'+role,'iam','delete_role_policy',RoleName=role,PolicyName='validation')
            self.mutate('abort-role-'+role,'iam','delete_role',RoleName=role)
        if rows['Items']:
            self.mutate('abort-registry','dynamodb','delete_item',TableName=settings['table'],Key={'pk':{'S':settings['pk']},'sk':{'S':settings['ledgerSk']}},ConditionExpression='manifestHash = :hash AND #c = :case AND attribute_not_exists(#records)',ExpressionAttributeNames={'#c':'case','#records':'records'},ExpressionAttributeValues={':hash':{'S':settings['manifestHash']},':case':{'S':self.state['name']}})
        group='/aws/lambda/'+self.state['guardFunction'];groups=[x for page in self.client('logs').get_paginator('describe_log_groups').paginate(logGroupNamePrefix=group) for x in page['logGroups'] if x['logGroupName']==group]
        if groups:
            if self.client('logs').list_tags_log_group(logGroupName=group)['tags'].get('PqbValidation')!=self.state['name']:raise RuntimeError('Unexpected guard logs')
            self.mutate('abort-logs','logs','delete_log_group',logGroupName=group)
        self.state['phase']='abort-removal-requested';self.save();print('Pre-start resources removed; verify independently before releasing reservation')

    def run(self):
        from monitor import archive, watcher_lock, Monitor
        # Reuse only the independent metadata reader/archive, never its stop policy.
        observer=object.__new__(Monitor);observer.operator=self.config
        with watcher_lock(self.directory):
            try:
                while self.state['phase']=='running':
                    if time.time()>=self.state['stopAt']-120:raise RuntimeError('Public assessment soft deadline reached')
                    self.collect();archive(self.directory,observer.read)
                    if self.state['phase']=='complete':return
                    time.sleep(5)
            except Exception:
                self.stop();raise

def main():
    os.umask(0o077);p=argparse.ArgumentParser(description=__doc__);p.add_argument('mode',choices=['prepare','arm','start','collect','run','stop','seal','remove','events','abort']);p.add_argument('directory',type=Path);a=p.parse_args();getattr(Production(a.directory),a.mode)()
if __name__=='__main__':main()
