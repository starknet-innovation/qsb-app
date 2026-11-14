"""Check every emitted native hit with the pinned upstream native curve backend."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('audit', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    upstream = args.upstream.resolve()
    commit = subprocess.check_output(['git', '-C', str(upstream), 'rev-parse', 'HEAD'], text=True).strip()
    if commit != 'eccdd09772edf14ab37fc63992b0626ad7ff2221' or subprocess.check_output(
        ['git', '-C', str(upstream), 'status', '--porcelain'], text=True).strip():
        raise ValueError('Require clean pinned upstream source')
    sys.path.insert(0, str(upstream / 'pqb/src'))
    from pqb import gpu, grind
    import coincurve
    import coincurve._libsecp256k1 as native
    if coincurve.__version__ != '21.0.0':
        raise ValueError('Require the upstream pinned native coincurve 21.0.0')
    payload = args.audit.read_bytes()
    audit = json.loads(payload)
    if not audit['passed'] or not audit['checked'] or not audit['packets']:
        raise ValueError('Require a complete native/consumer audit')
    problems = {}
    packet_receipts = []
    for key, original in audit['packets'].items():
        raw = json.loads(json.dumps(original))
        raw['menu']['r_inv'] = int(raw['menu']['r_inv'])
        if raw.get('pin_nonce') is not None:
            raw['pin_nonce'] = int(raw['pin_nonce'])
        raw['nonce_space'] = grind.PIN_NONCE_SPACE if raw['kind'] == 'pinning' else math.comb(len(raw['live_slots']), raw['t'])
        packet = grind.Packet(raw)
        problem = gpu.problem_from_packet(packet, gate_bits=24)
        problem_hash = hashlib.sha256(gpu.problem_txt(problem).encode()).hexdigest()
        if key.split(':', 1)[1] != problem_hash:
            raise ValueError('Upstream and consumer problem bytes differ')
        gpu.check_problem(packet, problem, samples=8, seed=1)
        problems[key] = (packet, problem)
        packet_receipts.append({'packetKey': key, 'problemSha256': problem_hash, 'sighashSamples': 8})
    records = []
    full_hits = 0
    for row in audit['checked']:
        packet, problem = problems[row['packetKey']]
        checker = gpu.HitChecker(packet, problem, gate_bits=24, canonical_first=40)
        candidates = []
        for emitted in row['cpu']:
            previous = checker.full
            candidate = checker.check(emitted['candidate'])
            full = checker.full > previous
            if full != emitted['verdict']['valid']:
                raise ValueError('Upstream and consumer full-predicate verdict differ')
            full_hits += int(full)
            candidates.append({'candidate': emitted['candidate'], 'full': full, 'details': candidate.as_dict(), 'consumerDecisionMatched': True})
        records.append({'jobId': row['jobId'], 'packetKey': row['packetKey'], 'candidates': candidates, 'checks': checker.stats()})
    result = {'passed': True, 'upstreamCommit': commit,
        'auditSha256': hashlib.sha256(payload).hexdigest(),
        'validatorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'curveBackend': {'implementation': 'native-coincurve', 'version': coincurve.__version__,
            'sharedObjectSha256': hashlib.sha256(Path(native.__file__).read_bytes()).hexdigest(),
            'python': sys.version, 'machine': platform.machine()},
        'packets': packet_receipts, 'records': records, 'fullHits': full_hits,
        'scope': 'Public problem bytes, sampled canonical sighashes and every emitted full-predicate verdict; no chain or miner execution'}
    with args.output.open('x') as out:
        json.dump(result, out, indent=2); out.write('\n'); out.flush(); os.fsync(out.fileno())
    parent = os.open(args.output.parent, os.O_RDONLY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    print(json.dumps({'passed': True, 'units': len(records), 'packets': len(packet_receipts), 'emittedHits': sum(len(r['candidates']) for r in records), 'fullHits': full_hits}))


if __name__ == '__main__':
    main()
