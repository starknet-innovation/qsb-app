"""Package only the already-tested frozen binary and public source closure."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
FROZEN_BINARY='88cf46c45a63972e31af5f1c835a3b4088d6ea76af4b69e7bb0d7227d1562263'
BASE='nvidia/cuda:12.8.1-runtime-ubuntu22.04@sha256:fcbbd60a5ad3db3a1c7375bf14546b369b54064c513224310b2026df50c7a9bd'

def package(binary,out):
    binary_bytes=binary.read_bytes()
    if binary.is_symlink() or hashlib.sha256(binary_bytes).hexdigest()!=FROZEN_BINARY:raise ValueError('Only the frozen tested binary may be packaged')
    if out.exists():raise ValueError('Do not overwrite a package')
    lock=json.loads((ROOT/'scripts/yukon/pin_reference_lock.json').read_text())
    files=['scripts/yukon/'+n for n in ('pin_worker.py','pin_runtime.py','pin_reference.py','pin_reference_lock.json')]+['worker/cpu/'+n for n in lock]
    # Validate before creating any output; no arbitrary directory copy or runtime config.
    snapshots={}
    for name in files:
        p=ROOT/name;raw=p.read_bytes()
        if p.is_symlink():raise ValueError('Symlinked runtime source')
        if name.startswith('worker/cpu/') and hashlib.sha256(raw).hexdigest()!=lock[Path(name).name]:raise ValueError('CPU reference source mismatch')
        snapshots[name]=raw
    snapshots['bin/pinning']=binary_bytes
    out.mkdir(parents=True)
    for name,raw in snapshots.items():
        p=out/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
    (out/'bin/pinning').chmod(0o755)
    manifest={'format':'qsb-yukon-pin-runtime-v1','protocol':'qsb-yukon-pinning-research-v1','releaseStatus':'HOLD','dispatchAuthorized':False,'imageManifestDigest':None,'files':{name:hashlib.sha256(raw).hexdigest() for name,raw in sorted(snapshots.items())}}
    (out/'runtime-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    (out/'Dockerfile').write_text('FROM '+BASE+' AS runtime\nRUN apt-get update && apt-get install -y --no-install-recommends python3 libssl3 && rm -rf /var/lib/apt/lists/*\nCOPY bin /opt/qsb/bin\nCOPY scripts /opt/qsb/scripts\nCOPY worker /opt/qsb/worker\nCOPY runtime-manifest.json /opt/qsb/runtime-manifest.json\nWORKDIR /opt/qsb\nENV PYTHONDONTWRITEBYTECODE=1\nENTRYPOINT ["python3", "/opt/qsb/scripts/yukon/pin_worker.py"]\n')
    # Queue is a separate image target and closure; it cannot enroll itself.
    for name,source in [('pin_queue.py',ROOT/'scripts/yukon/pin_queue.py'),('requirements.lock',ROOT/'worker/optimized/requirements.lock')]:
        if source.is_symlink():raise ValueError('Symlinked queue input')
        (out/name).write_bytes(source.read_bytes())
    queue={'format':'qsb-yukon-pin-queue-v1','dispatchAuthorized':False,'files':{name:hashlib.sha256((out/name).read_bytes()).hexdigest() for name in ('pin_queue.py','requirements.lock','runtime-manifest.json')}}
    (out/'queue-binding.json').write_text(json.dumps(queue,indent=2)+'\n')
    with (out/'Dockerfile').open('a') as f:
        f.write('FROM runtime AS queue\nRUN apt-get update && apt-get install -y --no-install-recommends python3-venv && rm -rf /var/lib/apt/lists/*\nCOPY requirements.lock /opt/qsb/requirements.lock\nRUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir --require-hashes --only-binary=:all: -r /opt/qsb/requirements.lock && /opt/venv/bin/pip check\nCOPY pin_queue.py queue-binding.json /opt/qsb/\nENTRYPOINT ["/opt/venv/bin/python", "-u", "/opt/qsb/pin_queue.py"]\n')
    return manifest

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--binary',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();package(a.binary,a.out)
