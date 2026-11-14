"""Read-only CLI verification of one deployed public campaign's cleanup."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from control import Campaign, dump, persist
from production_guard import owned

def main():
    os.umask(0o077);p=argparse.ArgumentParser(description=__doc__);p.add_argument('directory',type=Path);a=p.parse_args();root=a.directory.resolve();s=json.loads((root/'campaign.json').read_text());operator=json.loads((root/'operator.json').read_text());settings=s['settings']
    if s['format']!='pqb-deployed-campaign-v1' or s['phase'] not in ('removal-requested','abort-removal-requested'):raise RuntimeError('Require scoped removal first')
    stamp=str(time.time_ns());d=root/('independent-readbacks-'+stamp);d.mkdir();checks=[]
    def check(name,value):checks.append({'check':name,'passed':bool(value)})
    def read(name,service,operation,args,absent=(),view=False):
        if not operation.startswith(('get-','head-','list-','describe-')):raise RuntimeError('Read-only verification')
        cmd=['aws',service,operation,'--profile','qsb-viewonly-euw2' if view else operator['profile'],'--region',operator['region'],'--cli-connect-timeout','5','--cli-read-timeout','20','--no-cli-pager','--output','json',*args]
        r=subprocess.run(cmd,capture_output=True,text=True);record={'label':name,'observedAt':time.time(),'exitCode':r.returncode}
        if r.returncode:
            m=re.search(r'An error occurred \(([^)]+)\)',r.stderr);code=m[1] if m else None;record.update(errorCode=code,stderr=r.stderr);value=None if code in absent else {'unresolvedError':code or 'CLI failure'}
        else:value=json.loads(r.stdout) if r.stdout.strip() else {};record['value']=value
        persist(d/(str(len(list(d.glob('*.json'))))+'.json'),record,exclusive=True);return value
    who=read('operator','sts','get-caller-identity',[]);check('correct account',who.get('Account')==operator['account'])
    metadata=read('metadata observer','sts','get-caller-identity',[],view=True)
    if metadata.get('Account')!=operator['account']:raise RuntimeError('Metadata profile account mismatch; do not attest absence')
    check('metadata observer account',True)
    abort=s['phase']=='abort-removal-requested';sealed=None
    if not abort:
        raw=(root/'final-collection.json').read_bytes();check('sealed receipt',hashlib.sha256(raw).hexdigest()==s['finalCollectionSha256']);sealed=json.loads(raw);check('original receipt bytes unchanged',all(hashlib.sha256((root/f).read_bytes()).hexdigest()==h for f,h in sealed['files'].items()))
    else:check('no fixture or compute trigger attempted',not any((root/('requests/'+n+'.intent.json')).exists() for n in ['fixture-rows','execution']))
    missing=('ResourceNotFoundException','NoSuchEntity')
    check('guard absent',read('guard','lambda','get-function-configuration',['--function-name',s['guardFunction']],absent=missing) is None)
    check('schedule absent',read('schedule','scheduler','get-schedule',['--name',s['schedule']],absent=missing) is None)
    for role in s['roles']:check('role absent '+role,read(role,'iam','get-role',['--role-name',role],absent=missing,view=True) is None)
    group='/aws/lambda/'+s['guardFunction'];logs=read('guard logs','logs','describe-log-groups',['--log-group-name-prefix',group]);check('guard logs absent','logGroups' in logs and all(x['logGroupName']!=group for x in logs['logGroups']))
    for sk in [settings['sk'],'VAULT#'+settings['vaultId'],settings['ledgerSk']]:
        value=read('fixture row','dynamodb','get-item',['--table-name',settings['table'],'--key',json.dumps({'pk':{'S':settings['pk']},'sk':{'S':sk}}),'--consistent-read']);check('public row absent '+sk,'unresolvedError' not in value and not value.get('Item'))
    partition=read('public owner partition','dynamodb','query',['--table-name',settings['table'],'--key-condition-expression','pk = :pk','--expression-attribute-values',json.dumps({':pk':{'S':settings['pk']}}),'--select','COUNT','--consistent-read'])
    check('entire synthetic owner partition empty',partition.get('Count')==0 and not partition.get('LastEvaluatedKey'))
    snapshot=json.loads((root/'deployed-binding.json').read_text())
    for n,expected in snapshot['functions'].items():
        actual=read('deployed '+n,'lambda','get-function-configuration',['--function-name','qsb-app-'+n])
        try:Campaign.check_function(actual,expected);same=True
        except (RuntimeError,KeyError):same=False
        check('production '+n+' unchanged',same)
    wf=read('production workflow','stepfunctions','describe-state-machine',['--state-machine-arn',s['workflow']]);check('production workflow unchanged',wf.get('definition')==snapshot['workflow']['definition'] and wf.get('roleArn')==snapshot['workflow']['roleArn'])
    definitions=read('served definition','batch','describe-job-definitions',['--job-definitions',s['definition']]);check('served definition active unchanged',definitions.get('jobDefinitions')==snapshot['definition'] and snapshot['definition'][0]['status']=='ACTIVE')
    ce=read('production compute','batch','describe-compute-environments',['--compute-environments',snapshot['computeEnvironments'][0]['computeEnvironmentArn']]);actual=ce.get('computeEnvironments',[]);old=snapshot['computeEnvironments'][0]
    check('normal compute preserved',len(actual)==1 and actual[0]['state']=='ENABLED' and actual[0]['status']=='VALID' and {k:v for k,v in actual[0]['computeResources'].items() if k!='desiredvCpus'}=={k:v for k,v in old['computeResources'].items() if k!='desiredvCpus'});check('desired capacity zero',len(actual)==1 and actual[0]['computeResources']['desiredvCpus']==0)
    for status in ('SUBMITTED','PENDING','RUNNABLE','STARTING','RUNNING'):
        active=read('queue '+status,'batch','list-jobs',['--job-queue',s['queue'],'--job-status',status]);check('queue terminal '+status,'jobSummaryList' in active and not active['jobSummaryList'])
    ids=s.get('knownJobIds',[]);jobs=[]
    for offset in range(0,len(ids),100):jobs+=read('owned native jobs','batch','describe-jobs',['--jobs',*ids[offset:offset+100]]).get('jobs',[])
    check('all owned native work terminal',sorted(j['jobId'] for j in jobs)==sorted(ids) and all(j['status'] in ('SUCCEEDED','FAILED') and owned(j,s['knownRequests'],settings) for j in jobs))
    if sealed:check('paid work reconciled',len(jobs)==sealed['paidSubmissions']==len(s['knownRequests']))
    groups=snapshot['computeEnvironments'][0]['computeResources']['securityGroupIds']
    fleet=read('current pool fleet','ec2','describe-instances',['--filters','Name=instance.group-id,Values='+','.join(groups)])
    check('current pool fleet empty','Reservations' in fleet and not any(i['State']['Name']!='terminated' for r in fleet['Reservations'] for i in r['Instances']))
    if 'Reservations' in fleet:persist(root/('instances-'+stamp+'.json'),fleet,exclusive=True)
    baseline=json.loads((root/'instance-baseline.json').read_text());oldids={i['InstanceId'] for r in baseline['Reservations'] for i in r['Instances']};hosts={};volumes=set()
    history=[*(root/'capacity/instance-history').glob('*.json'),*root.glob('instances-*.json')]
    for f in history:
        for r in json.loads(f.read_text()).get('Reservations',[]):
            for i in r['Instances']:
                if i['InstanceId'] in oldids:continue
                h=hosts.setdefault(i['InstanceId'],{'terminal':False,'volumes':set()});h['terminal']|=i['State']['Name']=='terminated';h['volumes'].update(x['Ebs']['VolumeId'] for x in i.get('BlockDeviceMappings',[]) if x.get('Ebs'))
    for identity,h in hosts.items():
        value=read('host '+identity,'ec2','describe-instances',['--instance-ids',identity],absent=('InvalidInstanceID.NotFound',));found=[i for r in (value or {}).get('Reservations',[]) for i in r['Instances']]
        check('host terminated '+identity,(len(found)==1 and found[0]['State']['Name']=='terminated') or ((value is None or value.get('Reservations')==[]) and h['terminal']));check('volume inventory captured '+identity,bool(h['volumes']));volumes.update(h['volumes'])
    for f in (root/'capacity/volume-history').glob('*.json'):
        for volume in json.loads(f.read_text()).get('Volumes',[]):
            if any(a.get('InstanceId') in hosts for a in volume.get('Attachments',[])):volumes.add(volume['VolumeId'])
    for v in volumes:check('volume absent '+v,read(v,'ec2','describe-volumes',['--volume-ids',v],absent=('InvalidVolume.NotFound',)) is None)
    for f in sorted((root/'objects').glob('*.head.json')):
        key=f.name[:-10].replace('__','/');head=json.loads(f.read_text());args=['--bucket',s['bucket'],'--key',key]
        if head.get('VersionId'):args+=['--version-id',head['VersionId']]
        check('owned object version absent '+key,read('object absence','s3api','head-object',args,absent=('404','NoSuchKey','NoSuchVersion')) is None)
        check('owned current object absent '+key,read('current object absence','s3api','head-object',['--bucket',s['bucket'],'--key',key],absent=('404','NoSuchKey')) is None)
    running=read('production workflow inventory','stepfunctions','list-executions',['--state-machine-arn',s['workflow'],'--status-filter','RUNNING']);check('no pending workflow executions','executions' in running and not running['executions'])
    result={'verified':all(x['passed'] for x in checks),'checks':checks,'recordedHosts':len(hosts),'recordedVolumes':len(volumes),'sourceCommit':s['sourceCommit'],'deployedSourceCommit':s['deployedSourceCommit'],'observedAt':time.time(),'providerBillingQueried':False,'validatorSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()};out=root/('independent-cleanup-'+stamp+'.json');persist(out,result,exclusive=True);print(json.dumps({'verified':result['verified'],'failedChecks':[x['check'] for x in checks if not x['passed']],'receipt':out.name}))
if __name__=='__main__':main()
