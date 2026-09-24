"""Public-only parameter export and independent candidate verification.

This is a reference check, not Bitcoin Core consensus validation. No HORS
secrets are accepted, and no signature or transaction is produced here.
"""
import base64
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace

import qsb_pipeline as pipeline
import verify_hit

PUBLIC_FIELDS = {'config', 'hash_mode', 'n', 't1s', 't1b', 't2s', 't2b',
                 'hors_commitments', 'dummy_sigs', 'pin_r', 'pin_s', 'pin_sig',
                 'round_sigs', 'full_script_hex'}
FILES = {'pinning': 'pinning.bin', 'round1': 'digest_r1.bin', 'round2': 'digest_r2.bin'}


def handler(event, context=None):
    if set(event) - {'action', 'publicStateJson', 'manifest', 'stage', 'sequence', 'locktime', 'candidates'}:
        raise ValueError('Unexpected fields')
    state = json.loads(event['publicStateJson'])
    if set(state) != PUBLIC_FIELDS or any(set(r) != {'r', 's', 'sig'} for r in state['round_sigs']):
        raise ValueError('Private or unsupported state')
    if (state['config'], state['hash_mode'], state['n'], state['t1s'], state['t1b'], state['t2s'], state['t2b']) != ('A', 'sha256', 150, 8, 1, 7, 2):
        raise ValueError('Unsupported configuration')
    stage = event['stage']
    if stage not in FILES or event['action'] not in ('export', 'verify'):
        raise ValueError('Unsupported action')
    m = event['manifest']
    if not re.fullmatch(r'(?:[a-f0-9]{2}){1,100}', m['outputScript']):
        raise ValueError('Invalid destination script')
    if int(m['funding']['value']) + int(m['helper']['value']) != int(m['outputValue']) + int(m['fee']):
        raise ValueError('Amounts do not balance')
    args = SimpleNamespace(funding_txid=m['funding']['txid'], funding_vout=m['funding']['vout'], funding_value=int(m['funding']['value']),
        extra_input_txid=m['helper']['txid'], extra_input_vout=m['helper']['vout'], extra_input_value=int(m['helper']['value']), extra_input_sequence=0xfffffffe,
        version=1, sequence=event.get('sequence', 0x80000000), locktime=event.get('locktime', 500000000),
        output_value=int(m['outputValue']), output_address='00'*20)
    previous, encoder = os.getcwd(), pipeline.p2pkh_script
    try:
        with tempfile.TemporaryDirectory(prefix='qsb-public-') as directory, contextlib.redirect_stdout(io.StringIO()):
            os.chdir(directory)
            Path('qsb_state.json').write_text(event['publicStateJson'])
            pipeline.p2pkh_script = lambda _: bytes.fromhex(m['outputScript'])
            pipeline.cmd_export(args)
            raw = Path(FILES[stage]).read_bytes()
            if event['action'] == 'export':
                return {'parameterBase64': base64.b64encode(raw).decode(), 'parameterSha256': hashlib.sha256(raw).hexdigest()}
            candidates = event.get('candidates', [])
            if len(candidates) > 32 or any(not isinstance(c, str) or len(c) > 16384 for c in candidates):
                raise ValueError('Invalid candidate records')
            der_only = 0
            records = [record for c in candidates for record in re.split(r'(?=^(?:indices|sequence)=)', c, flags=re.MULTILINE) if record.strip()]
            for candidate in records:
                fields = dict(re.findall(r'^([a-z_]+)=([^\n]+)$', candidate, re.MULTILINE))
                check = SimpleNamespace(work_dir=directory, funding_txid=args.funding_txid, funding_vout=args.funding_vout,
                    version=1, sequence=args.sequence, locktime=args.locktime, gpu_hit_file=None)
                if stage == 'pinning':
                    if not fields.get('sequence', '').isdigit() or not fields.get('locktime', '').isdigit():
                        continue
                    check.sequence, check.locktime = int(fields['sequence']), int(fields['locktime'])
                    if not 0x80000000 <= check.sequence <= 0xffffffff or not 500000000 <= check.locktime <= 1744600000:
                        continue
                    verdict = verify_hit.verify_pin(check)
                    if verdict == 3: der_only += 1
                    if verdict == 0:
                        return {'valid': True, 'sequence': check.sequence, 'locktime': check.locktime}
                else:
                    indices = fields.get('indices', '')
                    if not re.fullmatch(r'\d+(?:,\d+){8}', indices):
                        continue
                    values = list(map(int, indices.split(',')))
                    if len(set(values)) != 9 or min(values) < 0 or max(values) >= 150:
                        continue
                    # Binary dummy pushes are reversed relative to the HORS pool.
                    values = sorted(149 - i for i in values)
                    check.round, check.indices = int(stage[-1]), ','.join(map(str, values))
                    verdict = verify_hit.verify_digest(check)
                    if verdict == 3: der_only += 1
                    if verdict == 0:
                        return {'valid': True, 'indices': sorted(values)}
            if records and der_only == len(records):
                return {'valid': False, 'derOnly': True}
            return {'valid': False}
    finally:
        os.chdir(previous)
        pipeline.p2pkh_script = encoder
