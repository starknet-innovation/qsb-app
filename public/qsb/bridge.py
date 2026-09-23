"""Browser-only adapter. Private state must never be sent to the coordinator."""
import contextlib
import hashlib
import io
import json
import os
from types import SimpleNamespace
import qsb_pipeline as pipeline
from bitcoin_tx import QSBScriptBuilder

PUBLIC_FIELDS = ('config', 'hash_mode', 'n', 't1s', 't1b', 't2s', 't2b',
                 'hors_commitments', 'dummy_sigs', 'pin_r', 'pin_s', 'pin_sig',
                 'round_sigs', 'full_script_hex')

def validate_state(state):
    if (state['config'], state['hash_mode'], state['n'], state['t1s'], state['t1b'], state['t2s'], state['t2b']) != ('A', 'sha256', 150, 8, 1, 7, 2):
        raise ValueError('Unsupported recovery configuration')
    builder = QSBScriptBuilder(150, 8, 1, 7, 2, hash_mode='sha256')
    builder.hors_commitments = [[bytes.fromhex(c) for c in r] for r in state['hors_commitments']]
    builder.dummy_sigs = [[bytes.fromhex(s) for s in r] for r in state['dummy_sigs']]
    from secp256k1 import hash160
    if len(state['hors_secrets']) != 2:
        raise ValueError('Invalid secret count')
    for ri in range(2):
        if len(state['hors_secrets'][ri]) != 150:
            raise ValueError('Invalid secret count')
        for i, secret in enumerate(state['hors_secrets'][ri]):
            if hash160(bytes.fromhex(secret)).hex() != state['hors_commitments'][ri][i]:
                raise ValueError('Recovery secrets do not match commitments')
    script = builder.build_full_script(bytes.fromhex(state['pin_sig']), *[bytes.fromhex(r['sig']) for r in state['round_sigs']])
    if script.hex() != state['full_script_hex'] or len(script) > 10000 or builder.count_opcodes_runtime(script)[0] > 201:
        raise ValueError('Recovery script mismatch')
    return script

def generate():
    with contextlib.redirect_stdout(io.StringIO()):
        pipeline.cmd_setup(SimpleNamespace(config='A', seed=None))
    state = json.load(open('qsb_state.json'))
    script = validate_state(state)
    public = {k: state[k] for k in PUBLIC_FIELDS}
    public['round_sigs'] = [{k: r[k] for k in ('r', 's', 'sig')} for r in state['round_sigs']]
    os.unlink('qsb_state.json')
    return json.dumps({'stateJson': json.dumps(state), 'publicStateJson': json.dumps(public), 'scriptHex': script.hex(), 'scriptHash': hashlib.sha256(script).hexdigest()})

def validate(state_json):
    script = validate_state(json.loads(state_json))
    return hashlib.sha256(script).hexdigest()

def assemble(state_json, manifest_json, solution_json):
    state, m, hit = json.loads(state_json), json.loads(manifest_json), json.loads(solution_json)
    validate_state(state)
    args = SimpleNamespace(funding_txid=m['funding']['txid'], funding_vout=m['funding']['vout'], funding_value=int(m['funding']['value']),
        extra_input_txid=m['helper']['txid'], extra_input_vout=m['helper']['vout'], extra_input_value=int(m['helper']['value']), extra_input_sequence=0xfffffffe,
        version=1, sequence=hit['sequence'], locktime=hit['locktime'], output_value=int(m['outputValue']), output_address='00'*20,
        round1=','.join(map(str,hit['round1'])), round2=','.join(map(str,hit['round2'])))
    # The app has already checksum-validated the destination with btc-signer.
    # Override only the destination encoder, preserving the upstream sighash/assembly.
    original = pipeline.p2pkh_script
    pipeline.p2pkh_script = lambda _: bytes.fromhex(m['outputScript'])
    try:
        open('qsb_state.json','w').write(state_json)
        if os.path.exists('qsb_raw_tx.hex'): os.unlink('qsb_raw_tx.hex')
        with contextlib.redirect_stdout(io.StringIO()): pipeline.cmd_assemble(args)
        if not os.path.exists('qsb_raw_tx.hex'): raise ValueError('QSB solution failed local assembly')
        return open('qsb_raw_tx.hex').read()
    finally:
        pipeline.p2pkh_script = original
        for filename in ('qsb_state.json','qsb_solution.json','qsb_raw_tx.hex'):
            if os.path.exists(filename): os.unlink(filename)
