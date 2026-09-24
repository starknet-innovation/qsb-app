"""Local integrity and wire-contract checks, not remote hardware attestation."""
import hashlib,json,pathlib

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def load_release(root):
    root=pathlib.Path(root)
    raw=(root/'release.json').read_bytes();d=json.loads(raw)
    if d['purpose']!='isolated-subset-validation-only' or d['status']!='HOLD':raise ValueError('Unexpected release scope')
    for name,want in d['files'].items():
        p=root/name
        if pathlib.Path(name).name!=name or p.is_symlink() or digest(p)!=want:raise ValueError('Installed artifact mismatch: '+name)
    return d,hashlib.sha256(raw).hexdigest()
def check_request(data,root):
    d,h=load_release(root)
    if data.get('solverReleaseHash')!=h or data.get('solverId')!=d['id']:raise ValueError('Solver release mismatch')
    if data.get('stage') not in ('round1','round2'):raise ValueError('Subset-only release')
    if data.get('kernelCommit')!=d['baseKernelCommit'] or data.get('searchVersion')!=d['searchVersion']:raise ValueError('Solver lineage/range mismatch')
    return d,h
def check_response(output,request,root,expected_range):
    d,h=check_request(request,root)
    for key in ['stage','manifestHash','attempt']:
        if output.get(key)!=request.get(key):raise ValueError('Response request binding mismatch')
    if output.get('solverId')!=d['id'] or output.get('solverReleaseHash')!=h or output.get('binarySha256')!=d['files']['subset']:raise ValueError('Response solver mismatch')
    if output.get('kernelCommit')!=d['baseKernelCommit'] or output.get('workRange')!=expected_range:raise ValueError('Response range/lineage mismatch')
    if output.get('status')!='completed' or output.get('checkpoint')!='range-complete':raise ValueError('Incomplete range')
    candidates=output.get('candidates')
    if not isinstance(candidates,list) or len(candidates)>32 or any(not isinstance(x,str) or len(x.encode())>=16384 for x in candidates):raise ValueError('Invalid candidate envelope')
    # The caller must still CPU-verify every candidate before crediting or signing.
    return candidates
