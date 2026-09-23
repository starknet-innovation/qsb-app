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
        cls.event = {'action':'export', 'publicStateJson':cls.generated['publicStateJson'], 'stage':'pinning',
            'manifest':{'funding':{'txid':'11'*32,'vout':0,'value':'100000'},'helper':{'txid':'22'*32,'vout':1,'value':'10000'},'outputValue':'90000','fee':'20000','outputScript':'0014'+'33'*20}}

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
            self.assertEqual(handler({**self.event,'action':'verify','stage':stage,'candidates':[candidate]}), {'valid':False})

    def test_pinning_reference_matches_recorded_gpu_hashes(self):
        # Native GPU traces are independent of the Python reference. This
        # catches the exported prefix-remainder being counted twice.
        sys.path.insert(0, str(ROOT / 'worker/validation'))
        from compare import check
        case = ROOT / 'docs/gpu-validation/fixtures/wpkh'
        lines = (ROOT / 'docs/gpu-validation/native/validation-logs/wpkh-pin.log').read_text().splitlines()
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'one-candidate.log'
            log.write_text('\n'.join(line for line in lines if line.startswith('TRACE_PIN seq=2147483648 lt=500000000 ')))
            self.assertEqual(check(log, case, 'pinning')['recoveredKeyHashes'], 2)

    def test_distinguishes_reproduced_unusable_der_from_a_gpu_mismatch(self):
        from unittest.mock import patch
        pin = 'sequence=2147483648\nlocktime=500000000\n'
        with patch('verify_hit.verify_pin', return_value=3):
            self.assertEqual(handler({**self.event,'action':'verify','candidates':[pin]}), {'valid':False,'derOnly':True})
            self.assertEqual(handler({**self.event,'action':'verify','candidates':[pin,'sequence=bad\n']}), {'valid':False})
        with patch('verify_hit.verify_pin', return_value=1):
            self.assertEqual(handler({**self.event,'action':'verify','candidates':[pin]}), {'valid':False})

    def test_rejects_duplicate_subset_indices(self):
        self.assertEqual(handler({**self.event,'action':'verify','stage':'round2','candidates':['indices=1,1,1,1,1,1,1,1,1\n']}), {'valid':False})

if __name__ == '__main__': unittest.main()
