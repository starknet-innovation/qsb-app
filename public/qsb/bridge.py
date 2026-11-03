"""Browser-only adapter. Private state must never be sent to the coordinator."""
import contextlib
import hashlib
import io
import json
import os
import re
from types import SimpleNamespace
import qsb_pipeline as pipeline
import secp256k1
from bitcoin_tx import QSBScriptBuilder, serialize_varint

PUBLIC_FIELDS = ('config', 'hash_mode', 'n', 't1s', 't1b', 't2s', 't2b',
                 'hors_commitments', 'dummy_sigs', 'pin_r', 'pin_s', 'pin_sig',
                 'round_sigs', 'full_script_hex')
CONFIG_A = {'config': 'A', 'hash_mode': 'sha256', 'n': 150, 't1s': 8, 't1b': 1, 't2s': 7, 't2b': 2}
HEX20 = '[0-9a-f]{40}'

def config_builder(state):
    """A Config A script builder holding state's commitments and dummy signatures."""
    if tuple(state[k] for k in CONFIG_A) != tuple(CONFIG_A.values()):
        raise ValueError('Unsupported recovery configuration')
    builder = QSBScriptBuilder(150, 8, 1, 7, 2, hash_mode='sha256')
    builder.hors_commitments = [[bytes.fromhex(c) for c in r] for r in state['hors_commitments']]
    builder.dummy_sigs = [[bytes.fromhex(s) for s in r] for r in state['dummy_sigs']]
    return builder

def built_script(builder, state):
    """The script builder builds with state's signatures, refused unless it is state's full_script_hex within
    the 10,000-byte and 201-opcode limits."""
    script = builder.build_full_script(bytes.fromhex(state['pin_sig']), *[bytes.fromhex(r['sig']) for r in state['round_sigs']])
    if script.hex() != state['full_script_hex'] or len(script) > 10000 or builder.count_opcodes_runtime(script)[0] > 201:
        raise ValueError('Recovery script mismatch')
    return script

def validate_state(state):
    builder = config_builder(state)
    if len(state['hors_secrets']) != 2:
        raise ValueError('Invalid secret count')
    for ri in range(2):
        if len(state['hors_secrets'][ri]) != 150:
            raise ValueError('Invalid secret count')
        for i, secret in enumerate(state['hors_secrets'][ri]):
            if secp256k1.hash160(bytes.fromhex(secret)).hex() != state['hors_commitments'][ri][i]:
                raise ValueError('Recovery secrets do not match commitments')
    return built_script(builder, state)

def saved_setup():
    """Run the pipeline's Config A setup and return the state it saves."""
    with contextlib.redirect_stdout(io.StringIO()):
        pipeline.cmd_setup(SimpleNamespace(config='A', seed=None))
    with open('qsb_state.json') as f:
        state = json.load(f)
    os.unlink('qsb_state.json')
    return state

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
        return saved_setup()
    finally:
        os.urandom = original

def public_fields(state):
    """The fields of state that may leave the machine: no HORS secret and no signature nonce."""
    public = {k: state[k] for k in PUBLIC_FIELDS}
    public['round_sigs'] = [{k: r[k] for k in ('r', 's', 'sig')} for r in state['round_sigs']]
    return public

def public_outputs(state, script):
    return {'publicStateJson': json.dumps(public_fields(state)), 'scriptHex': script.hex(), 'scriptHash': hashlib.sha256(script).hexdigest()}

def result(state):
    script = validate_state(state)
    return json.dumps({'stateJson': json.dumps(state), **public_outputs(state, script)})

def generate():
    return result(setup())

class RefusedError(ValueError):
    """adopt's refusal of a supplied state: the message says what didn't match."""

def name(key):
    """A caller's JSON key as it appears in a message, quoted unless it's a plain name."""
    return key if re.fullmatch('[A-Za-z_][A-Za-z0-9_]*', key) else json.dumps(key)

def difference(supplied, expected, path='', fields='a field the pipeline produces', source='these HORS secrets'):
    """The first place `supplied` differs from `expected` in shape, type or value, or None. `fields` names what
    an unexpected key isn't, and `source` what `expected` was built from."""
    if isinstance(expected, dict) and isinstance(supplied, dict):
        at = lambda key: f'{path}.{key}' if path else key
        for key in supplied:
            if key not in expected:
                return f'{at(name(key))} is not {fields}'
        for key in expected:
            found = f'{at(key)} is missing' if key not in supplied else difference(supplied[key], expected[key], at(key), fields, source)
            if found:
                return found
        return None
    if isinstance(expected, list) and isinstance(supplied, list) and len(supplied) == len(expected):
        for i, (a, b) in enumerate(zip(supplied, expected)):
            found = difference(a, b, f'{path}[{i}]', fields, source)
            if found:
                return found
        return None
    if isinstance(expected, (dict, list)) or json.dumps(supplied) != json.dumps(expected):
        return f'{path} is not what the pipeline builds from {source}'
    return None

