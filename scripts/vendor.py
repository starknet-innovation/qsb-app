"""Fetch immutable upstream sources, preserving licenses. Does not execute them."""
import hashlib
import json
import pathlib
import shutil
import tempfile
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCES = {
    'qsb': ('avihu28/Quantum-Safe-Bitcoin-Transactions', '2c9172051d5c150ef0a994ca6b988a08a3ef9e85'),
}
# Fetch only the generator and independent reference: never download CUDA archives.
FILES = (
    'LICENSE',
    'config_a/pipeline/bitcoin_tx.py',
    'config_a/pipeline/secp256k1.py',
    'config_a/pipeline/qsb_pipeline.py',
    'config_a/verify/verify_hit.py',
    'config_a/verify/gpu_emulator.py',
    'config_a/verify/ref_sighash.py',
    'config_a/verify/test_consensus_core.py',
)
for name, (repo, commit) in SOURCES.items():
    dest = ROOT / 'vendor' / name
    marker = json.dumps({'commit': commit, 'files': FILES}, sort_keys=True)
    if not (dest / '.scope').exists() or (dest / '.scope').read_text() != marker or any(not (dest / f).is_file() for f in FILES):
        dest.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=dest.parent) as temporary:
            staging = pathlib.Path(temporary) / name
            staging.mkdir()
            for filename in FILES:
                target = staging / filename
                target.parent.mkdir(parents=True, exist_ok=True)
                subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', '--max-time', '60',
                    f'https://raw.githubusercontent.com/{repo}/{commit}/{filename}', '--output', str(target)], check=True)
            (staging / '.commit').write_text(commit)
            (staging / '.scope').write_text(marker)
            if dest.exists():
                shutil.rmtree(dest)
            staging.rename(dest)

from patch_upstream import apply
apply(ROOT / 'vendor/qsb')
public = ROOT / 'public/qsb'
public.mkdir(parents=True, exist_ok=True)
manifest = {}
for filename in ('bitcoin_tx.py', 'secp256k1.py', 'qsb_pipeline.py'):
    source = ROOT / 'vendor/qsb/config_a/pipeline' / filename
    shutil.copyfile(source, public / filename)
    manifest[filename] = hashlib.sha256(source.read_bytes()).hexdigest()
shutil.copyfile(ROOT / 'vendor/qsb/LICENSE', public / 'LICENSE')
manifest['bridge.py'] = hashlib.sha256((public / 'bridge.py').read_bytes()).hexdigest()
(public / 'manifest.json').write_text(json.dumps(manifest, indent=2))
pyodide = ROOT / 'node_modules/pyodide'
if pyodide.exists():
    shutil.copytree(pyodide, ROOT / 'public/pyodide', dirs_exist_ok=True, ignore=shutil.ignore_patterns('node_modules', '*.d.ts', '*.map'))
print('Pinned QSB generator and local Python runtime prepared; CUDA is owned by qsb-solver.')

cpu = ROOT / 'worker/cpu'
for filename in ('bitcoin_tx.py', 'secp256k1.py', 'qsb_pipeline.py'):
    shutil.copyfile(public / filename, cpu / filename)
for filename in ('verify_hit.py', 'gpu_emulator.py'):
    shutil.copyfile(ROOT / 'vendor/qsb/config_a/verify' / filename, cpu / filename)
shutil.copyfile(ROOT / 'vendor/qsb/LICENSE', cpu / 'LICENSE')
