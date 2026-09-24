"""Offline, hash-pinned installation. No package downloads, credentials, service activation or cloud calls."""
import hashlib,json,os,re,shutil,stat,sys,tempfile
from pathlib import Path

def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()

def regular(p):
    if any(x.is_symlink() for x in [p,*p.parents]) or not p.is_file():
        raise ValueError('Non-regular installation input')

def verify(directory,expected,operational=False):
    regular(directory/'manifest.json')
    if not re.fullmatch('[a-f0-9]{64}',expected) or digest(directory/'manifest.json')!=expected:
        raise ValueError('Package manifest differs')
    manifest=json.loads((directory/'manifest.json').read_bytes())
    required='qsb-operational-distribution-v1' if operational else 'qsb-dispatch-package-v1'
    if manifest.get('format')!=required: raise ValueError('Package format differs')
    files=manifest['files']
    if not isinstance(files,dict) or not files: raise ValueError('Empty package')
    for name,entry in files.items():
        p=Path(name)
        if p.is_absolute() or '..' in p.parts or '.'==name or '\\' in name: raise ValueError('Unsafe package member')
        f=directory/p;regular(f)
        wanted=entry['sha256'] if operational else entry
        if digest(f)!=wanted: raise ValueError('Package member differs')
    actual={str(p.relative_to(directory)) for p in directory.rglob('*') if not p.is_dir()}
    if actual!=set(files)|{'manifest.json'}: raise ValueError('Unlisted package members')
    return manifest

def install(runtime,dispatcher,root,runtime_hash,dispatcher_hash):
    if sys.platform!='linux' or os.geteuid()!=0: raise ValueError('Owned Linux root installation required')
    root=root.resolve(strict=True)
    verify(runtime,runtime_hash,True);verify(dispatcher,dispatcher_hash)
    targets=[(runtime,root/'source'),(dispatcher,root/'opt/qsb/dispatcher'),(runtime/'repo',root/'repo')]
    for _,dst in targets:
        if dst.exists() or dst.is_symlink(): raise ValueError('Installation target already exists; reconcile before replacement')
        if any(p.is_symlink() for p in dst.parents):raise ValueError('Linked installation parent')
    # Stage every file and verify again before publishing the first directory.
    stage=Path(tempfile.mkdtemp(prefix='.qsb-install-',dir=root))
    try:
        shutil.copytree(runtime,stage/'source');shutil.copytree(dispatcher,stage/'dispatcher');shutil.copytree(runtime/'repo',stage/'repo')
        verify(stage/'source',runtime_hash,True);verify(stage/'dispatcher',dispatcher_hash)
        for p in stage.rglob('*'):
            if p.is_file():
                with p.open('rb') as f:os.fsync(f.fileno())
                p.chmod(0o444)
        for name,(_,dst) in zip(['source','dispatcher','repo'],targets):
            dst.parent.mkdir(parents=True,exist_ok=True);os.rename(stage/name,dst)
            for p in sorted(dst.rglob('*'),key=lambda p:len(p.parts),reverse=True):
                if p.is_dir():p.chmod(0o555)
            dst.chmod(0o555)
            fd=os.open(dst.parent,os.O_RDONLY)
            try:os.fsync(fd)
            finally:os.close(fd)
        receipt={'format':'qsb-runtime-install-v1','runtimeManifest':runtime_hash,'dispatcherManifest':dispatcher_hash,'executionEnabled':False}
        d=root/'etc/qsb';d.mkdir(parents=True,exist_ok=True)
        with (d/'installation.json').open('x') as f:json.dump(receipt,f);f.flush();os.fsync(f.fileno())
        (d/'installation.json').chmod(0o444)
        return receipt
    finally:
        # Failed publication never removes or overwrites an already installed directory.
        if stage.exists():
            for p in stage.rglob('*'):
                if p.is_dir():p.chmod(0o700)
            shutil.rmtree(stage)

if __name__=='__main__':
    try:
        if len(sys.argv)!=6:raise ValueError('Expected runtime, dispatcher, root, and two manifest digests')
        print(json.dumps(install(Path(sys.argv[1]),Path(sys.argv[2]),Path(sys.argv[3]),sys.argv[4],sys.argv[5])))
    except Exception:
        print('Installation rejected; reconcile any partially published paths before retry',file=sys.stderr);sys.exit(2)
