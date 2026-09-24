"""Offline image checks; optional public historical CPU replay is never a GPU search."""
import argparse
import json
from pathlib import Path
import subprocess
from package_pin_runtime import FROZEN_BINARY
from test_pin_reference import ReferenceBinding

def check(image,bundle=None):
    ReferenceBinding.setUpClass();context=ReferenceBinding.ctx
    request={**ReferenceBinding.req,'binarySha256':FROZEN_BINARY}
    output={**ReferenceBinding.out,'binarySha256':FROZEN_BINARY}
    records=[]
    def run(name,event,accept=True):
        r=subprocess.run(['docker','run','--rm','--platform','linux/amd64','--network','none','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=64m','-i',image],input=json.dumps(event),text=True,capture_output=True,timeout=120)
        if (r.returncode==0)!=accept:raise ValueError(name+' unexpected exit '+str(r.returncode)+': '+r.stderr[-500:])
        value=json.loads(r.stdout) if accept else None
        records.append({'case':name,'exitCode':r.returncode,'accepted':accept})
        return value
    no_gpu=run('real frozen compute without GPU',{'action':'compute','request':request})
    if no_gpu['status']!='failed' or no_gpu['candidates'] or no_gpu['rangeCreditEligible'] is not False:raise ValueError('No-GPU failure not closed')
    bound=run('real CPU parameter binding',{'action':'verify','request':request,'output':output,'context':context})
    if bound['referenceChecked'] is not True or bound['rangeCreditEligible'] is not False:raise ValueError('Unexpected binding')
    for name,event in [('unknown action',{'action':'deploy'}),('extra private field',{'action':'compute','request':request,'backup':None}),('wrong binary',{'action':'compute','request':{**request,'binarySha256':'0'*64}}),('failed output',{'action':'verify','request':request,'output':{**output,'status':'failed'},'context':context}),('invalid pin',{'action':'handoff','context':context,'candidate':{'sequence':0,'locktime':500000000}}),('false candidate',{'action':'verify','request':request,'output':{**output,'candidates':[{'sequence':2147483648,'locktime':500000000,'recid':0}]},'context':context})]:run(name,event,False)
    positive=None
    if bundle:
        b=json.loads(bundle.read_text());ctx={'publicStateJson':b['request']['vault']['publicStateJson'],'manifest':b['fixture']['manifest']};pin={k:b['solution'][k] for k in ('sequence','locktime')}
        got=run('historical CPU handoff, no search',{'action':'handoff','context':ctx,'candidate':pin})
        if got['pin']!=pin or got['dispatchAuthorized'] is not False or set(got['parameters'])!={'round1','round2'}:raise ValueError('Invalid positive handoff')
        positive={'contextHash':got['contextHash'],'parameterHashes':{k:v['parameterSha256'] for k,v in got['parameters'].items()},'cpuOnlyHistoricalReplay':True}
    return {'scope':'Offline read-only image entrypoint; no GPU available','binarySha256':FROZEN_BINARY,'cases':records,'positive':positive,'gpuSuccessEstablished':False,'providerQueueTested':False,'fixtureSpentThisRun':False,'releaseStatus':'HOLD'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--image',required=True);p.add_argument('--public-bundle',type=Path);p.add_argument('--out',type=Path,required=True);a=p.parse_args();result=check(a.image,a.public_bundle)
    with a.out.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
