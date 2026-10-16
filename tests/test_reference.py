"""Real pinned exporter and negative candidate verification, without GPU cost."""
import base64
import hashlib
import json
from pathlib import Path
import sys
import unittest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'worker/cpu'))
sys.path.insert(0, str(ROOT / 'public/qsb'))
from handler import handler
import bridge
from bitcoin_tx import SCRIPT_VERSION, LEGACY_SCRIPT_VERSION, classify_qsb_script
import tempfile
import os

class ReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        previous = os.getcwd()
        try:
            with tempfile.TemporaryDirectory() as directory:
                os.chdir(directory)
                cls.generated = json.loads(bridge.generate())
        finally:
            os.chdir(previous)
        cls.event = {'scriptVersion': SCRIPT_VERSION, 'action':'export', 'publicStateJson':cls.generated['publicStateJson'], 'stage':'pinning',
            'manifest':{'funding':{'txid':'11'*32,'vout':0,'value':'100000'},'helper':{'txid':'22'*32,'vout':1,'value':'10000'},'outputValue':'90000','fee':'20000','outputScript':'0014'+'33'*20}}

    def test_relaxed_puzzle_round1_replay_old_and_corrected(self):
        import subprocess
        for args in ([], ['--legacy']):
            result = subprocess.run([sys.executable, str(ROOT/'tests/round_binding_replay.py'), *args],
                capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('COMPONENT REGRESSION: PASS', result.stdout)

    def test_round_binding_and_legacy_readonly_roundtrip(self):
        from bitcoin_tx import QSBScriptBuilder, _StackModel, OP_CHECKMULTISIG, OP_CHECKMULTISIGVERIFY
        state = json.loads(self.generated['stateJson'])
        self.assertEqual(classify_qsb_script(state), SCRIPT_VERSION)
        builder = QSBScriptBuilder(150, 8, 1, 7, 2, hash_mode='sha256')
        builder.hors_commitments = [[bytes.fromhex(c) for c in r] for r in state['hors_commitments']]
        builder.dummy_sigs = [[bytes.fromhex(s) for s in r] for r in state['dummy_sigs']]
        signatures = [bytes.fromhex(r['sig']) for r in state['round_sigs']]
        def rounds(terminal):
            m = _StackModel()
            builder._seed_witness(m, 1); builder._seed_witness(m, 0)
            m.push(('pin_kp',)); m.push(('pin_kn',)); builder._model_pinning(m)
            first, _ = builder._emit_round(m, 0, signatures[0], builder._canonical_subset(0), terminal=terminal)
            second, _ = builder._emit_round(m, 1, signatures[1], builder._canonical_subset(1), terminal=True)
            return first, second
        first, second = rounds(False)
        old_first, old_second = rounds(True)
        self.assertEqual(first[-1], OP_CHECKMULTISIGVERIFY)
        self.assertEqual(second[-1], OP_CHECKMULTISIG)
        self.assertNotEqual(second, old_second)  # live stack depths must change too
        pin = builder.build_pinning_script(bytes.fromhex(state['pin_sig']))
        self.assertEqual((pin + first + second).hex(), state['full_script_hex'])
        old = {**state, 'full_script_hex': (pin + old_first + old_second).hex()}
        del old['scriptVersion']
        self.assertEqual(classify_qsb_script(old), LEGACY_SCRIPT_VERSION)
        self.assertEqual(bridge.validate(json.dumps(old)), hashlib.sha256(pin + old_first + old_second).hexdigest())
        with self.assertRaisesRegex(ValueError, 'Legacy script'):
            bridge.assemble(json.dumps(old), '{}', '{}')
        public = {k:v for k,v in old.items() if k in bridge.PUBLIC_FIELDS}
        public['round_sigs'] = [{k:r[k] for k in ('r','s','sig')} for r in old['round_sigs']]
        with self.assertRaisesRegex(ValueError, 'Legacy script'):
            handler({**self.event, 'publicStateJson': json.dumps(public)})
        for obj, label in ((state, LEGACY_SCRIPT_VERSION), (old, SCRIPT_VERSION)):
            with self.assertRaisesRegex(ValueError, 'version does not match'):
                classify_qsb_script({**obj, 'scriptVersion':label})
        with self.assertRaisesRegex(ValueError, 'script mismatch'):
            classify_qsb_script({**state, 'full_script_hex': state['full_script_hex'] + '61'})
        self.assertEqual(bridge.validate(self.generated['stateJson']), self.generated['scriptHash'])

    def test_corrected_export_matches_independent_transaction_and_find_delete(self):
        import contextlib
        import io
        from types import SimpleNamespace
        import qsb_pipeline as pipeline
        from bitcoin_tx import Transaction, TxIn, TxOut, find_and_delete
        from gpu_emulator import emulate_digest_round
        state = json.loads(self.generated['publicStateJson'])
        script = bytes.fromhex(state['full_script_hex'])
        old_cwd, old_encoder = os.getcwd(), pipeline.p2pkh_script
        try:
            with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
                os.chdir(tmp)
                Path('qsb_state.json').write_text(self.generated['publicStateJson'])
                pipeline.p2pkh_script = lambda _: bytes.fromhex('0014' + '33'*20)
                pipeline.cmd_export(SimpleNamespace(funding_txid='11'*32, funding_vout=0, funding_value=100000,
                    extra_input_txid='22'*32, extra_input_vout=1, extra_input_value=10000,
                    extra_input_sequence=0xfffffffe, version=1, sequence=0x80000000,
                    locktime=500000000, output_value=90000, output_address='00'*20))
                for ri in range(2):
                    params = json.loads(Path(f'gpu_digest_r{ri+1}_params.json').read_text())
                    for subset in (list(range(9)), list(range(141,150)), [0,3,11,38,64,71,98,132,149]):
                        for sequence, locktime in ((0x80000000,500000000),(0xffffffff,1744600000)):
                            with self.subTest(round=ri, subset=subset, sequence=sequence):
                                expected = find_and_delete(script, bytes.fromhex(state['round_sigs'][ri]['sig']))
                                for idx in subset:
                                    expected = find_and_delete(expected, bytes.fromhex(state['dummy_sigs'][ri][idx]))
                                tx = Transaction(version=1, locktime=locktime)
                                tx.add_input(TxIn(bytes.fromhex('22'*32),1,b'',0xfffffffe))
                                tx.add_input(TxIn(bytes.fromhex('11'*32),0,b'',sequence))
                                tx.add_output(TxOut(90000,bytes.fromhex('0014'+'33'*20)))
                                actual = emulate_digest_round(params, subset, sequence=sequence, locktime=locktime)
                                self.assertEqual(actual['scriptcode'], expected)
                                self.assertEqual(actual['sighash'], tx.sighash(1, expected, 1).to_bytes(32,'big'))
        finally:
            pipeline.p2pkh_script = old_encoder
            os.chdir(old_cwd)

    def test_request_version_is_required_and_result_bound(self):
        for version in (None, LEGACY_SCRIPT_VERSION, 'unknown'):
            with self.assertRaisesRegex(ValueError, 'request script version'):
                handler({**self.event, 'scriptVersion':version})
        self.assertEqual(handler(self.event)['scriptVersion'], SCRIPT_VERSION)

    def test_der_syntax_is_not_enough_for_a_puzzle(self):
        from secp256k1 import encode_der_sig, is_valid_der_sig, is_recoverable_der_sig, ecdsa_recover, ecdsa_verify, N, P
        for r, scalar in ((0,1),(1,0),(N,1),(1,N)):
            encoded = encode_der_sig(r, scalar)
            self.assertTrue(is_valid_der_sig(encoded))
            self.assertFalse(is_recoverable_der_sig(encoded))
        good = next(r for r in range(1,100) if is_recoverable_der_sig(encode_der_sig(r,1)))
        bad = next(r for r in range(1,100) if not is_recoverable_der_sig(encode_der_sig(r,1)))
        self.assertTrue(is_valid_der_sig(encode_der_sig(bad,1)))
        point = ecdsa_recover(good,1,123456,0)
        self.assertTrue(ecdsa_verify(point,123456,good,1))
        self.assertFalse(is_recoverable_der_sig(b""))

    def test_exports_real_binary_for_all_stages(self):
        for stage in ('pinning','round1','round2'):
            result = handler({**self.event, 'stage':stage})
            raw = base64.b64decode(result['parameterBase64'])
            self.assertGreater(len(raw), 64)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), result['parameterSha256'])

    def test_refuses_private_state(self):
        with self.assertRaises(ValueError):
            handler({**self.event,'publicStateJson':self.generated['stateJson']})

    def test_does_not_accept_unverified_candidates(self):
        for stage, candidate in [('pinning','sequence=2147483648\nlocktime=500000000\n'), ('round1','indices=1,2,3,4,5,6,7,8,9\n')]:
            self.assertEqual(handler({**self.event,'action':'verify','stage':stage,'candidates':[candidate]}), {'scriptVersion': SCRIPT_VERSION, 'valid':False})

    def test_pinning_reference_matches_full_transaction_at_every_prefix_alignment(self):
        # Public synthetic transaction, not a funded fixture or GPU observation.
        # Independently serialize the full sighash message: the optimized-format
        # suffix already contains the prefix remainder and must count it once.
        import struct
        from bitcoin_tx import Transaction, TxIn, TxOut, serialize_varint
        from gpu_emulator import emulate_pinning
        from secp256k1 import Gx, P, ecdsa_verify
        alignments = set()
        for padding in range(64):
            with self.subTest(padding=padding):
                script = b"\x61" * padding + b"\x51"
                tx = Transaction(version=1, locktime=500000000)
                tx.add_input(TxIn(bytes.fromhex('11' * 32), 1, b'', 0xfffffffe))
                tx.add_input(TxIn(bytes.fromhex('22' * 32), 0, script, 0x80000000))
                tx.add_output(TxOut(90000, bytes.fromhex('0014' + '33' * 20)))
                preimage = tx.serialize() + struct.pack('<I', 1)
                prefix_length = 4 + 1 + len(tx.inputs[0].serialize()) + 32 + 4 + len(serialize_varint(len(script))) + len(script)
                prefix = preimage[:prefix_length]
                blocks, remainder = divmod(len(prefix), 64)
                alignments.add(remainder)
                suffix = preimage[blocks * 64:]
                params = {'pin_prefix': prefix.hex(), 'combined_suffix': suffix.hex(),
                    'midstate_blocks': blocks, 'seq_offset': remainder,
                    'lt_offset': len(suffix) - 8, 'total_preimage_len': len(preimage),
                    'pin_r': Gx, 'pin_s': 1, 'hash_mode': 'sha256'}
                tx.inputs[1].sequence = 0x80000010
                tx.locktime = 500000073
                expected_preimage = tx.serialize() + struct.pack('<I', 1)
                expected_hash = tx.sighash(1, script, 1).to_bytes(32, 'big')
                result = emulate_pinning(params, tx.locktime, sequence=tx.inputs[1].sequence)
                self.assertEqual(result['preimage'], expected_preimage)
                self.assertEqual(result['sighash'], expected_hash)
                self.assertEqual(len(result['candidates']), 2)
                self.assertEqual({c['recid'] for c in result['candidates']}, {0, 1})
                for candidate in result['candidates']:
                    pubkey = candidate['pubkey']
                    x = int.from_bytes(pubkey[1:], 'big')
                    y = pow((pow(x, 3, P) + 7) % P, (P + 1) // 4, P)
                    if y % 2 != pubkey[0] % 2:
                        y = P - y
                    self.assertTrue(ecdsa_verify((x, y), int.from_bytes(expected_hash, 'big'), Gx, 1))
                    self.assertEqual(candidate['puzzle_hash'], hashlib.sha256(pubkey).digest())
        self.assertEqual(alignments, set(range(64)))

    def test_distinguishes_reproduced_unusable_der_from_a_gpu_mismatch(self):
        from unittest.mock import patch
        pin = 'sequence=2147483648\nlocktime=500000000\n'
        with patch('verify_hit.verify_pin', return_value=3):
            self.assertEqual(handler({**self.event,'action':'verify','candidates':[pin]}), {'scriptVersion': SCRIPT_VERSION, 'valid':False,'derOnly':True})
            self.assertEqual(handler({**self.event,'action':'verify','candidates':[pin,'sequence=bad\n']}), {'scriptVersion': SCRIPT_VERSION, 'valid':False})
        with patch('verify_hit.verify_pin', return_value=1):
            self.assertEqual(handler({**self.event,'action':'verify','candidates':[pin]}), {'scriptVersion': SCRIPT_VERSION, 'valid':False})

    def test_rejects_duplicate_subset_indices(self):
        self.assertEqual(handler({**self.event,'action':'verify','stage':'round2','candidates':['indices=1,1,1,1,1,1,1,1,1\n']}), {'scriptVersion': SCRIPT_VERSION, 'valid':False})

if __name__ == '__main__': unittest.main()
