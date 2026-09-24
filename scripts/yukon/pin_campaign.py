"""Bounded compute-only campaign over pre-exported public requests. Never auto-retries.
CPU verification is a separate mandatory step after downloading any hit/result.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
from pin_runtime import run, validate


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def save(path, value):
    with path.open('x') as f:
        json.dump(value, f, indent=2); f.write('\n'); f.flush()
        import os
        os.fsync(f.fileno())


def campaign(plan, binary, directory, seconds=1200):
    if type(seconds) is not int or not 120 <= seconds <= 1200:
        raise ValueError('Campaign budget must be 120..1200 seconds')
    if set(plan) != {'format', 'binarySha256', 'requests', 'unfundedSynthetic'} or plan['format'] != 'qsb-pin-campaign-v1' or plan['unfundedSynthetic'] is not True:
        raise ValueError('Explicit synthetic campaign required')
    requests = plan['requests']
    if not isinstance(requests, list) or not 1 <= len(requests) <= 100:
        raise ValueError('Bounded request list required')
    # Validate every range and require one context, consecutive disjoint sequence blocks.
    previous = None
    for request in requests:
        validate(request, plan['binarySha256'])
        r = request['range']
        if r['locktime'] + r['locktimeCount'] - 1 > 1744600000:
            raise ValueError('Outside CPU verifier domain')
        if previous:
            if any(request[k] != previous[k] for k in ('manifestHash', 'parameterSha256', 'parameterBase64')):
                raise ValueError('Mixed public context')
            p = previous['range']
            if r['sequence'] != p['sequence'] + p['sequenceCount'] or any(r[k] != p[k] for k in ('locktime', 'locktimeCount')):
                raise ValueError('Overlapping or discontinuous work')
        previous = request
    # Directory is single-use. A killed process leaves an intent and forbids reuse.
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    save(directory/'plan.json', plan)
    deadline = time.monotonic() + seconds
    completed = 0
    for index, request in enumerate(requests):
        if deadline - time.monotonic() < 100:
            break
        save(directory/f'{index:03d}.intent.json', {'planHash': digest(plan), 'requestHash': digest(request), 'attempt': index})
        start = time.monotonic()
        # Runtime enforces exact binary and range completion, kills its process group on timeout.
        output = run(request, binary, plan['binarySha256'], timeout=90)
        save(directory/f'{index:03d}.result.json', {'requestHash': digest(request), 'output': output, 'wallSeconds': time.monotonic()-start})
        if output['status'] != 'range-drained':
            raise ValueError('Incomplete range: stop; no automatic retry')
        completed += 1
        if output['candidates']:
            save(directory/'stopped-for-verification.json', {'attempt': index, 'cpuVerified': False, 'releaseStatus': 'HOLD'})
            return
    save(directory/'bounded-stop.json', {'completedRangeOutputs': completed, 'rangeCreditGranted': False, 'cpuVerified': False, 'releaseStatus': 'HOLD'})


if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--plan', type=Path, required=True); p.add_argument('--binary', type=Path, required=True); p.add_argument('--out', type=Path, required=True); p.add_argument('--seconds', type=int, default=1200)
    a = p.parse_args(); campaign(json.loads(a.plan.read_text()), a.binary, a.out, a.seconds)
