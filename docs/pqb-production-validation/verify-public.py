"""Verify retained public bytes and inventory; use the separate checker for curve verdicts."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'sha256-manifest.json').read_text())
actual = {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and p.name != 'sha256-manifest.json'}
assert actual == set(manifest['files']), 'Public file inventory changed'
for name, digest in manifest['files'].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name

assessment = json.loads((root / 'assessment.json').read_text())
fixture = json.loads((root / 'public-fixture.json').read_text())
receipt = json.loads((root / 'native-requests-and-results.json').read_text())
audit = json.loads((root / 'native-accounting-audit.json').read_text())
independent = json.loads((root / 'independent-native-check.json').read_text())
core = json.loads((root / 'offline-consensus.json').read_text())
records = {r['jobId']: r for r in receipt['records']}
assert len(records) == len(receipt['records']) == 111
assert receipt['sourceCommit'] == assessment['nativeConsumerSourceCommit']
assert receipt['image'] == assessment['descriptor']['image'] == fixture['descriptor']['image']
assert audit['passed'] and independent['passed'] and core['passed']
assert independent['auditSha256'] == hashlib.sha256((root / 'native-accounting-audit.json').read_bytes()).hexdigest()
assert independent['validatorSha256'] == hashlib.sha256((root / 'independent-native-crosscheck.py').read_bytes()).hexdigest()

inputs = {}
for identity, record in records.items():
    raw = record['requestJson'].encode()
    assert hashlib.sha256(raw).hexdigest() == record['requestSha256']
    request = json.loads(raw)['input']
    assert request['protocol'] == 'pqb-v1'
    assert request['kernelCommit'] == assessment['descriptor']['kernelCommit']
    assert request['manifestHash'] == fixture['rows'][1]['job']['manifestHash']
    inputs[identity] = request
    if record['responseJson'] is not None:
        raw = record['responseJson'].encode()
        assert hashlib.sha256(raw).hexdigest() == record['responseSha256']
        envelope = json.loads(raw)
        assert envelope['jobId'] == identity and envelope['inputSha256'] == record['requestSha256']
        output = envelope['output']
        assert all(output[k] == request[k] for k in ['kernelCommit', 'manifestHash', 'stage', 'attempt', 'searchVersion'])

successful = {r['jobId'] for r in records.values() if r['providerStatus'] == 'SUCCEEDED'}
canceled = {r['jobId'] for r in records.values() if r['providerStatus'] == 'FAILED'}
assert len(successful) == 103 and len(canceled) == 8 and successful | canceled == set(records)
assert successful == {r['jobId'] for r in audit['checked']}
assert canceled == {r['jobId'] for r in audit['cancellations']}
assert len([r for r in records.values() if r['phase'] == 'preflight']) == 1
for identity in successful:
    assert json.loads(records[identity]['responseJson'])['output']['status'] == 'completed'

winners = {}
for checked in audit['checked']:
    if any(verdict['verdict']['valid'] for verdict in checked['cpu']):
        winners.setdefault(checked['packetKey'], []).append(records[checked['jobId']]['stoppedAt'])
for identity in canceled:
    record = records[identity]
    assert record['statusReason'] == 'QSB operator/coordinator cancellation'
    request = inputs[identity]
    stage = {'pinning': 'pinning', 'round0': 'round1', 'round1': 'round2'}[request['stage']]
    key = stage + ':' + request['problemSha256']
    assert any(t <= record['stoppedAt'] for t in winners.get(key, []))

assert independent['fullHits'] == 3
assert sum(len(r['candidates']) for r in independent['records']) == 14
assert len(core['checks']) == 13
assert sum(c['accepted'] and c['expectedValid'] for c in core['checks']) == 1
assert sum(not c['accepted'] and not c['expectedValid'] for c in core['checks']) == 12
print(json.dumps({'publicBytesAndInventoryVerified': True, 'nativeRecords': 111,
    'completedUnits': 103, 'supersededCancellations': 8,
    'scope': 'Retained bytes and inventory; run independent-native-crosscheck.py to recompute curve verdicts.'}))
