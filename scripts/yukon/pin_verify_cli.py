"""One-request public CPU bridge. No provider access, GPU invocation or durable writes."""
import hashlib
import json
from pathlib import Path
import sys
import types

HERE=Path(__file__).resolve().parent

def main():
    lock=json.loads((HERE/'pin_verifier_lock.json').read_text())
    sources={}
    for name in ('pin_runtime.py','pin_reference.py','pin_reference_lock.json'):
        path=HERE/name;raw=path.read_bytes()
        if path.is_symlink() or hashlib.sha256(raw).hexdigest()!=lock[name]:raise ValueError('Verifier artifact mismatch')
        sources[name]=raw
    for name in ('pin_runtime.py','pin_reference.py'):
        module=types.ModuleType(name[:-3]);module.__file__=str(HERE/name)
        sys.modules[name[:-3]]=module
        exec(compile(sources[name],module.__file__,'exec'),module.__dict__)
    raw=sys.stdin.buffer.read(2000001)
    if len(raw)>2000000:raise ValueError('Oversized public verification')
    event=json.loads(raw)
    if not isinstance(event,dict):raise ValueError('Public verification envelope required')
    reference=sys.modules['pin_reference']
    if set(event)=={'action','request','output','context','expectedBinary'} and event['action']=='verify':
        verdict=reference.verify(event['request'],event['output'],event['context'],event['expectedBinary'])
    elif set(event)=={'action','context','candidate'} and event['action']=='handoff':
        verdict=reference.handoff(event['context'],event['candidate'])
    else:raise ValueError('Exact public verification envelope required')
    print(json.dumps(verdict,separators=(',',':')))

if __name__=='__main__':
    try:main()
    except Exception:
        # Do not echo user data or inherited configuration on failure.
        print('Public CPU verification failed',file=sys.stderr)
        raise SystemExit(2)
