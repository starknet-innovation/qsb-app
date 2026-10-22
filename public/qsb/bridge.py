"""Browser-only adapter. Private state must never be sent to the coordinator."""
import contextlib
import hashlib
import io
import json
import os
import re
from types import SimpleNamespace
import qsb_pipeline as pipeline
from bitcoin_tx import QSBScriptBuilder

PUBLIC_FIELDS = ('config', 'hash_mode', 'n', 't1s', 't1b', 't2s', 't2b',
                 'hors_commitments', 'dummy_sigs', 'pin_r', 'pin_s', 'pin_sig',
                 'round_sigs', 'full_script_hex')
CONFIG_A = {'config': 'A', 'hash_mode': 'sha256', 'n': 150, 't1s': 8, 't1b': 1, 't2s': 7, 't2b': 2}

def validate_state(state):
    if tuple(state[k] for k in CONFIG_A) != tuple(CONFIG_A.values()):
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

def setup(secrets=None):
    """Run the pipeline's Config A setup and return the state it saves. `secrets`, the HORS secrets in
    the order generate_keys draws them, replace its 20-byte os.urandom draws."""
    original = os.urandom
    draws = iter(secrets or ())
    def urandom(size):
        if size != 20:
            return original(size)
        secret = next(draws, None)
        if secret is None:
            raise ValueError('The pipeline drew more HORS secrets than the state holds')
        return secret
    if secrets is not None:
        os.urandom = urandom
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            pipeline.cmd_setup(SimpleNamespace(config='A', seed=None))
    finally:
        os.urandom = original
    with open('qsb_state.json') as f:
        state = json.load(f)
    os.unlink('qsb_state.json')
    return state

def result(state):
    script = validate_state(state)
    public = {k: state[k] for k in PUBLIC_FIELDS}
    public['round_sigs'] = [{k: r[k] for k in ('r', 's', 'sig')} for r in state['round_sigs']]
    return json.dumps({'stateJson': json.dumps(state), 'publicStateJson': json.dumps(public), 'scriptHex': script.hex(), 'scriptHash': hashlib.sha256(script).hexdigest()})

def generate():
    return result(setup())

def difference(supplied, expected, path=''):
    """The first place `supplied` differs from `expected` in shape, type or value, or None."""
    if isinstance(expected, dict) and isinstance(supplied, dict):
        at = lambda key: f'{path}.{key}' if path else key
        for key in supplied:
            if key not in expected:
                return f'{at(key)} is not a field the pipeline produces'
        for key in expected:
            found = f'{at(key)} is missing' if key not in supplied else difference(supplied[key], expected[key], at(key))
            if found:
                return found
        return None
    if isinstance(expected, list) and isinstance(supplied, list) and len(supplied) == len(expected):
        for i, (a, b) in enumerate(zip(supplied, expected)):
            found = difference(a, b, f'{path}[{i}]')
            if found:
                return found
        return None
    if isinstance(expected, (dict, list)) or json.dumps(supplied) != json.dumps(expected):
        return f'{path} is not what the pipeline builds from these HORS secrets'
    return None

def unique(pairs):
    """A JSON object whose keys each appear once; json.loads would otherwise keep the last."""
    keys = [k for k, _ in pairs]
    for key in keys:
        if keys.count(key) > 1:
            raise ValueError(f'{key} appears twice in one object')
    return dict(pairs)

def adopt(state_json):
    """Accept a caller's recovery state only if it is exactly the state setup builds from its HORS secrets."""
    state = json.loads(state_json, object_pairs_hook=unique)
    if not isinstance(state, dict):
        raise ValueError('The recovery state is not a JSON object')
    for key in (*CONFIG_A, 'hors_secrets'):
        if key not in state:
            raise ValueError(f'{key} is missing')
    for key, value in CONFIG_A.items():
        if json.dumps(state[key]) != json.dumps(value):
            raise ValueError(f"{key} is not Config A's {json.dumps(value)}")
    secrets = state['hors_secrets']
    if not isinstance(secrets, list) or len(secrets) != 2 or any(not isinstance(r, list) or len(r) != 150 for r in secrets):
        raise ValueError('hors_secrets is not 2 rounds of 150 secrets')
    flat = [s for r in secrets for s in r]
    if not all(isinstance(s, str) and re.fullmatch('[0-9a-f]{40}', s) for s in flat):
        raise ValueError('Each HORS secret is 20 bytes of lowercase hex')
    if len(set(flat)) != len(flat):
        raise ValueError('A HORS secret repeats')
    expected = setup([bytes.fromhex(s) for s in flat])
    found = difference(state, expected)
    if found:
        raise ValueError(found)
    return result(expected)

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
        with open('qsb_state.json','w') as f: f.write(state_json)
        if os.path.exists('qsb_raw_tx.hex'): os.unlink('qsb_raw_tx.hex')
        with contextlib.redirect_stdout(io.StringIO()): pipeline.cmd_assemble(args)
        if not os.path.exists('qsb_raw_tx.hex'): raise ValueError('QSB solution failed local assembly')
        with open('qsb_raw_tx.hex') as f: return f.read()
    finally:
        pipeline.p2pkh_script = original
        for filename in ('qsb_state.json','qsb_solution.json','qsb_raw_tx.hex'):
            if os.path.exists(filename): os.unlink(filename)
