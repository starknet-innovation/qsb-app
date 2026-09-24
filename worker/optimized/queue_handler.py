"""Queue adapter for isolated validation. Child never receives provider credentials."""
import hashlib,json,os,pathlib,signal,subprocess,tempfile
ROOT=pathlib.Path('/opt/qsb-validation')
SELF=pathlib.Path(__file__)
MAX=2_000_000
TIMEOUT=900

def canonical(x):return json.dumps(x,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def handler(job):
    if type(job)!=dict or type(job.get('id'))!=str or not job['id']:raise ValueError('Missing provider job ID')
    event=job.get('input')
    if type(event)!=dict or set(event)!={'action','runtimeHash','request'} or event['action']!='compute':raise ValueError('Only bound compute requests accepted')
    raw=canonical(event)
    if len(raw)>MAX:raise ValueError('Request too large')
    want=hashlib.sha256((ROOT/'runtime-binding.json').read_bytes()).hexdigest()
    if event['runtimeHash']!=want:raise ValueError('Runtime identity mismatch')
    env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','PYTHONDONTWRITEBYTECODE':'1'}
    for k in ('CUDA_VISIBLE_DEVICES','NVIDIA_VISIBLE_DEVICES','LD_LIBRARY_PATH'):
        if k in os.environ:env[k]=os.environ[k]
    with tempfile.TemporaryFile() as out,tempfile.TemporaryFile() as err:
        proc=subprocess.Popen(['/usr/bin/python3',str(ROOT/'runtime.py')],stdin=subprocess.PIPE,stdout=out,stderr=err,env=env,start_new_session=True)
        try:proc.communicate(raw,timeout=TIMEOUT)
        except BaseException:
            try:os.killpg(proc.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            proc.wait();raise
        out.seek(0);data=out.read(MAX+1)
        if len(data)>MAX:raise ValueError('Runtime response too large')
        if proc.returncode:raise ValueError('Runtime process failed')
        value=json.loads(data)
        if type(value)!=dict or set(value)!={'ok','result'} or value['ok'] is not True:raise ValueError('Invalid runtime response')
        result=value['result']
        if type(result)!=dict or set(result)!={'runtimeHash','output'} or result['runtimeHash']!=want:raise ValueError('Runtime output identity mismatch')
        if result['output'].get('status')!='completed' or result['output'].get('checkpoint')!='range-complete':raise ValueError('Solver range did not complete')
    return {'transport':{'providerJobId':job['id'],'adapterSha256':hashlib.sha256(SELF.read_bytes()).hexdigest(),'inputSha256':hashlib.sha256(raw).hexdigest()},'runtime':result}
if __name__=='__main__':
    import runpod
    runpod.serverless.start({'handler':handler})