def unique(pairs):
    """A JSON object whose keys each appear once; json.loads would otherwise keep the last."""
    seen = set()
    for key, _ in pairs:
        if key in seen:
            raise RefusedError(f'{name(key)} appears twice in one object')
        seen.add(key)
    return dict(pairs)

def nesting(text):
    """How deeply text's JSON arrays and objects nest, outside strings."""
    level = deepest = 0
    quoted = escaped = False
    for ch in text:
        if quoted:
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == '"':
                quoted = False
        elif ch == '"':
            quoted = True
        elif ch in '[{':
            level += 1
            deepest = max(deepest, level)
        elif ch in ']}':
            level -= 1
    return deepest

def parse(text, label, depth, shape, refuse):
    """text's JSON value, refused with `refuse` when it nests deeper than `depth` (as `shape` does), isn't JSON
    or repeats a key in one object."""
    # Deeper input could exhaust the interpreter's stack.
    if nesting(text) > depth:
        raise refuse(f'{label} nests deeper than {shape}')
    try:
        return json.loads(text, object_pairs_hook=unique)
    except RefusedError as error:
        raise refuse(str(error)) from None
    except ValueError as error:
        raise refuse(f'{label} is not JSON this check reads ({error})') from None

def adopt(state_json):
    """Accept a caller's recovery state only if it is exactly the state setup builds from its HORS secrets."""
    # The pipeline's state nests 3 deep.
    state = parse(state_json, 'the recovery state', 3, "the pipeline's state", RefusedError)
    if not isinstance(state, dict):
        raise RefusedError('the recovery state is not a JSON object')
    for key in (*CONFIG_A, 'hors_secrets'):
        if key not in state:
            raise RefusedError(f'{key} is missing')
    for key, value in CONFIG_A.items():
        if json.dumps(state[key]) != json.dumps(value):
            raise RefusedError(f"{key} is not Config A's {json.dumps(value)}")
    secrets = state['hors_secrets']
    if not isinstance(secrets, list) or len(secrets) != 2 or any(not isinstance(r, list) or len(r) != 150 for r in secrets):
        raise RefusedError('hors_secrets is not 2 rounds of 150 secrets')
    flat = [s for r in secrets for s in r]
    if not all(isinstance(s, str) and re.fullmatch(HEX20, s) for s in flat):
        raise RefusedError('a HORS secret is not 20 bytes of lowercase hex')
    if len(set(flat)) != len(flat):
        raise RefusedError('a HORS secret repeats')
    expected = setup([bytes.fromhex(s) for s in flat])
    found = difference(state, expected)
    if found:
        raise RefusedError(found)
    return result(expected)

def validate(state_json):
    script = validate_state(json.loads(state_json))
    return hashlib.sha256(script).hexdigest()

def run_assemble(state_text, m, hit):
    """The pipeline's assemble on state_text: the raw transaction hex it writes, and the solution it saves."""
    args = SimpleNamespace(funding_txid=m['funding']['txid'], funding_vout=m['funding']['vout'], funding_value=int(m['funding']['value']),
        extra_input_txid=m['helper']['txid'], extra_input_vout=m['helper']['vout'], extra_input_value=int(m['helper']['value']), extra_input_sequence=0xfffffffe,
        version=1, sequence=hit['sequence'], locktime=hit['locktime'], output_value=int(m['outputValue']), output_address='00'*20,
        round1=','.join(map(str,hit['round1'])), round2=','.join(map(str,hit['round2'])))
    # The app has already checksum-validated the destination with btc-signer.
    # Override only the destination encoder, preserving the upstream sighash/assembly.
    original = pipeline.p2pkh_script
    pipeline.p2pkh_script = lambda _: bytes.fromhex(m['outputScript'])
    try:
        with open('qsb_state.json','w') as f: f.write(state_text)
        for filename in ('qsb_raw_tx.hex','qsb_solution.json'):
            if os.path.exists(filename): os.unlink(filename)
        with contextlib.redirect_stdout(io.StringIO()): pipeline.cmd_assemble(args)
        if not os.path.exists('qsb_raw_tx.hex'): raise ValueError('QSB solution failed local assembly')
        with open('qsb_raw_tx.hex') as f: raw = f.read()
        with open('qsb_solution.json') as f: return raw, json.load(f)
    finally:
        pipeline.p2pkh_script = original
        for filename in ('qsb_state.json','qsb_solution.json','qsb_raw_tx.hex'):
            if os.path.exists(filename): os.unlink(filename)

