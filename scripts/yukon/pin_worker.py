"""One public request per process; image enrollment and provider transport are separate gates."""
import hashlib
import json
from pathlib import Path
import sys
import types

ROOT=Path(__file__).resolve().parents[2]

def main():
    manifest=json.loads((ROOT/'runtime-manifest.json').read_text())
    if manifest.get('format')!='qsb-yukon-pin-runtime-v1' or manifest.get('releaseStatus')!='HOLD' or manifest.get('dispatchAuthorized') is not False:raise ValueError('Research runtime required')
    expected={'bin/pinning','scripts/yukon/pin_worker.py','scripts/yukon/pin_runtime.py','scripts/yukon/pin_reference.py','scripts/yukon/pin_reference_lock.json'}
    expected.update('worker/cpu/'+n for n in ('secp256k1.py','bitcoin_tx.py','gpu_emulator.py','qsb_pipeline.py','verify_hit.py','handler.py'))
    if set(manifest['files'])!=expected:raise ValueError('Unexpected runtime closure')
    sources={}
    for name,digest in manifest['files'].items():
        path=ROOT/name;raw=path.read_bytes()
        if path.is_symlink() or hashlib.sha256(raw).hexdigest()!=digest:raise ValueError('Runtime artifact mismatch')
        if name in ('scripts/yukon/pin_runtime.py','scripts/yukon/pin_reference.py'):sources[name]=raw
    for name,raw in sources.items():
        module_name=Path(name).stem;module=types.ModuleType(module_name);module.__file__=str(ROOT/name)
        if module_name in sys.modules:raise ValueError('Fresh worker process required')
        sys.modules[module_name]=module;exec(compile(raw,module.__file__,'exec'),module.__dict__)
    raw=sys.stdin.buffer.read(2000001)
    if len(raw)>2000000:raise ValueError('Oversized public request')
    event=json.loads(raw)
    if not isinstance(event,dict):raise ValueError('Invalid envelope')
    runtime=sys.modules['pin_runtime'];reference=sys.modules['pin_reference'];binary=manifest['files']['bin/pinning']
    if set(event)=={'action','request'} and event['action']=='compute':
        result=runtime.run(event['request'],ROOT/'bin/pinning',binary)
    elif set(event)=={'action','request','output','context'} and event['action']=='verify':
        result=reference.verify(event['request'],event['output'],event['context'],binary)
    elif set(event)=={'action','context','candidate'} and event['action']=='handoff':
        result=reference.handoff(event['context'],event['candidate'])
    else:raise ValueError('Unsupported public action')
    print(json.dumps(result,separators=(',',':')))

if __name__=='__main__':
    try:main()
    except Exception:
        print('Pinning research runtime rejected request',file=sys.stderr)
        raise SystemExit(2)
