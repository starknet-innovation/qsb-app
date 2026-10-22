"""Local proof harness guards; no wallet, network or paid compute."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fresh_core', ROOT/'ops/qualification/fresh-core-proof.py')
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class ProofGuards(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        previous = os.getcwd()
        try:
            with tempfile.TemporaryDirectory() as directory:
                os.chdir(directory)
                generated = json.loads(proof.bridge.generate())
        finally:
            os.chdir(previous)
        cls.public = {k: generated[k] for k in ('publicStateJson', 'scriptHex', 'scriptHash')}
        cls.public.update(scriptVersion=proof.SCRIPT_VERSION, manifest={
            'funding': {'txid': '11'*32, 'vout': 0, 'value': '100000'},
            'helper': {'txid': '22'*32, 'vout': 1, 'value': '10000'},
            'outputValue': '90000', 'fee': '20000', 'outputScript': '0014'+'33'*20})

    def test_public_export_has_no_recovery(self):
        result = proof.export(self.public, 'pinning')
        self.assertEqual(result['export']['scriptVersion'], proof.SCRIPT_VERSION)
        state = json.loads(result['request']['publicStateJson'])
        self.assertNotIn('hors_secrets', state)
        self.assertEqual(set(state['round_sigs'][0]), {'r', 's', 'sig'})
        self.assertEqual(set(result), {'request', 'export'})

    def test_version_mismatch_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Corrected public fixture'):
            proof.export_event({**self.public, 'scriptVersion': 'legacy'}, 'pinning')

    def test_script_mutation_rejected(self):
        state = json.loads(self.public['publicStateJson'])
        state['full_script_hex'] += '61'
        with self.assertRaises(ValueError):
            proof.export_event({**self.public, 'publicStateJson': json.dumps(state)}, 'pinning')

    def test_unsolved_pin_rejected(self):
        # Out of domain: always fails without probabilistic assumptions.
        with self.assertRaisesRegex(ValueError, 'CPU rejected pinning'):
            proof.check_pin(self.public, {'sequence': 0, 'locktime': 0})

    def test_helper_mutation_rejected(self):
        original = {'version': 1, 'locktime': 0, 'vout': [], 'vin': []}
        with self.assertRaises(AssertionError):
            proof.attach_helper_witness(original, {**original, 'version': 2})


if __name__ == '__main__':
    unittest.main()
