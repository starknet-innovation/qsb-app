"""Read-only candidate intake. Never invokes upstream setup, scripts or binaries."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / 'research/yukon-intake/20260924/upstream-lock.json'
LIMIT = 128 * 1024 * 1024


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fetch(commit):
    if not re.fullmatch('[a-f0-9]{40}', commit):
        raise ValueError('Invalid immutable commit')
    url = 'https://codeload.github.com/Layr-Labs/quantum-safe-bitcoin-challenge/tar.gz/' + commit
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('Archive too large')
    return data


def sources(data):
    result = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if path.is_absolute() or '..' in path.parts:
                raise ValueError('Unsafe archive path')
            parts = path.parts[1:]
            if not parts or parts[0] != 'candidates':
                continue
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError('Nonregular candidate member')
            total += member.size
            if total > LIMIT:
                raise ValueError('Expanded archive too large')
            name = '/'.join(parts[1:])
            if name in result:
                raise ValueError('Duplicate candidate member')
            result[name] = archive.extractfile(member).read()
    return result


def check_source_lock(files, lock):
    for name, expected in lock['sourceFiles'].items():
        p = PurePosixPath(name)
        if p.is_absolute() or '..' in p.parts or sha(files.get(name, b'')) != expected:
            raise ValueError('Active source differs: ' + name)


def function(source, name):
    # Only these small, reviewed scalar predicate bodies are compiled on the host.
    m = re.search(r'__device__\s+(?:__forceinline__\s+)?int\s+' + re.escape(name) + r'\(', source)
    if not m:
        raise ValueError('Predicate signature changed: ' + name)
    start = source.index('{', m.start())
    end, depth = start + 1, 1
    while depth:
        if end >= len(source):
            raise ValueError('Unclosed predicate')
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    body = source[m.start():end].replace('__device__', '').replace('__forceinline__', '')
    if any(token in body for token in ('#include', 'asm', 'system(', 'fopen(', 'subprocess')):
        raise ValueError('Unexpected predicate operation')
    return body


def predicate_probe(files):
    """Compile the actual locked pinning predicate; do not run any upstream file."""
    source = files['pinning/pinning.cu'].decode()
    names = ['gpu_is_valid_der', 'gpu_leading_zero_bits', 'gpu_bench_valid', 'gpu_bench_valid_words']
    code = '#include <stdint.h>\n#include <stdio.h>\n#define QSB_ZEROS_N 24\n'
    code += '\n'.join(function(source, n) for n in names)
    # One valid 32-byte DER+sighash representation and an all-zero benchmark hit.
    valid = bytes([0x30,29,2,12]) + b'\x11'*12 + bytes([2,13]) + b'\x22'*13 + b'\x01'
    vectors = [valid, bytes(32)]
    code += '\nint main(){uint8_t v[2][32]={' + ','.join('{' + ','.join(map(str,v)) + '}' for v in vectors) + '};'
    code += 'for(int j=0;j<2;j++){uint32_t w[8];for(int i=0;i<8;i++)w[i]=((uint32_t)v[j][4*i]<<24)|((uint32_t)v[j][4*i+1]<<16)|((uint32_t)v[j][4*i+2]<<8)|v[j][4*i+3];printf("%d %d %d\\n",gpu_is_valid_der(v[j],32),gpu_bench_valid(v[j]),gpu_bench_valid_words(w));}return 0;}'
    with tempfile.TemporaryDirectory(prefix='qsb-predicate-') as temp:
        path = Path(temp)
        (path/'probe.cpp').write_text(code)
        subprocess.run(['c++','-std=c++17','-O2',str(path/'probe.cpp'),'-o',str(path/'probe')],check=True,capture_output=True,timeout=60)
        output = subprocess.check_output([str(path/'probe')],text=True,timeout=10)
    observed = [list(map(int,line.split())) for line in output.splitlines()]
    if observed != [[1,0,0],[0,1,1]]:
        raise ValueError('Unexpected predicate result: ' + repr(observed))
    return {'kind':'actual-source-host-predicate','gpuExecution':False,'columns':['der','benchmarkBytes','benchmarkWords'],'validDer':observed[0],'zeroDigest':observed[1]}


def audit(files):
    pin = files['pinning/pinning.cu'].decode()
    math = files['pinning/GPUMath.h'].decode()
    # Snapshot-specific source facts, not a general C preprocessor or proof.
    expected = {
        'benchmarkPredicate': 'return gpu_leading_zero_bits(h) >= QSB_ZEROS_N;' in pin,
        'pinningOverflowClipped': 'if (count > 64) count = 64;' in pin,
        'c31DefaultEnabled': '#define QSB_C31 1' in pin,
        'shortCarryDefaultEnabled': '#define QSB_SHORT_CARRY 1' in math,
        'upstreamAcknowledgesLostHits': 'lost real hit' in math,
        'activePinningLoopMatchesOldAdapter': pin.count('for (uint32_t seq = SEQ_MIN + effective_id; ; seq += effective_total)') == 2,
    }
    if not all(expected.values()):
        raise ValueError('Snapshot audit expectation changed: ' + repr(expected))
    archived = [n for n,b in files.items() if n.startswith('pinning/research/') and n.endswith('.cu') and b'__device__ int gpu_bench_valid(' in b]
    return {**expected,'archivedCudaWithPredicate':len(archived)}


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--archive',type=Path,help='Optional predownloaded immutable archive')
    ap.add_argument('--out',type=Path,required=True)
    args=ap.parse_args()
    if args.out.exists():
        raise ValueError('Output must be new; preserve prior evidence')
    lock=json.loads(LOCK.read_text())
    data=args.archive.read_bytes() if args.archive else fetch(lock['commit'])
    if sha(data)!=lock['archiveSha256']:
        raise ValueError('Archive hash mismatch')
    files=sources(data)
    check_source_lock(files,lock)
    trees={t:sha(json.dumps({n[len(t)+1:]:sha(b) for n,b in files.items() if n.startswith(t+'/')},sort_keys=True,separators=(',',':')).encode()) for t in ['pinning','subset']}
    if trees!=lock['trackTrees']:
        raise ValueError('Candidate tree differs')
    # Independently bind current subset bytes to its actual promoted commit.
    subset_commit=lock['promotions']['subset']['commit']
    old=sources(fetch(subset_commit))
    if {n:b for n,b in files.items() if n.startswith('subset/')} != {n:b for n,b in old.items() if n.startswith('subset/')}:
        raise ValueError('Subset promotion lineage differs')
    result={'status':'HOLD','deploymentAllowed':False,'commit':lock['commit'],'archiveSha256':sha(data),'activeSourceFiles':len(lock['sourceFiles']),'subsetPromotionByteIdentity':True,'sourceAudit':audit(files),'predicateProbe':predicate_probe(files),'nativeGpu':'not-run','performance':'not-established','fullWithdrawal':'not-run'}
    args.out.mkdir(parents=True)
    # Stage only active compiler inputs; never stage research executables or setup.
    for name in lock['sourceFiles']:
        p=args.out/'source'/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(files[name])
    (args.out/'result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__':
    main()
