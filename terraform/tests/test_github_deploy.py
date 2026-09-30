"""Offline checks that the deploy workflow's helpers never let identifying values into the public Actions log."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import github_deploy as gd  # noqa: E402

ACCOUNT = '123456789012'
ROLE = f'arn:aws:iam::{ACCOUNT}:role/qsb/bootstrap/qsb-operator'
QUEUE = f'arn:aws:batch:eu-west-2:{ACCOUNT}:job-queue/qsb-gpu'
LEAKS = [ACCOUNT, 'arn:aws', 'EXAMPLEDIST123', 'd111111abcdef8.cloudfront.net', 'a1b2c3d4e5', 'test-state-bucket']


def plan():
    return {
        'variables': {'mainnet_enabled': {'value': True}, 'exact_submit_enabled': {'value': False},
                      'network': {'value': 'mainnet'}, 'batch_job_queue': {'value': QUEUE}},
        'resource_changes': [
            {'address': 'aws_lambda_function.app["api"]', 'mode': 'managed', 'type': 'aws_lambda_function',
             'change': {'actions': ['update'],
                        'before': {'environment': [{'variables': {'QSB_MAINNET_ENABLED': 'false', 'QUEUE': QUEUE}}],
                                   'tags': {'SourceCommit': 'a'}},
                        'after': {'environment': [{'variables': {'QSB_MAINNET_ENABLED': 'true', 'QUEUE': QUEUE}}],
                                  'tags': {'SourceCommit': 'b'}},
                        'after_unknown': {'last_modified': True}}},
            {'address': 'aws_dynamodb_table.records', 'mode': 'managed', 'type': 'aws_dynamodb_table',
             'change': {'actions': ['update'], 'before': {'tags': {'SourceCommit': 'a'}},
                        'after': {'tags': {'SourceCommit': 'b'}}, 'after_unknown': {}}},
            {'address': f'aws_iam_role_policy.reconcile["{ROLE}"]', 'mode': 'managed', 'type': 'aws_iam_role_policy',
             'change': {'actions': ['delete', 'create'], 'before': {'role': ROLE}, 'after': {'role': ROLE},
                        'after_unknown': {}}},
            {'address': 'aws_cloudfront_distribution.web', 'mode': 'managed', 'type': 'aws_cloudfront_distribution',
             'change': {'actions': ['no-op'], 'before': {'id': 'EXAMPLEDIST123'}, 'after': {'id': 'EXAMPLEDIST123'}}},
            {'address': 'data.aws_partition.current', 'mode': 'data', 'type': 'aws_partition',
             'change': {'actions': ['read'], 'before': None, 'after': {}}},
        ],
    }


class Redaction(unittest.TestCase):
    def test_identifying_values_are_redacted(self):
        text = (f'Error: AccessDenied: User: arn:aws:sts::{ACCOUNT}:assumed-role/qsb-github-deploy/x is not authorized '
                'on distribution EXAMPLEDIST123 (d111111abcdef8.cloudfront.net), '
                'https://a1b2c3d4e5.execute-api.eu-west-2.amazonaws.com and /apis/a1b2c3d4e5, '
                's3://test-state-bucket/qsb/main/terraform.tfstate, '
                'aws_lambda_function.app["api"]: Modifications complete after 2s [id=qsb-app-api], '
                'request 0f8fad5b-d9cb-469f-a165-70867728950e, key ASIAABCDEFGHIJKLMNOP')
        out = gd.redact(text, [])
        for leak in LEAKS + ['qsb-app-api', '0f8fad5b', 'ASIAABCDEFGHIJKLMNOP']:
            self.assertNotIn(leak, out)
        self.assertIn('is not authorized', out)
        self.assertIn('aws_lambda_function.app["api"]', out)

    def test_recorded_literals_are_redacted_first(self):
        self.assertEqual(gd.redact('bucket my-state-bucket and qsb-app', ['my-state-bucket']),
                         'bucket <redacted> and qsb-app')

    def test_masks_cover_arns_and_ids_but_not_plain_settings(self):
        with tempfile.TemporaryDirectory() as d:
            tfvars, record = Path(d, 'app.tfvars.json'), Path(d, 'redact.txt')
            tfvars.write_text(json.dumps({
                'aws_account_id': ACCOUNT, 'name': 'qsb-app', 'region': 'eu-west-2', 'network': 'mainnet',
                'operator_principal_arns': [ROLE], 'batch_job_queue': QUEUE, 'mainnet_enabled': True,
                'iam_role_path': '/qsb/runtime/', 'batch_job_bucket': f'qsb-gpu-{ACCOUNT}-eu-west-2-jobs'}))
            os.environ['QSB_REDACT_FILE'] = str(record)
            try:
                lines = gd.masks(tfvars)
                recorded = gd.literals()
            finally:
                del os.environ['QSB_REDACT_FILE']
        masked = {l.removeprefix('::add-mask::') for l in lines}
        self.assertTrue(all(l.startswith('::add-mask::') for l in lines))
        self.assertTrue({ACCOUNT, ROLE, QUEUE, f'qsb-gpu-{ACCOUNT}-eu-west-2-jobs', '/qsb/runtime/'} <= masked)
        self.assertFalse({'qsb-app', 'eu-west-2', 'mainnet'} & masked)
        self.assertEqual(set(recorded), masked)


class Summary(unittest.TestCase):
    def setUp(self):
        self.out = gd.summary(plan(), 'abc1234', 'f' * 64)

    def test_summary_names_changes_without_values(self):
        for leak in LEAKS + ['job-queue/qsb-gpu', "'true'", 'SourceCommit\': \'b']:
            self.assertNotIn(leak, self.out)
        self.assertIn('`environment[0].variables.QSB_MAINNET_ENABLED`', self.out)
        self.assertIn('`last_modified`', self.out)
        self.assertNotIn('QUEUE', self.out)

    def test_switches_are_shown_and_other_variables_are_not(self):
        self.assertIn('| `mainnet_enabled` | `true` |', self.out)
        self.assertIn('| `exact_submit_enabled` | `false` |', self.out)
        self.assertNotIn('batch_job_queue', self.out)

    def test_tag_only_updates_and_replacements(self):
        self.assertIn('Tags only: 1 × `aws_dynamodb_table`.', self.out)
        self.assertNotIn('aws_dynamodb_table.records', self.out)
        self.assertIn('**0 destroyed and 1 replaced: check these before approving.**', self.out)
        self.assertIn('aws_iam_role_policy.reconcile["<arn>"]', self.out)
        self.assertIn('1 replace, 2 update', self.out)
        self.assertNotIn('aws_cloudfront_distribution.web', self.out)
        self.assertNotIn('aws_partition', self.out)

    def test_no_changes(self):
        self.assertIn('No changes.', gd.summary({'resource_changes': [], 'variables': {}}))


class Approval(unittest.TestCase):
    def test_only_required_reviewers_count(self):
        self.assertEqual(gd.approvers({'protection_rules': [
            {'type': 'wait_timer', 'wait_timer': 5},
            {'type': 'required_reviewers', 'reviewers': [{'type': 'User', 'reviewer': {'login': 'owner'}}]}]}), 1)
        self.assertEqual(gd.approvers({'protection_rules': [{'type': 'branch_policy'}]}), 0)
        self.assertEqual(gd.approvers({'protection_rules': [{'type': 'required_reviewers', 'reviewers': []}]}), 0)
        self.assertEqual(gd.approvers({'name': 'qsb-deploy'}), 0)
        self.assertEqual(gd.approvers(None), 0)


class Run(unittest.TestCase):
    def test_failure_prints_only_the_redacted_errors(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d, 'plan.log')
            script = (f'print("Refreshing state... [id={ROLE}]"); '
                      f'print("Error: AccessDenied for arn:aws:iam::{ACCOUNT}:role/x"); print(""); '
                      'print("  with aws_sfn_state_machine.withdrawal,"); raise SystemExit(1)')
            out = subprocess.run([sys.executable, str(Path(gd.__file__)), 'run', str(log), '--',
                                  sys.executable, '-c', script], capture_output=True, text=True)
            self.assertEqual(out.returncode, 1)
            self.assertIn(ROLE, log.read_text())
        self.assertNotIn(ACCOUNT, out.stdout)
        self.assertNotIn('Refreshing state', out.stdout)
        self.assertIn('Error: AccessDenied for <arn>', out.stdout)
        self.assertIn('with aws_sfn_state_machine.withdrawal', out.stdout)

    def test_failure_shows_only_this_commands_output(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d, 'fetch.log')
            log.write_text('$ earlier\nError: an earlier failure that was handled\n')
            out = subprocess.run([sys.executable, str(Path(gd.__file__)), 'run', str(log), '--',
                                  sys.executable, '-c', 'print("Error: this one"); raise SystemExit(3)'],
                                 capture_output=True, text=True)
        self.assertEqual(out.returncode, 3)
        self.assertIn('Error: this one', out.stdout)
        self.assertNotIn('earlier failure', out.stdout)

    def test_success_prints_nothing_and_ok_codes_pass_through(self):
        with tempfile.TemporaryDirectory() as d:
            out = subprocess.run([sys.executable, str(Path(gd.__file__)), 'run', str(Path(d, 'plan.log')),
                                  '--ok', '0,2', '--', sys.executable, '-c', f'print("{ACCOUNT}"); raise SystemExit(2)'],
                                 capture_output=True, text=True)
        self.assertEqual((out.returncode, out.stdout), (2, ''))


if __name__ == '__main__':
    unittest.main()