def assemble(state_json, manifest_json, solution_json):
    state, m, hit = json.loads(state_json), json.loads(manifest_json), json.loads(solution_json)
    validate_state(state)
    return run_assemble(state_json, m, hit)[0]

# Commitments only: the HORS secrets stay with a key manager outside this runtime, which derives them under
# the BIP draft "QSB Wallet Secret Management" (QSB-HORS-v1). The vault script needs only their commitments.
# A withdrawal is assembled in two calls: prepare returns the spending transaction and the indices to disclose,
# for the key manager to record before it releases anything; finish takes exactly those preimages. Each call
# refuses input it can't check with a ValueError that says what's wrong, and returns nothing then.

# The longest JSON text a commitments-only call takes. prepare's result is read back by finish, so prepare
# refuses a result longer than this too.
MAX_JSON_TEXT = 1000000

def read(text, label, depth, shape):
    """parse for the commitments-only calls, which take JSON text of at most a million characters."""
    if not isinstance(text, str):
        raise ValueError(f'{label} is not JSON text')
    # A public state is about 41,000 characters.
    if len(text) > MAX_JSON_TEXT:
        raise ValueError(f'{label} is longer than a million characters')
    return parse(text, label, depth, shape, ValueError)

def commitments(value):
    """value, refused unless it is 2 rounds of 150 distinct HORS commitments, each 20 bytes of lowercase hex."""
    if not isinstance(value, list) or len(value) != 2 or any(not isinstance(r, list) or len(r) != CONFIG_A['n'] for r in value):
        raise ValueError('the commitments are not 2 rounds of 150')
    flat = [c for r in value for c in r]
    if not all(isinstance(c, str) and re.fullmatch(HEX20, c) for c in flat):
        raise ValueError('a commitment is not 20 bytes of lowercase hex')
    if len(set(flat)) != len(flat):
        raise ValueError('a commitment repeats')
    return value

def commitments_setup(hors_commitments):
    """The state the pipeline's setup saves when generate_keys's HORS commitments are `hors_commitments`, with
    no HORS secret in it. generate_keys still builds the dummy signatures, which it enumerates, but it draws
    nothing: os.urandom yields no bytes while it runs, and the commitments replace its HORS slots before setup
    reads them. Every other field comes from setup's fixed constants, as it does for drawn secrets."""
    class CommitmentsBuilder(QSBScriptBuilder):
        def generate_keys(self):
            original = os.urandom
            os.urandom = lambda size: b''
            try:
                super().generate_keys()
            finally:
                os.urandom = original
            self.hors_secrets = [[], []]
            self.hors_commitments = [[bytes.fromhex(c) for c in r] for r in hors_commitments]
    original = pipeline.QSBScriptBuilder
    pipeline.QSBScriptBuilder = CommitmentsBuilder
    try:
        return saved_setup()
    finally:
        pipeline.QSBScriptBuilder = original

def setup_from_commitments(commitments_json):
    """What generate returns for HORS secrets whose HASH160s are commitments_json (JSON text of 2 rounds of
    150 commitments, in generate_keys's order), less stateJson: publicStateJson, scriptHex and scriptHash."""
    hors_commitments = commitments(read(commitments_json, 'the commitment list', 2, '2 rounds of commitments'))
    state = commitments_setup(hors_commitments)
    return json.dumps(public_outputs(state, built_script(config_builder(state), state)))

def public_state(text):
    """The public state in text and the state setup builds from its commitments, refused unless every field of
    text is what that state's public fields hold."""
    public = read(text, 'the public state', 3, 'a public state')
    if not isinstance(public, dict):
        raise ValueError('the public state is not a JSON object')
    if 'hors_commitments' not in public:
        raise ValueError('hors_commitments is missing')
    state = commitments_setup(commitments(public['hors_commitments']))
    expected = public_fields(state)
    found = difference(public, expected, fields='a field of the public state', source='these commitments')
    if found:
        raise ValueError(found)
    return expected, state

def uint(value, bits):
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 1 << bits

def amount(value, label):
    """Refuse value unless it's a number of satoshis, as an integer or as the app's decimal text."""
    if not (uint(value, 64) or (isinstance(value, str) and re.fullmatch('0|[1-9][0-9]{0,15}', value))) or int(value) > 2100000000000000:
        raise ValueError(f'{label} is not an amount of satoshis')

