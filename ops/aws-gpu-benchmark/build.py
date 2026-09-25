"""Compile an isolated architecture-specific benchmark; never enroll a release."""
import hashlib,json,pathlib,subprocess,sys
ROOT=pathlib.Path('/src');OUT=pathlib.Path('/opt/qsb-benchmark');SRC=ROOT/'research/optimized-subset'
lock=json.loads((ROOT/'worker/optimized/source-lock.json').read_text())
actual={str(p.relative_to(SRC)) for p in (SRC/'subset').rglob('*') if p.is_file()}
assert actual==set(lock['files'])
for n,want in lock['files'].items():
    p=SRC/n
    assert not p.is_symlink() and hashlib.sha256(p.read_bytes()).hexdigest()==want,n
arch=sys.argv[1]
assert arch in ('86','89')
flags=[f'-arch=sm_{arch}' if f.startswith('-arch=') else f for f in lock['flags']]
OUT.mkdir();binaries={}
for name,source in [('subset','subset/subset.cu'),('first-stage-audit','subset/tests/gpu_epochs/first_stage_audit.cu')]:
    subprocess.run(['nvcc',*flags,'-o',str(OUT/name),str(SRC/source),'-lcrypto','-lm'],check=True)
    binaries[name]=hashlib.sha256((OUT/name).read_bytes()).hexdigest()
(OUT/'build-receipt.json').write_text(json.dumps({'status':'BENCHMARK_ONLY','architecture':'sm_'+arch,'flags':flags,'sourceLockSha256':hashlib.sha256((ROOT/'worker/optimized/source-lock.json').read_bytes()).hexdigest(),'binarySha256':binaries,'compiler':subprocess.check_output(['nvcc','--version'],text=True)},indent=2)+'\n')
