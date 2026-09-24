"""Fresh-process public CPU reference binding; never grants durable range credit."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import types
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

def handoff(context,candidate):
    """Reverify the pin and derive both round parameters; no launch authorization."""
    if not isinstance(context,dict) or set(context)!={'publicStateJson','manifest'}:raise ValueError('Unexpected context')
    if not isinstance(candidate,dict) or set(candidate)!={'sequence','locktime'} or any(type(v) is not int for v in candidate.values()):raise ValueError('Invalid pin')
    if not 2**31<=candidate['sequence']<2**32 or not 500000000<=candidate['locktime']<=REFERENCE_LOCKTIME_MAX:raise ValueError('Unsupported pin')
    fields=f"sequence={candidate['sequence']}\nlocktime={candidate['locktime']}\n"
    event={**context,**candidate}
    verdict=reference({**event,'action':'verify','stage':'pinning','candidates':[fields]})
    if verdict!={'valid':True,**candidate}:raise ValueError('Pin not reproduced')
    parameters={stage:reference({**event,'action':'export','stage':stage}) for stage in ('round1','round2')}
    return {'format':'qsb-research-pin-handoff-v1','contextHash':fingerprint(context),
      'pin':candidate,'parameters':parameters,'referenceChecked':True,
      'dispatchAuthorized':False,'consensusVerified':False,'releaseStatus':'HOLD'}

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

STATE_FIELDS={'config','hash_mode','n','t1s','t1b','t2s','t2b','hors_commitments','dummy_sigs','pin_r','pin_s','pin_sig','round_sigs','full_script_hex'}
def validate_public_state(s):
    # Called only after the fresh child loads the six exact hash-checked modules.
    from bitcoin_tx import QSBScriptBuilder
    from secp256k1 import encode_der_sig, is_recoverable_der_sig, N
    if not isinstance(s,dict) or set(s)!=STATE_FIELDS: raise ValueError('Exact public fields required')
    if any(type(s[k]) is not int for k in ('n','t1s','t1b','t2s','t2b')): raise ValueError('Invalid geometry types')
    if tuple(s[k] for k in ('config','hash_mode','n','t1s','t1b','t2s','t2b'))!=('A','sha256',150,8,1,7,2): raise ValueError('Unsupported configuration')
    def binary(v,size=None):
        if not isinstance(v,str) or len(v)%2 or any(c not in '0123456789abcdefABCDEF' for c in v): raise ValueError('Invalid public hex')
        b=bytes.fromhex(v)
        if size is not None and len(b)!=size: raise ValueError('Invalid public length')
        return b
    def matrix(v,size):
        if not isinstance(v,list) or len(v)!=2 or any(not isinstance(r,list) or len(r)!=150 for r in v): raise ValueError('Invalid public array')
        return [[binary(x,size) for x in r] for r in v]
    builder=QSBScriptBuilder(150,8,1,7,2,hash_mode='sha256')
    builder.hors_commitments=matrix(s['hors_commitments'],20)
    builder.dummy_sigs=matrix(s['dummy_sigs'],9)
    for row in builder.dummy_sigs:
        if len(set(row))!=150: raise ValueError('Duplicate dummy signature')
        for raw in row:
            if not (raw[:4]==bytes.fromhex('30060201') and raw[5:7]==bytes.fromhex('0201') and 1<=raw[4]<=127 and 1<=raw[7]<=127 and raw[8]==3 and is_recoverable_der_sig(raw)): raise ValueError('Invalid dummy signature')
    def signature(r,t,encoded):
        if type(r) is not int or type(t) is not int or not 0<r<N or not 0<t<N: raise ValueError('Invalid public signature scalars')
        raw=binary(encoded)
        if raw!=encode_der_sig(r,t,sighash=1) or not is_recoverable_der_sig(raw): raise ValueError('Scalar/signature mismatch')
        return raw
    pin=signature(s['pin_r'],s['pin_s'],s['pin_sig'])
    if not isinstance(s['round_sigs'],list) or len(s['round_sigs'])!=2 or any(not isinstance(r,dict) or set(r)!={'r','s','sig'} for r in s['round_sigs']): raise ValueError('Invalid round signatures')
    rounds=[signature(r['r'],r['s'],r['sig']) for r in s['round_sigs']]
    script=builder.build_full_script(pin,*rounds)
    if script!=binary(s['full_script_hex']) or len(script)>10000 or builder.count_opcodes_runtime(script)[0]>201: raise ValueError('Public script reconstruction mismatch')
    return {'scriptHash':hashlib.sha256(script).hexdigest(),'scriptBytes':len(script),'privateFieldsAccepted':False,'consensusVerified':False}

if __name__=='__main__':
    if sys.argv[1:]!=['child']:raise SystemExit('child only')
    order=('secp256k1.py','bitcoin_tx.py','gpu_emulator.py','qsb_pipeline.py','verify_hit.py','handler.py')
    locked=json.loads(LOCK.read_text())
    if set(locked)!=set(order):raise ValueError('Unexpected CPU source set')
    verified={}
    for name in order:
        p=ROOT/'worker/cpu'/name
        source=p.read_bytes()
        if p.is_symlink() or hashlib.sha256(source).hexdigest()!=locked[name]:raise ValueError('Pinned CPU source mismatch')
        if name[:-3] in sys.modules:raise ValueError('Fresh CPU interpreter required')
        verified[name]=source
    # Compile exactly the bytes just hashed, never import-loader bytecode caches.
    for name in order:
        module=types.ModuleType(name[:-3]);module.__file__=str(ROOT/'worker/cpu'/name)
        sys.modules[name[:-3]]=module
        exec(compile(verified[name],module.__file__,'exec'),module.__dict__)
    handler=sys.modules['handler']
    raw=sys.stdin.read(2000001)
    if len(raw)>2000000:raise ValueError('Context too large')
    event=json.loads(raw)
    state_raw=event.get('publicStateJson') if isinstance(event,dict) else None
    if not isinstance(state_raw,str) or len(state_raw.encode())>500000:raise ValueError('Invalid public state envelope')
    validate_public_state(json.loads(state_raw))
    print(json.dumps(handler.handler(event)))