def manifest(m):
    """m, refused unless the vault outpoint, helper outpoint, payout and output script it holds can make a
    transaction. Its other fields aren't read."""
    if not isinstance(m, dict):
        raise ValueError('the manifest is not a JSON object')
    for key in ('funding', 'helper'):
        point = m.get(key)
        if not isinstance(point, dict):
            raise ValueError(f'{key} is not an outpoint')
        if not (isinstance(point.get('txid'), str) and re.fullmatch('[0-9a-fA-F]{64}', point['txid'])):
            raise ValueError(f'{key}.txid is not a transaction id')
        if not uint(point.get('vout'), 32):
            raise ValueError(f'{key}.vout is not an output index')
        amount(point.get('value'), f'{key}.value')
    if (m['funding']['txid'].lower(), m['funding']['vout']) == (m['helper']['txid'].lower(), m['helper']['vout']):
        raise ValueError('the helper outpoint is the vault outpoint')
    amount(m.get('outputValue'), 'outputValue')
    if not (isinstance(m.get('outputScript'), str) and re.fullmatch('(?:[0-9a-fA-F]{2}){1,10000}', m['outputScript'])):
        raise ValueError('outputScript is not a script in hex')
    return m

def indices(value, size):
    """Whether value is `size` distinct HORS indices, in any order."""
    return (isinstance(value, list) and len(value) == size
            and all(uint(i, 8) and i < CONFIG_A['n'] for i in value) and len(set(value)) == size)

def solution(hit):
    """hit, refused unless its sequence, locktime and two subsets of 9 indices can be assembled."""
    if not isinstance(hit, dict):
        raise ValueError('the solution is not a JSON object')
    for key in ('sequence', 'locktime'):
        if not uint(hit.get(key), 32):
            raise ValueError(f'{key} is not a 32-bit unsigned integer')
    for key, size in (('round1', CONFIG_A['t1s'] + CONFIG_A['t1b']), ('round2', CONFIG_A['t2s'] + CONFIG_A['t2b'])):
        if not indices(hit.get(key), size):
            raise ValueError(f'{key} is not {size} distinct indices below 150')
    return hit

def unsigned(raw):
    """T for raw, a transaction in legacy serialization: the same bytes with every input's scriptSig empty.
    Refused unless raw is exactly one such transaction."""
    at = 0
    def take(size):
        nonlocal at
        if size > len(raw) - at:
            raise ValueError('the assembled transaction is truncated')
        at += size
        return raw[at - size:at]
    def count():
        first = take(1)[0]
        return first if first < 0xfd else int.from_bytes(take({0xfd: 2, 0xfe: 4, 0xff: 8}[first]), 'little')
    t = bytearray(take(4))
    inputs = count()
    if not inputs:
        raise ValueError('the assembled transaction has no inputs')
    t += serialize_varint(inputs)
    for _ in range(inputs):
        t += take(36)
        take(count())
        t += serialize_varint(0) + take(4)
    outputs = count()
    t += serialize_varint(outputs)
    for _ in range(outputs):
        t += take(8)
        script = take(count())
        t += serialize_varint(len(script)) + script
    t += take(4)
    if at != len(raw):
        raise ValueError('the assembled transaction has trailing bytes')
    return bytes(t)

# Stand-ins prepare gives the pipeline for the HORS secrets: public bytes naming each one's round and index.
MARKERS = [[f'{r:02x}{i:04x}' + '00' * 17 for i in range(CONFIG_A['n'])] for r in range(2)]
SLOTS = {marker: (r, i) for r, row in enumerate(MARKERS) for i, marker in enumerate(row)}

