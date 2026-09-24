"""Offline SDK registration/handler failure check, not a remote provider queue run."""
import argparse
import json
from pathlib import Path
import subprocess
from test_pin_reference import ReferenceBinding
from package_pin_runtime import FROZEN_BINARY

BOOTSTRAP='''import hashlib,importlib.metadata,json,runpy,sys
import runpod
captured=[]
runpod.serverless.start=lambda config:captured.append(config)
runpy.run_path('/opt/qsb/pin_queue.py',run_name='__main__')
assert len(captured)==1 and callable(captured[0]['handler'])
request=json.load(sys.stdin)
manifest=hashlib.sha256(open('/opt/qsb/runtime-manifest.json','rb').read()).hexdigest()
job={'id':'offline-sdk-test','input':{'runtimeManifestSha256':manifest,'request':request}}
records=[]
for name,entry,want in [('no GPU',job,'Range did not drain'),('wrong manifest',{'id':'offline-sdk-test','input':{'runtimeManifestSha256':'0'*64,'request':request}},'Runtime manifest mismatch')]:
 try:captured[0]['handler'](entry)
 except ValueError as e:
  assert str(e)==want,(name,str(e));records.append({'case':name,'rejected':True,'error':str(e)})
 else:raise AssertionError('Unexpected queue success')
print('QSB_CHECK='+json.dumps({'sdkVersion':importlib.metadata.version('runpod'),'sdkStartIntercepted':True,'checks':records,'remoteQueueTested':False,'gpuSuccessEstablished':False,'releaseStatus':'HOLD'}))
'''
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--image',required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
    ReferenceBinding.setUpClass();request={**ReferenceBinding.req,'binarySha256':FROZEN_BINARY}
    r=subprocess.run(['docker','run','--rm','--platform','linux/amd64','--network','none','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=64m','-i','--entrypoint','/opt/venv/bin/python',a.image,'-c',BOOTSTRAP],input=json.dumps(request),capture_output=True,text=True,timeout=120)
    if r.returncode:raise ValueError('Offline SDK check failed: '+r.stderr[-1000:])
    lines=[line.removeprefix('QSB_CHECK=') for line in r.stdout.splitlines() if line.startswith('QSB_CHECK=')]
    if len(lines)!=1:raise ValueError('Missing exact check receipt')
    value=json.loads(lines[0])
    with a.out.open('x') as f:json.dump(value,f,indent=2);f.write('\n')
