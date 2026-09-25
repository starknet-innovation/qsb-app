import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('preparation', ROOT / 'scripts/prepare-predeposit-iam.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
TABLE = 'arn:aws:dynamodb:eu-west-1:123456789012:table/qsb-disposable-iam'
ROLE = 'arn:aws:iam::123456789012:role/qsb-disposable-api-test'


class Preparation(unittest.TestCase):
    def test_exact_mixed_actions_and_consistent_reads(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'requests'
            manifest = module.prepare(TABLE, ROLE, target)
            read = lambda name: json.loads((target / (name + '.json')).read_text())
            denied = read('denied-transaction')['TransactItems']
            self.assertEqual([x['Put']['Item']['pk']['S'].split('#')[0] for x in denied], ['OWNER', 'SYSTEM'])
            allowed = read('allowed-transaction')['TransactItems']
            self.assertEqual([list(x)[0] for x in allowed], ['Put', 'Put', 'ConditionCheck'])
            self.assertTrue(allowed[2]['ConditionCheck']['Key']['pk']['S'].startswith('SYSTEM#'))
            self.assertEqual(read('duplicate-outpoint'), allowed[1]['Put'])
            batch = read('denied-batch')['RequestItems']['qsb-disposable-iam']
            self.assertEqual([x['PutRequest']['Item'] for x in batch], [x['Put']['Item'] for x in denied])
            for label in ('owner', 'system', 'outpoint'):
                self.assertIs(read('read-' + label)['ConsistentRead'], True)
            for name, digest in manifest['requestSha256'].items():
                self.assertEqual(hashlib.sha256((target / name).read_bytes()).hexdigest(), digest)
            self.assertIs(manifest['awsCallsPerformed'], False)
            observations = read('observations.template')
            self.assertEqual(observations['status'], 'NOT_RUN')
            self.assertIs(observations['depositAuthorized'], False)
            self.assertEqual(observations['nonce'], manifest['nonce'])
            self.assertEqual(observations['requestManifestSha256'], hashlib.sha256((target / 'manifest.json').read_bytes()).hexdigest())
            self.assertEqual(observations['steps']['allowed-transaction']['expectedItemPresence'],
                             {'owner': True, 'system': False, 'outpoint': True})
            self.assertEqual(observations['steps']['denied-batch']['expectedItemPresence'],
                             {'owner': False, 'system': False, 'outpoint': True})
            for step in observations['steps'].values():
                self.assertIsNone(step['observedItemPresence'])
                self.assertIsNone(step['exitCode'])
                self.assertIsNone(step['serviceErrorCode'])
                self.assertEqual(step['evidenceFileSha256'], {})

    def test_refuses_existing_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileExistsError): module.prepare(TABLE, ROLE, Path(tmp))

    def test_refuses_cross_account_before_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / 'requests'
            with self.assertRaises(ValueError): module.prepare(TABLE, ROLE.replace('123456789012', '222222222222'), dest)
            self.assertFalse(dest.exists())

    def test_fresh_nonce_for_each_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = module.prepare(TABLE, ROLE, Path(tmp) / 'a')
            second = module.prepare(TABLE, ROLE, Path(tmp) / 'b')
            self.assertNotEqual(first['nonce'], second['nonce'])


if __name__ == '__main__': unittest.main()