def prepare(public_state_json, manifest_json, solution_json):
    """Phase one of a commitments-only withdrawal, with no HORS secret. The arguments are what assemble takes,
    except that the state is a vault's publicStateJson, which must be exactly what setup_from_commitments
    returns for its commitments. Runs the pipeline's assemble with a public stand-in for each secret, and
    returns JSON text of:
      transaction: T (BIP draft "QSB Wallet Secret Management"), in hex: the spending transaction in legacy
        serialization, every scriptSig empty and no witness;
      round0, round1: the indices of the 8 and 7 secrets the solution discloses from the solution's round1
        and round2, in the order the pipeline signs with them (it sorts each subset); keep that order, never reorder it;
      scriptHash: the vault script's SHA-256;
      publicStateJson, manifest, solution: what finish needs to assemble the same transaction again.
    It refuses a solution the pipeline can't assemble, so nothing is disclosed for one."""
    m = manifest(read(manifest_json, 'the manifest', 2, 'a withdrawal manifest'))
    hit = solution(read(solution_json, 'the solution', 2, 'a solution'))
    public, state = public_state(public_state_json)
    raw, saved = run_assemble(json.dumps({**state, 'hors_secrets': MARKERS}), m, hit)
    # The stand-ins the pipeline signs with name the secrets it takes, in its order.
    taken = [[SLOTS.get(p) for p in r['preimages']] for r in saved['rounds']]
    if [len(r) for r in taken] != [CONFIG_A['t1s'], CONFIG_A['t2s']] or any(s is None or s[0] != r for r, row in enumerate(taken) for s in row):
        raise ValueError('the pipeline signed with secrets other than 8 of round 1 and 7 of round 2')
    rounds = [[i for _, i in row] for row in taken]
    prepared = json.dumps({'transaction': unsigned(bytes.fromhex(raw)).hex(), 'round0': rounds[0], 'round1': rounds[1],
        'scriptHash': hashlib.sha256(bytes.fromhex(state['full_script_hex'])).hexdigest(),
        'publicStateJson': json.dumps(public), 'manifest': m, 'solution': hit})
    # finish reads this back with the same limit, so a result it would refuse is refused here, before the key
    # manager records T or releases a preimage, rather than after.
    if len(prepared) > MAX_JSON_TEXT:
        raise ValueError('the prepared withdrawal would be longer than finish accepts')
    return prepared

PREPARED_FIELDS = ('transaction', 'round0', 'round1', 'scriptHash', 'publicStateJson', 'manifest', 'solution')

def finish(prepared_json, preimages_json):
    """Phase two: the raw transaction assemble returns for the same vault, manifest and solution. prepared_json
    is what prepare returned; preimages_json is JSON text of exactly 15 preimages, each 20 bytes of lowercase hex,
    for round0's indices and then round1's, in that order. Refused unless each preimage's HASH160 is its index's
    commitment, the pipeline signs with exactly these preimages in this order, and the transaction it assembles
    is prepare's T once its scriptSigs are emptied."""
    prepared = read(prepared_json, 'the prepared withdrawal', 3, 'a prepared withdrawal')
    if not isinstance(prepared, dict):
        raise ValueError('the prepared withdrawal is not a JSON object')
    for key in prepared:
        if key not in PREPARED_FIELDS:
            raise ValueError(f'{name(key)} is not a field prepare returns')
    for key in PREPARED_FIELDS:
        if key not in prepared:
            raise ValueError(f'{key} is missing')
    m, hit = manifest(prepared['manifest']), solution(prepared['solution'])
    if not indices(prepared['round0'], CONFIG_A['t1s']) or not indices(prepared['round1'], CONFIG_A['t2s']):
        raise ValueError('round0 and round1 are not 8 and 7 distinct indices below 150')
    if not (isinstance(prepared['transaction'], str) and re.fullmatch('(?:[0-9a-f]{2})+', prepared['transaction'])):
        raise ValueError('transaction is not lowercase hex')
    preimages = read(preimages_json, 'the preimage list', 1, 'a list of preimages')
    slots = [(0, i) for i in prepared['round0']] + [(1, i) for i in prepared['round1']]
    if not isinstance(preimages, list) or len(preimages) != len(slots):
        raise ValueError(f'the preimages are not a list of exactly {len(slots)}')
    if not all(isinstance(p, str) and re.fullmatch(HEX20, p) for p in preimages):
        raise ValueError('a preimage is not 20 bytes of lowercase hex')
    _, state = public_state(prepared['publicStateJson'])
    if prepared['scriptHash'] != hashlib.sha256(bytes.fromhex(state['full_script_hex'])).hexdigest():
        raise ValueError("scriptHash is not the vault script's SHA-256")
    # Only the disclosed secrets are in the state; the pipeline fails on any other it reads.
    secrets = [[None] * CONFIG_A['n'] for _ in range(2)]
    for k, ((r, i), preimage) in enumerate(zip(slots, preimages)):
        if secp256k1.hash160(bytes.fromhex(preimage)).hex() != state['hors_commitments'][r][i]:
            raise ValueError(f"preimage {k} is not the preimage of round{r} index {i}'s commitment")
        secrets[r][i] = preimage
    try:
        raw, saved = run_assemble(json.dumps({**state, 'hors_secrets': secrets}), m, hit)
    except TypeError:
        raise ValueError('the solution signs with a secret round0 and round1 do not disclose') from None
    if [p for r in saved['rounds'] for p in r['preimages']] != preimages:
        raise ValueError('the solution does not sign with these preimages in this order')
    if unsigned(bytes.fromhex(raw)).hex() != prepared['transaction']:
        raise ValueError("the assembled transaction is not prepare's transaction")
    return raw
