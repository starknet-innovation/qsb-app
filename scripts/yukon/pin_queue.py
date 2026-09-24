"""Runpod compute-only transport for the isolated pin runtime; no submission API."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile

ROOT=Path('/opt/qsb')
MAX=2000000
TIMEOUT=900

def digest(raw):return hashlib.sha256(raw).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()

def handler(job):
    if not isinstance(job,dict) or not isinstance(job.get('id'),str) or not 1<=len(job['id'])<=512:raise ValueError('Provider job ID required')
    event=job.get('input')
    if not isinstance(event,dict) or set(event)!={'runtimeManifestSha256','request'}:raise ValueError('Bound compute envelope required')
    raw=canonical(event)
    if len(raw)>MAX:raise ValueError('Oversized input')
    binding=json.loads((ROOT/'queue-binding.json').read_text())
    if binding.get('format')!='qsb-yukon-pin-queue-v1' or binding.get('dispatchAuthorized') is not False:raise ValueError('Research queue binding required')
    for name,want in binding['files'].items():
        if name not in {'pin_queue.py','requirements.lock','runtime-manifest.json'}:raise ValueError('Unexpected queue artifact')
        p=ROOT/name
        if p.is_symlink() or digest(p.read_bytes())!=want:raise ValueError('Queue artifact mismatch')
    if set(binding['files'])!={'pin_queue.py','requirements.lock','runtime-manifest.json'}:raise ValueError('Incomplete queue closure')
    manifest_raw=(ROOT/'runtime-manifest.json').read_bytes();manifest=json.loads(manifest_raw);want=digest(manifest_raw)
    if event['runtimeManifestSha256']!=want:raise ValueError('Runtime manifest mismatch')
    request=event['request']
    if not isinstance(request,dict) or request.get('protocol')!='qsb-yukon-pinning-research-v1' or request.get('binarySha256')!=manifest['files']['bin/pinning']:raise ValueError('Wrong solver protocol/binary')
    env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','PYTHONDONTWRITEBYTECODE':'1'}
    for name in ('CUDA_VISIBLE_DEVICES','NVIDIA_VISIBLE_DEVICES','LD_LIBRARY_PATH'):
        if name in os.environ:env[name]=os.environ[name]
    with tempfile.TemporaryFile() as out,tempfile.TemporaryFile() as err:
        # Set limits inside the fresh child: preexec_fn is unsafe in threaded SDK workers.
        bootstrap='import resource,runpy,sys;resource.setrlimit(resource.RLIMIT_FSIZE,('+str(MAX)+','+str(MAX)+'));runpy.run_path(sys.argv[1],run_name="__main__")'
        process=subprocess.Popen(['/usr/bin/python3','-I','-c',bootstrap,str(ROOT/'scripts/yukon/pin_worker.py')],stdin=subprocess.PIPE,stdout=out,stderr=err,env=env,start_new_session=True)
        try:process.communicate(canonical({'action':'compute','request':request}),timeout=TIMEOUT)
        except BaseException:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            process.wait();raise
        if process.returncode:raise ValueError('Pin worker failed')
        out.seek(0);data=out.read(MAX+1)
        if len(data)>MAX:raise ValueError('Oversized runtime output')
        output=json.loads(data)
    if not isinstance(output,dict) or set(output)!={'protocol','requestId','manifestHash','binarySha256','parameterSha256','range','status','candidates','verified','rangeCreditEligible','releaseStatus'}:raise ValueError('Malformed runtime result')
    for k in ('protocol','requestId','manifestHash','binarySha256','parameterSha256','range'):
        if output[k]!=request.get(k):raise ValueError('Runtime result binding mismatch')
    if output['status']!='range-drained' or output['verified'] is not False or output['rangeCreditEligible'] is not False or output['releaseStatus']!='HOLD' or not isinstance(output['candidates'],list) or len(output['candidates'])>4096:raise ValueError('Range did not drain')
    return {'protocol':'qsb-yukon-pin-queue-v1','providerJobId':job['id'],'runtimeManifestSha256':want,'inputSha256':digest(raw),'output':output}

if __name__=='__main__':
    import runpod
    runpod.serverless.start({'handler':handler})
