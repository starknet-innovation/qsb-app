"""Record benchmark source from a clean checkout, without changing release locks."""
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = pathlib.Path('research/optimized-subset')

def generate():
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT):
        raise RuntimeError('Benchmark manifest requires a clean checkout')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    names = subprocess.check_output(['git', 'ls-files', '-z', str(SOURCE / 'subset')], cwd=ROOT).decode().split('\0')
    files = {}
    for name in filter(None, names):
        p = ROOT / name
        if p.is_symlink():
            raise RuntimeError(f'Symlink source: {name}')
        files[str(p.relative_to(ROOT / SOURCE))] = hashlib.sha256(p.read_bytes()).hexdigest()
    lock_path = ROOT / 'worker/optimized/source-lock.json'
    lock = json.loads(lock_path.read_text())
    deviations = {name: {'historical': lock['files'].get(name), 'benchmark': files.get(name)}
                  for name in sorted(set(files) | set(lock['files']))
                  if files.get(name) != lock['files'].get(name)}
    return {'status': 'BENCHMARK_ONLY', 'sourceCommit': commit, 'files': files,
            'historicalLockSha256': hashlib.sha256(lock_path.read_bytes()).hexdigest(),
            'historicalDeviations': deviations}

if __name__ == '__main__':
    output = pathlib.Path(sys.argv[1])
    manifest = generate()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
