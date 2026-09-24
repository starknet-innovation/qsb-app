"""Public-only script reconstruction using the unchanged local reference builder."""
import hashlib, pathlib, sys, types
REFERENCE=pathlib.Path('/opt/qsb-validation/reference')
EXPECTED={'bitcoin_tx.py':'c7e52af90bd0d9fce9834fce26dcd67aee0d7751ee228d9730873c4d12659a5c','secp256k1.py':'d2cebd1410b75cad606806cf02d7bee3e24724d5fcb7a53a07f598fcbc8afece'}
verified={}
for name,digest in EXPECTED.items():
    file=REFERENCE/name
    source=file.read_bytes()
    if file.is_symlink() or hashlib.sha256(source).hexdigest()!=digest: raise ValueError('Reference source differs')
    if name[:-3] in sys.modules: raise ValueError('Fresh isolated reference interpreter required')
    verified[name]=source
# Execute precisely the bytes that were hashed, never import-loader bytecode caches.
loaded=[]
try:
    for name in ('secp256k1.py','bitcoin_tx.py'):
        module=types.ModuleType(name[:-3]);module.__file__=str(REFERENCE/name)
        sys.modules[name[:-3]]=module;loaded.append(name[:-3])
        exec(compile(verified[name],module.__file__,'exec'),module.__dict__)
except BaseException:
    for name in loaded:sys.modules.pop(name,None)
    raise
from bitcoin_tx import QSBScriptBuilder
from secp256k1 import encode_der_sig, is_recoverable_der_sig, N
FIELDS={'config','hash_mode','n','t1s','t1b','t2s','t2b','hors_commitments','dummy_sigs','pin_r','pin_s','pin_sig','round_sigs','full_script_hex'}
def validate_public_state(s):
    if not isinstance(s,dict) or set(s)!=FIELDS: raise ValueError('Exact public fields required')
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
