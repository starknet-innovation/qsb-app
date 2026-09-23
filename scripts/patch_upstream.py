"""Explicit, reviewable corrections on top of the pinned upstream source."""
from pathlib import Path

def apply(root: Path):
    pipeline = root / 'config_a/pipeline/qsb_pipeline.py'
    text = pipeline.read_text()
    old = "    r1_sub = builder.build_round_script(0, h2b(state['round_sigs'][0]['sig']))\n    r2_sub = builder.build_round_script(1, h2b(state['round_sigs'][1]['sig']))"
    new = """    # QSB app patch: reproduce build_full_script's shared stack model.
    # Standalone round scripts omit the other round's live witness state.
    from bitcoin_tx import _StackModel
    model = _StackModel()
    builder._seed_witness(model, 1)
    builder._seed_witness(model, 0)
    model.push(('pin_kp',)); model.push(('pin_kn',))
    builder._model_pinning(model)
    r1_sub, _ = builder._emit_round(model, 0, h2b(state['round_sigs'][0]['sig']), builder._canonical_subset(0))
    r2_sub, _ = builder._emit_round(model, 1, h2b(state['round_sigs'][1]['sig']), builder._canonical_subset(1))"""
    if old in text:
        text = text.replace(old, new, 1)
        pipeline.write_text(text)
    elif new not in text:
        raise RuntimeError('Upstream exporter changed; re-review the layout patch')

    # DER syntax alone does not imply a recoverable ECDSA puzzle signature.
    curve = root / 'config_a/pipeline/secp256k1.py'
    curve_text = curve.read_text()
    helper = """def is_recoverable_der_sig(data):
    # QSB app: reject zero/out-of-range scalars and non-curve r values.
    if not is_valid_der_sig(data):
        return False
    size = data[3]
    r = int.from_bytes(data[4:4 + size], 'big')
    offset = 4 + size
    s = int.from_bytes(data[offset + 2:offset + 2 + data[offset + 1]], 'big')
    if not (1 <= r < N and 1 <= s < N):
        return False
    for x in (r, r + N):
        if x < P:
            y2 = (pow(x, 3, P) + 7) % P
            if pow(y2, (P - 1) // 2, P) == 1:
                return True
    return False


"""
    if 'def is_recoverable_der_sig(' not in curve_text:
        curve_text = curve_text.replace('def is_valid_der_sig(data):', helper + 'def is_valid_der_sig(data):', 1)
        curve.write_text(curve_text)
    text = pipeline.read_text()
    if 'is_recoverable_der_sig' not in text:
        text = text.replace('encode_der_sig, is_valid_der_sig, modinv', 'encode_der_sig, is_valid_der_sig, is_recoverable_der_sig, modinv', 1)
        start, end = text.index('def puzzle_hash('), text.index('\n\ndef ', text.index('def puzzle_hash('))
        text = text[:start] + text[start:end].replace('is_valid_der_sig(', 'is_recoverable_der_sig(') + text[end:]
        pipeline.write_text(text)
    verifier = root / 'config_a/verify/verify_hit.py'
    text = verifier.read_text()
    if 'is_recoverable_der_sig' not in text:
        text = text.replace('N as CURVE_N, P as CURVE_P, ecdsa_recover,', 'N as CURVE_N, P as CURVE_P, ecdsa_recover, is_recoverable_der_sig,', 1)
        text = text.replace('if valid and not found:', 'if valid and is_recoverable_der_sig(h) and not found:', 1)
        text = text.replace("hit = out['hit']", "hit = next((c for c in out['candidates'] if c['is_valid_der'] and is_recoverable_der_sig(c['puzzle_hash'])), None)", 1)
        verifier.write_text(text)

    text = verifier.read_text()
    old = '    print(f"  No CPU recovery produced a valid DER hash with this (locktime, seq).")'
    if 'DER_ONLY_UNUSABLE' not in text:
        if old not in text: raise RuntimeError('Pin rejection branch changed')
        text = text.replace(old, "    if any(c['valid_der'] for c in candidates):\n        return 3  # DER_ONLY_UNUSABLE: reproduced, but no puzzle key\n" + old, 1)
        old = "    if hit is None:\n        print()"
        if old not in text: raise RuntimeError('Digest rejection branch changed')
        text = text.replace(old, "    if hit is None and out['hit'] is not None:\n        return 3  # DER_ONLY_UNUSABLE\n" + old, 1)
        verifier.write_text(text)

    # The exported combined_suffix already contains the trailing prefix bytes.
    emulator = root / 'config_a/verify/gpu_emulator.py'
    text = emulator.read_text()
    old = "        preimage = pin_prefix + bytes(suffix)"
    new = "        preimage = pin_prefix[:params['midstate_blocks'] * 64] + bytes(suffix)"
    if old in text:
        emulator.write_text(text.replace(old, new, 1))
    elif new not in text:
        raise RuntimeError('Upstream pinning emulator changed; re-review prefix patch')

    # The production sighash already returns Core's uint256::ONE byte order.
    # Correct the stale independent test reference, not the production result.
    reference = root / 'config_a/verify/ref_sighash.py'
    text = reference.read_text().replace("return (1).to_bytes(32, 'big')", "return bytes.fromhex('01' + '00' * 31)")
    reference.write_text(text)

if __name__ == '__main__':
    apply(Path(__file__).resolve().parents[1] / 'vendor/qsb')
