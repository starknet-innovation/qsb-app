"""Fetch immutable upstream sources, preserving licenses. Does not execute them."""
import hashlib
import io
import json
import pathlib
import shutil
import tarfile
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCES = {
    'qsb': ('avihu28/Quantum-Safe-Bitcoin-Transactions', '2c9172051d5c150ef0a994ca6b988a08a3ef9e85'),
    'challenge': ('Layr-Labs/quantum-safe-bitcoin-challenge', '2791ed0588f5014ccd688d48ba5502df2879f2f1'),
}
for name, (repo, commit) in SOURCES.items():
    dest = ROOT / 'vendor' / name
    if not (dest / '.commit').exists() or (dest / '.commit').read_text() != commit:
        data = subprocess.check_output(['curl', '--fail', '--silent', '--show-error', '--location', '--max-time', '60', f'https://codeload.github.com/{repo}/tar.gz/{commit}'])
        dest.mkdir(parents=True, exist_ok=True)
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            for entry in archive.getmembers():
                parts = pathlib.PurePosixPath(entry.name).parts[1:]
                if not parts or '..' in parts or not entry.isfile():
                    continue
                # Upstream archives may contain bytecode. It is not reviewed source.
                if '__pycache__' in parts or parts[-1].endswith('.pyc'):
                    continue
                target = dest.joinpath(*parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(entry).read())
        (dest / '.commit').write_text(commit)

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
print('Pinned QSB, challenge sources and local Python runtime prepared.')

cpu = ROOT / 'worker/cpu'
for filename in ('bitcoin_tx.py', 'secp256k1.py', 'qsb_pipeline.py'):
    shutil.copyfile(public / filename, cpu / filename)
for filename in ('verify_hit.py', 'gpu_emulator.py'):
    shutil.copyfile(ROOT / 'vendor/qsb/config_a/verify' / filename, cpu / filename)
shutil.copyfile(ROOT / 'vendor/qsb/LICENSE', cpu / 'LICENSE')
