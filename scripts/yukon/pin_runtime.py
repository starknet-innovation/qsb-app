"""Isolated pinning runtime contract. No provider, durable credit or signing access."""
import base64
import hashlib
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile

PROTOCOL='qsb-yukon-pinning-research-v1'
FIELDS={'protocol','requestId','manifestHash','binarySha256','parameterBase64','parameterSha256','range'}
RANGE_FIELDS={'sequence','sequenceCount','locktime','locktimeCount'}
HEX=re.compile(r'[0-9a-f]{64}')
HIT=re.compile(r'sequence=(\d+) locktime=(\d+) recid=([01])')
MAX_OUTPUT=1024*1024

def sha(data):return hashlib.sha256(data).hexdigest()
def validate(data, expected_binary):
    if not isinstance(data,dict) or set(data)!=FIELDS:raise ValueError('Unexpected request fields')
    if data['protocol']!=PROTOCOL:raise ValueError('Research protocol required')
    if not isinstance(expected_binary,str) or not HEX.fullmatch(expected_binary) or data['binarySha256']!=expected_binary:raise ValueError('Pinned binary mismatch')
    if not isinstance(data['requestId'],str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,80}',data['requestId']):raise ValueError('Invalid request id')
    for name in ('manifestHash','parameterSha256'):
        if not isinstance(data[name],str) or not HEX.fullmatch(data[name]):raise ValueError('Invalid hash')
    r=data['range']
    if not isinstance(r,dict) or set(r)!=RANGE_FIELDS or any(type(x)is not int for x in r.values()):raise ValueError('Invalid range shape')
    s,n,t,m=(r[k] for k in ('sequence','sequenceCount','locktime','locktimeCount'))
    if not (2**31<=s<2**32 and 1<=n<=16 and s+n<=2**32 and 500000000<=t<2**32 and t%256==0 and m>0 and t+m<=2**32):raise ValueError('Invalid range bounds')
    b64=data['parameterBase64']
    if not isinstance(b64,str) or len(b64)>352:raise ValueError('Invalid parameter envelope')
    raw=base64.b64decode(b64,validate=True)
    if not 152<=len(raw)<=263 or sha(raw)!=data['parameterSha256']:raise ValueError('Parameter integrity failure')
    return raw

def result_records(stdout, text, r):
    expected=f"QSB_RANGE_DRAINED candidates={r['sequenceCount']*r['locktimeCount']}"
    markers=[line for line in stdout.splitlines() if 'QSB_RANGE_DRAINED' in line]
    if markers!=[expected] or 'QSB_RANGE_INCOMPLETE' in stdout:raise ValueError('Missing or inconsistent completion')
    hits=[];seen=set()
    for line in text.splitlines():
        match=HIT.fullmatch(line)
        if not match:raise ValueError('Malformed candidate')
        s,t,ri=map(int,match.groups())
        if not (r['sequence']<=s<r['sequence']+r['sequenceCount'] and r['locktime']<=t<r['locktime']+r['locktimeCount']):raise ValueError('Candidate outside range')
        key=(s,t,ri)
        if key in seen:raise ValueError('Duplicate candidate')
        seen.add(key);hits.append({'sequence':s,'locktime':t,'recid':ri})
    return hits

def run(data, binary, expected_binary, timeout=840):
    raw=validate(data,expected_binary);binary=Path(binary).resolve(strict=True)
    # expected_binary comes from the caller's enrolled artifact, not request data.
    if not binary.is_file() or sha(binary.read_bytes())!=expected_binary:raise ValueError('Installed binary mismatch')
    r=data['range'];status='failed';hits=[]
    with tempfile.TemporaryDirectory(prefix='qsb-public-pin-') as directory:
        cwd=Path(directory);(cwd/'params.bin').write_bytes(raw)
        command=[str(binary),'params.bin','0']+[str(r[k]) for k in ('sequence','sequenceCount','locktime','locktimeCount')]
        # Only non-secret runtime essentials; no inherited provider/wallet credentials.
        env={k:v for k,v in os.environ.items() if k in {'PATH','LD_LIBRARY_PATH','CUDA_VISIBLE_DEVICES'}}
        with (cwd/'compute.txt').open('w') as output:
            process=subprocess.Popen(command,cwd=cwd,env=env,stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
            try:process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid,signal.SIGTERM)
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid,signal.SIGKILL);process.wait()
                status='interrupted'
        if process.returncode==0 and status!='interrupted':
            log=cwd/'compute.txt';files=list((cwd/'results').glob('*')) if (cwd/'results').exists() else []
            if log.stat().st_size>MAX_OUTPUT or any(p.name!='pinning_hit_0.txt' or not p.is_file() or p.is_symlink() or p.stat().st_size>MAX_OUTPUT for p in files):raise ValueError('Invalid or excessive output')
            text=(files[0].read_text() if files else '')
            hits=result_records(log.read_text(),text,r);status='range-drained'
    return {'protocol':PROTOCOL,'requestId':data['requestId'],'manifestHash':data['manifestHash'],
            'binarySha256':expected_binary,'parameterSha256':data['parameterSha256'],'range':dict(r),
            'status':status,'candidates':hits,'verified':False,'rangeCreditEligible':False,
            'releaseStatus':'HOLD'}
