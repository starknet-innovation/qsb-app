"""Runpod research worker: public-data-only production search adapter.

This image is intentionally not enabled by the web application's release gate.
Each request runs a bounded process and returns public candidates for independent
verification. No browser recovery state is accepted.
"""
import base64
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile
import time
from search_ranges import VERSION, work_range

PINNED_KERNEL = '1650caf53a32b0ea16aae9e490ebbf5a8686d632'
FILES = {'pinning': 'pinning.bin', 'round1': 'digest_r1.bin', 'round2': 'digest_r2.bin'}

def validate_request(data):
    allowed = {'protocol', 'stage', 'parameterBase64', 'parameterSha256', 'sequence', 'locktime', 'attempt', 'manifestHash', 'kernelCommit', 'searchVersion'}
    if set(data) - allowed:
        raise ValueError('Unknown or potentially private fields are forbidden')
    if data['protocol'] != 'qsb-config-a-v1' or data['kernelCommit'] != PINNED_KERNEL:
        raise ValueError('Protocol or kernel mismatch')
    if data.get('searchVersion') != VERSION:
        raise ValueError('Search scheduler version mismatch')
    if data['stage'] not in FILES or not re.fullmatch('[a-f0-9]{64}', data['manifestHash']):
        raise ValueError('Invalid stage or manifest')
    raw = base64.b64decode(data['parameterBase64'], validate=True)
    if not 64 <= len(raw) <= 100000 or hashlib.sha256(raw).hexdigest() != data['parameterSha256']:
        raise ValueError('Parameter integrity check failed')
    attempt = data.get('attempt', 0)
    work_range(data['stage'], attempt)
    return raw

def handler(event):
    data = event['input']
    raw = validate_request(data)
    stage = data['stage']
    unit = work_range(stage, data.get('attempt', 0))
    with tempfile.TemporaryDirectory(prefix='qsb-public-') as directory:
        work = pathlib.Path(directory)
        (work / FILES[stage]).write_bytes(raw)
        if stage == 'pinning':
            command = ['/opt/qsb/pinning', FILES[stage], '0', '1', '0', 'single_hash',
                f"seq_start={unit['sequence']}", f"seq_count={unit['sequenceCount']}",
                f"lt_start={unit['locktime']}", f"lt_count={unit['count'] // unit['sequenceCount']}"]
        else:
            sequence, locktime = data.get('sequence'), data.get('locktime')
            if type(sequence) is not int or not 0x80000000 <= sequence <= 0xffffffff:
                raise ValueError('Invalid pinned sequence')
            if type(locktime) is not int or not 500000000 <= locktime < 1744600000:
                raise ValueError('Invalid pinned locktime')
            command = [str(pathlib.Path(__file__).resolve().parent / 'subset'), FILES[stage], '0', str(sequence), str(locktime), '1', '0', 'single_hash',
                f"rank_start={unit['start']}", f"rank_count={unit['count']}"]
        start = time.monotonic()
        with open(work / 'compute.log', 'w') as output:
            process = subprocess.Popen(command, cwd=work, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                process.wait(timeout=840)
                status = 'completed' if process.returncode == 0 else 'failed'
            except subprocess.TimeoutExpired:
                import signal
                os.killpg(process.pid, signal.SIGTERM)
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                status = 'interrupted'
        # Return only bounded public hit records. No arbitrary logs or file reads.
        hits = []
        for file in sorted((work / 'results').glob('*hit*.txt')):
            if file.stat().st_size >= 16384 or len(hits) >= 32:
                status = 'failed'  # Never silently omit candidates then skip a range.
                break
            hits.append(file.read_text())
        return {'status':status,'stage':stage,'manifestHash':data['manifestHash'],
                'attempt':data.get('attempt',0),'elapsedSeconds':time.monotonic()-start,
                'candidates':hits,'verified':False,'kernelCommit':PINNED_KERNEL,
                'workRange':unit,
                'checkpoint':'range-complete' if status=='completed' else 'requires-verification-or-resume'}

if __name__ == '__main__':
    import runpod
    runpod.serverless.start({'handler': handler})
