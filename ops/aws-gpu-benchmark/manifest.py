"""Fetch an immutable solver closure and record the clean benchmark consumer."""
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
LIMIT = 32 * 1024 * 1024


def verified_files(archive, pin):
    if pin['repository'] != 'starknet-innovation/qsb-solver' or not re.fullmatch('[0-9a-f]{40}', pin['commit']):
        raise ValueError('Invalid solver provenance')
    if len(archive) > LIMIT or hashlib.sha256(archive).hexdigest() != pin['archiveSha256']:
        raise ValueError('Solver archive hash mismatch')
    prefix = 'qsb-solver-' + pin['commit'] + '/'
    files = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as source:
        for member in source:
            name = member.name.removeprefix(prefix)
            if not (name.startswith('research/optimized-subset/subset/') or name == 'worker/optimized/source-lock.json'):
                continue
            if member.isdir():
                continue
            if not member.name.startswith(prefix) or not member.isfile() or name in files or '..' in pathlib.PurePosixPath(name).parts:
                raise ValueError('Unsafe or duplicate solver source')
            if name not in pin['files'] or member.size > LIMIT:
                raise ValueError('Unexpected solver source')
            data = source.extractfile(member).read(LIMIT + 1)
            if hashlib.sha256(data).hexdigest() != pin['files'][name]:
                raise ValueError('Solver source hash mismatch: ' + name)
            files[name] = data
    if set(files) != set(pin['files']):
        raise ValueError('Incomplete solver source closure')
    return files


def generate():
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT):
        raise RuntimeError('Benchmark manifest requires a clean checkout')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    pin_bytes = (HERE/'solver-source.json').read_bytes()
    pin = json.loads(pin_bytes)
    url = f'https://codeload.github.com/{pin["repository"]}/tar.gz/{pin["commit"]}'
    with urllib.request.urlopen(url, timeout=60) as response:
        files = verified_files(response.read(LIMIT + 1), pin)
    destination = HERE/'.build/solver'
    if destination.exists():
        raise ValueError('Solver staging already exists; use a fresh build directory')
    for name, data in files.items():
        output = destination/name
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
    subset = {n.removeprefix('research/optimized-subset/'): hashlib.sha256(data).hexdigest()
              for n, data in files.items() if n.startswith('research/optimized-subset/subset/')}
    lock_bytes = files['worker/optimized/source-lock.json']
    lock = json.loads(lock_bytes)
    deviations = {name: {'historical': lock['files'].get(name), 'benchmark': subset.get(name)}
                  for name in sorted(set(subset) | set(lock['files']))
                  if subset.get(name) != lock['files'].get(name)}
    return {'status': 'BENCHMARK_ONLY', 'sourceCommit': commit, 'solverRepository': pin['repository'],
            'solverCommit': pin['commit'], 'solverArchiveSha256': pin['archiveSha256'],
            'solverPinSha256': hashlib.sha256(pin_bytes).hexdigest(), 'files': subset,
            'historicalLockSha256': hashlib.sha256(lock_bytes).hexdigest(),
            'historicalDeviations': deviations}


if __name__ == '__main__':
    output = pathlib.Path(sys.argv[1])
    manifest = generate()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
