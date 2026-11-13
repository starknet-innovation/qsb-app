"""Public-data and native-receipt gates; local subprocesses only."""
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[2]


def fixture(mode, directory, *extra):
    return subprocess.run(['node', '--import', 'tsx', 'ops/pqb-serving/fixture.ts', mode, str(directory), *extra],
        cwd=ROOT, env={**os.environ, 'QSB_NETWORK': 'mainnet'}, text=True, capture_output=True, timeout=30)


class FixtureTests(unittest.TestCase):
    def test_only_the_generated_public_fixture_is_accepted(self):
        with TemporaryDirectory() as directory:
            d = Path(directory)
            self.assertEqual(fixture('prepare', d).returncode, 0)
            self.assertEqual(fixture('validate', d).returncode, 0)
            raw = (d / 'public-fixture.json').read_text()
            self.assertNotIn('"seed"', raw)
            data = json.loads(raw)
            data['rows'][1]['job']['privateKey'] = 'must never enter cloud input'
            (d / 'public-fixture.json').write_text(json.dumps(data))
            self.assertNotEqual(fixture('validate', d).returncode, 0)

    def test_empty_native_inventory_cannot_pass(self):
        with TemporaryDirectory() as directory:
            d = Path(directory)
            self.assertEqual(fixture('prepare', d).returncode, 0)
            (d / 'objects').mkdir()
            (d / 'native-index-1.json').write_text(json.dumps({'jobs': []}))
            result = fixture('audit', d, 'native-index-1.json')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Native success receipts or image binding missing', result.stderr)
            self.assertEqual(list(d.glob('native-accounting-audit-*')), [])

    def test_unexpected_failure_cannot_hide_behind_a_success(self):
        with TemporaryDirectory() as directory:
            d = Path(directory)
            self.assertEqual(fixture('prepare', d).returncode, 0)
            data = json.loads((d / 'public-fixture.json').read_text())
            index = {'image': data['descriptor']['image'], 'jobs': [
                {'jobId': 'success', 'status': 'SUCCEEDED'},
                {'jobId': 'failed', 'status': 'FAILED', 'statusReason': 'Essential container in task exited'}]}
            (d / 'native-index-1.json').write_text(json.dumps(index))
            result = fixture('audit', d, 'native-index-1.json')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Unexpected native failure', result.stderr)
            self.assertEqual(list(d.glob('native-accounting-audit-*')), [])

    def test_success_without_a_native_output_cannot_pass(self):
        with TemporaryDirectory() as directory:
            d = Path(directory)
            self.assertEqual(fixture('prepare', d).returncode, 0)
            data = json.loads((d / 'public-fixture.json').read_text())
            image = data['descriptor']['image']
            queue = 'arn:aws:batch:eu-west-2:123456789012:job-queue/qsb-gpu-validation'
            (d / 'campaign.json').write_text(json.dumps({'queue': queue}))
            index = {'image': image, 'definition': 'test:1', 'jobs': [{'jobId': 'test', 'status': 'SUCCEEDED',
                'jobDefinition': 'test:1', 'jobQueue': queue, 'container': {'image': image, 'environment': []}}]}
            (d / 'objects').mkdir()
            (d / 'native-index-1.json').write_text(json.dumps(index))
            result = fixture('audit', d, 'native-index-1.json')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Successful native job receipt missing', result.stderr)
            index['jobs'][0]['jobQueue'] = queue + '-other'
            (d / 'native-index-2.json').write_text(json.dumps(index))
            result = fixture('audit', d, 'native-index-2.json')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Native Batch image/revision mismatch', result.stderr)


if __name__ == '__main__':
    unittest.main()
