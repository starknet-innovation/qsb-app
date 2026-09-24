"""Fresh-process public CPU reference binding; never grants durable range credit."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[2]
LOCK=Path(__file__).with_name('pin_reference_lock.json')

def fingerprint(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()

def reference(event):
    # Each export/verify gets its own interpreter: the upstream handler changes cwd.
    env={k:v for k,v in os.environ.items() if k in {'PATH','SYSTEMROOT'}}
    r=subprocess.run([sys.executable,'-I',str(Path(__file__).resolve()),'child'],input=json.dumps(event),capture_output=True,text=True,timeout=60,env=env)
    if r.returncode:raise ValueError('Public CPU reference rejected request')
    return json.loads(r.stdout)

# Inclusive bound in the hash-pinned application's verify_hit dispatch.
REFERENCE_LOCKTIME_MAX=1744600000

def prepare(request,context,expected_binary):
    """Bind public context before compute; reject unsupported verifier geometry."""
    from pin_runtime import validate
    validate(request,expected_binary)
    if not isinstance(context,dict) or set(context)!={'publicStateJson','manifest'}:raise ValueError('Unexpected public context')
    if fingerprint(context['manifest'])!=request['manifestHash']:raise ValueError('Manifest identity mismatch')
    r=request['range']
    if r['locktime']+r['locktimeCount']-1>REFERENCE_LOCKTIME_MAX:
        raise ValueError('Range exceeds pinned CPU verifier locktime domain')
    exported=reference({**context,'stage':'pinning','action':'export'})
    if any(exported[k]!=request[k] for k in ('parameterBase64','parameterSha256')):
        raise ValueError('Parameters differ from full transaction reference')
    return {'contextHash':fingerprint(context),'rangeCreditEligible':False,'releaseStatus':'HOLD'}

def execute(request,context,binary,expected_binary,timeout=840):
    """Isolated prepare/compute/verify handoff; no provider or durable writes."""
    from pin_runtime import run
    # Snapshot caller-owned data so preflight and verification bind identical bytes.
    request,context=json.loads(json.dumps([request,context],allow_nan=False))
    prepare(request,context,expected_binary)
    output=run(request,binary,expected_binary,timeout=timeout)
    verdict=verify(request,output,context,expected_binary) if output['status']=='range-drained' else None
    return {'output':output,'reference':verdict,'rangeCreditEligible':False,'releaseStatus':'HOLD'}

def verify(request,output,context,expected_binary):
    from pin_runtime import result_records
    prepare(request,context,expected_binary)
    expected_keys={'protocol','requestId','manifestHash','binarySha256','parameterSha256','range','status','candidates','verified','rangeCreditEligible','releaseStatus'}
    if not isinstance(output,dict) or set(output)!=expected_keys:raise ValueError('Unexpected result envelope')
    for k in ('protocol','requestId','manifestHash','binarySha256','parameterSha256','range'):
        if type(output[k])!=type(request[k]) or output[k]!=request[k]:raise ValueError('Result binding mismatch')
    if output['status']!='range-drained' or output['verified'] is not False or output['rangeCreditEligible'] is not False or output['releaseStatus']!='HOLD':raise ValueError('Incomplete or untrusted result')
    event={**context,'stage':'pinning'}
    records=output['candidates']
    if not isinstance(records,list) or len(records)>4096:raise ValueError('Invalid candidate count')
    lines=[]
    for c in records:
        if not isinstance(c,dict) or set(c)!={'sequence','locktime','recid'} or any(type(v)is not int for v in c.values()):raise ValueError('Invalid candidate shape')
        lines.append(f"sequence={c['sequence']} locktime={c['locktime']} recid={c['recid']}")
    r=request['range']
    result_records(f"QSB_RANGE_DRAINED candidates={r['sequenceCount']*r['locktimeCount']}",'\n'.join(lines),r)
    verdicts=[]
    for c in records:
        # Existing CPU parser requires newline-delimited fields, not GPU one-line format.
        candidate=f"sequence={c['sequence']}\nlocktime={c['locktime']}\nrecid={c['recid']}\n"
        v=reference({**event,'action':'verify','candidates':[candidate]})
        if v.get('valid') is True:
            if v.get('sequence')!=c['sequence'] or v.get('locktime')!=c['locktime']:raise ValueError('Reference candidate identity mismatch')
        elif v!={'valid':False,'derOnly':True}:raise ValueError('Candidate not reproduced by CPU')
        verdicts.append(v)
    return {'referenceChecked':True,'contextHash':fingerprint(context),'verdicts':verdicts,
            'decision':'candidate-verified' if any(v.get('valid') for v in verdicts) else 'range-drained-reference-bound',
            'rangeCreditEligible':False,'releaseStatus':'HOLD','freshWithdrawal':False}

if __name__=='__main__':
    if sys.argv[1:]!=['child']:raise SystemExit('child only')
    for name,want in json.loads(LOCK.read_text()).items():
        p=ROOT/'worker/cpu'/name
        if p.is_symlink() or hashlib.sha256(p.read_bytes()).hexdigest()!=want:raise ValueError('Pinned CPU source mismatch')
    sys.path.insert(0,str(ROOT/'worker/cpu'))
    import handler
    raw=sys.stdin.read(2000001)
    if len(raw)>2000000:raise ValueError('Context too large')
    print(json.dumps(handler.handler(json.loads(raw))))
