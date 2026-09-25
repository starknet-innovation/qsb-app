"""Compile an isolated architecture-specific benchmark; never enroll a release."""
import hashlib,json,pathlib,subprocess,sys
ROOT=pathlib.Path('/src');OUT=pathlib.Path('/opt/qsb-benchmark');STAGED=ROOT/'ops/aws-gpu-benchmark/.build/solver';SRC=STAGED/'research/optimized-subset'
lock=json.loads((STAGED/'worker/optimized/source-lock.json').read_text())
manifest_path=ROOT/'ops/aws-gpu-benchmark/.build/source-manifest.json'
manifest=json.loads(manifest_path.read_text())
pin_path=ROOT/'ops/aws-gpu-benchmark/solver-source.json'
pin=json.loads(pin_path.read_text())
assert hashlib.sha256(pin_path.read_bytes()).hexdigest()==manifest['solverPinSha256']
assert pin['commit']==manifest['solverCommit'] and pin['repository']==manifest['solverRepository']
assert pin['archiveSha256']==manifest['solverArchiveSha256']
assert {str(p.relative_to(STAGED)) for p in STAGED.rglob('*') if p.is_file()}==set(pin['files'])
for name,want in pin['files'].items():
    path=STAGED/name
    assert not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==want,name
assert hashlib.sha256((STAGED/'worker/optimized/source-lock.json').read_bytes()).hexdigest()==manifest['historicalLockSha256']
actual={str(p.relative_to(SRC)) for p in (SRC/'subset').rglob('*') if p.is_file()}
assert actual==set(manifest['files'])
for n,want in manifest['files'].items():
    p=SRC/n
    assert not p.is_symlink() and hashlib.sha256(p.read_bytes()).hexdigest()==want,n
arch=sys.argv[1]
assert arch in ('86','89')
flags=[f'-arch=sm_{arch}' if f.startswith('-arch=') else f for f in lock['flags']]
OUT.mkdir();binaries={}
for name,source in [('subset','subset/subset.cu'),('first-stage-audit','subset/tests/gpu_epochs/first_stage_audit.cu')]:
    subprocess.run(['nvcc',*flags,'-o',str(OUT/name),str(SRC/source),'-lcrypto','-lm'],check=True)
    binaries[name]=hashlib.sha256((OUT/name).read_bytes()).hexdigest()
(OUT/'build-receipt.json').write_text(json.dumps({'status':'BENCHMARK_ONLY','sourceCommit':manifest['sourceCommit'],'solverRepository':manifest['solverRepository'],'solverCommit':manifest['solverCommit'],'solverArchiveSha256':manifest['solverArchiveSha256'],'sourceManifestSha256':hashlib.sha256(manifest_path.read_bytes()).hexdigest(),'historicalDeviations':manifest['historicalDeviations'],'architecture':'sm_'+arch,'flags':flags,'sourceLockSha256':hashlib.sha256((STAGED/'worker/optimized/source-lock.json').read_bytes()).hexdigest(),'binarySha256':binaries,'compiler':subprocess.check_output(['nvcc','--version'],text=True)},indent=2)+'\n')
