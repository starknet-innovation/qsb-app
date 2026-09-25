"""Offline bootstrap integration: no subprocess, network, credentials or IAM writes."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
COMMIT = 'a' * 40
ACCOUNT = '123456789012'
ARN = f'arn:aws:access-analyzer:eu-west-1:{ACCOUNT}:analyzer/qsb-external-access'


class BootstrapAnalyzerReadiness(unittest.TestCase):
    def bootstrap(self, existing, statuses=(), dry=False, *, responses_override=None, cli_failure=None):
        self.calls = []
        states = iter(statuses)
        last = 'CREATING'
        inventory = dict(account=ACCOUNT, region='eu-west-1',
            subject='repo:example/qsb:ref:refs/heads/main', state_bucket='qsb-test-state',
            distributions=['TESTCDN'], apis=['testapi'], origin_access_controls=['TESTOAC'],
            response_headers_policies=['TESTHEADERS'], operator_user='qsb-operator-user', gpu_vpc='vpc-0test')

        def git(args, **kwargs):
            if args[1] == 'status': return ''
            if args[1:3] == ['rev-parse', 'HEAD']: return COMMIT + '\n'
            if args[1] == 'branch': return 'ops/test\n'
            if args[1] == 'ls-remote': return COMMIT + '\trefs/heads/ops/test\n'
            self.fail(f'Unexpected command {args}')

        def aws(command, **kwargs):
            nonlocal last
            self.assertEqual(command[0], 'aws')
            start = command.index('--cli-read-timeout') + 2
            args = command[start:]
            service, operation = args[:2]
            self.calls.append((service, operation))
            responses = {
                ('sts', 'get-caller-identity'): {'Account': ACCOUNT},
                ('iam', 'list-roles'): {'Roles': []},
                ('iam', 'list-users'): {'Users': []},
                ('iam', 'list-policies'): {'Policies': [{'PolicyName': 'qsb-runtime-boundary'}]},
                ('iam', 'create-policy'): {'Policy': {'Arn': f'arn:aws:iam::{ACCOUNT}:policy/qsb/bootstrap/test'}},
                ('iam', 'create-user'): {},
                ('iam', 'attach-user-policy'): {},
                ('iam', 'put-user-policy'): {},
                ('iam', 'create-role'): {},
                ('iam', 'attach-role-policy'): {},
                ('accessanalyzer', 'list-analyzers'): {'analyzers': existing},
                ('accessanalyzer', 'create-analyzer'): {'arn': ARN},
            }
            key = (service, operation)
            if key == cli_failure:
                return subprocess.CompletedProcess(command, 254, '',
                    'An error occurred (AccessDeniedException) when calling the operation')
            if key in (responses_override or {}):
                response = responses_override[key]
            elif key == ('accessanalyzer', 'get-analyzer'):
                last = next(states, last)
                response = {'analyzer': {'arn': ARN, 'type': 'ACCOUNT', 'status': last}}
            else:
                if key not in responses:
                    self.fail(f'Unexpected AWS operation {key}')
                response = responses[key]
            return subprocess.CompletedProcess(command, 0, json.dumps(response), '')

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'inventory.json'
            path.write_text(json.dumps(inventory))
            argv = ['bootstrap_access.py', '--profile', 'public-test', '--inventory', str(path)]
            if not dry: argv.append('--apply')
            with patch.object(sys, 'argv', argv), patch('subprocess.check_output', side_effect=git), \
                    patch('subprocess.run', side_effect=aws), patch('analyzer_readiness.time.sleep'), \
                    contextlib.redirect_stdout(io.StringIO()):
                runpy.run_path(str(ROOT / 'bootstrap_access.py'), run_name='__main__')

    def assert_no_iam_mutations(self):
        allowed = {'list-roles', 'list-users', 'list-policies'}
        self.assertFalse([(s, op) for s, op in self.calls if s == 'iam' and op not in allowed])

    def test_inactive_existing_analyzer_blocks_before_any_iam_write(self):
        for status in ('DISABLED', 'FAILED', 'CREATING', 'UNKNOWN'):
            with self.subTest(status=status), self.assertRaisesRegex(SystemExit, 'not ACTIVE'):
                self.bootstrap([{'status': status}])
            self.assert_no_iam_mutations()
            self.assertNotIn(('accessanalyzer', 'create-analyzer'), self.calls)

    def test_active_existing_analyzer_allows_bootstrap_without_replacement(self):
        self.bootstrap([{'status': 'ACTIVE'}])
        self.assertIn(('iam', 'create-user'), self.calls)
        self.assertNotIn(('accessanalyzer', 'create-analyzer'), self.calls)
        self.assertLess(self.calls.index(('accessanalyzer', 'list-analyzers')), self.calls.index(('iam', 'create-policy')))

    def test_new_analyzer_waits_for_active_before_iam_creation(self):
        self.bootstrap([], ['CREATING', 'ACTIVE'])
        self.assertEqual(self.calls.count(('accessanalyzer', 'get-analyzer')), 2)
        self.assertLess(max(i for i, c in enumerate(self.calls) if c[0] == 'accessanalyzer'), self.calls.index(('iam', 'create-policy')))

    def test_pending_new_analyzer_has_bounded_polling_and_no_iam_writes(self):
        with self.assertRaisesRegex(SystemExit, 'remains pending'):
            self.bootstrap([], ['CREATING'])
        self.assertEqual(self.calls.count(('accessanalyzer', 'get-analyzer')), 20)
        self.assert_no_iam_mutations()

    def test_failed_new_analyzer_blocks_iam_creation(self):
        for status in ('FAILED', 'DISABLED', 'UNKNOWN'):
            with self.subTest(status=status), self.assertRaisesRegex(SystemExit, 'not ACTIVE'):
                self.bootstrap([], [status])
            self.assert_no_iam_mutations()
            self.assertEqual(self.calls.count(('accessanalyzer', 'get-analyzer')), 1)

    def test_missing_creation_identity_stops_before_iam_write(self):
        with self.assertRaisesRegex(SystemExit, 'creation returned no identity'):
            self.bootstrap([], responses_override={('accessanalyzer', 'create-analyzer'): {}})
        self.assert_no_iam_mutations()
        self.assertNotIn(('accessanalyzer', 'get-analyzer'), self.calls)

    def test_mismatched_created_analyzer_identity_stops_before_iam_write(self):
        for change in ({'arn': ARN + '-other'}, {'type': 'ORGANIZATION'}):
            response = {'arn': ARN, 'type': 'ACCOUNT', 'status': 'ACTIVE', **change}
            with self.subTest(change=change), self.assertRaisesRegex(SystemExit, 'identity mismatch'):
                self.bootstrap([], responses_override={('accessanalyzer', 'get-analyzer'): {'analyzer': response}})
            self.assert_no_iam_mutations()
            self.assertEqual(self.calls.count(('accessanalyzer', 'get-analyzer')), 1)

    def test_analyzer_cli_failures_stop_before_iam_write(self):
        for operation in ('list-analyzers', 'create-analyzer', 'get-analyzer'):
            with self.subTest(operation=operation), self.assertRaisesRegex(
                    SystemExit, f'accessanalyzer {operation} failed: AccessDeniedException; reconcile before retrying'):
                self.bootstrap([], cli_failure=('accessanalyzer', operation))
            self.assert_no_iam_mutations()
            self.assertEqual(self.calls[-1], ('accessanalyzer', operation))

    def test_existing_identity_clashes_stop_before_any_analyzer_call(self):
        clashes = [
            (('iam', 'list-roles'), {'Roles': [{'RoleName': 'qsb-operator'}]}),
            (('iam', 'list-users'), {'Users': [{'UserName': 'qsb-operator-user'}]}),
            (('iam', 'list-policies'), {'Policies': [{'PolicyName': 'qsb-runtime-boundary'},
                                                   {'PolicyName': 'qsb-gpu-boundary'}]}),
        ]
        for key, response in clashes:
            with self.subTest(key=key), self.assertRaisesRegex(SystemExit, 'Already exists, inspect before updating'):
                self.bootstrap([], responses_override={key: response})
            self.assert_no_iam_mutations()
            self.assertFalse([call for call in self.calls if call[0] == 'accessanalyzer'])

    def test_plan_does_not_create_or_inspect_analyzers(self):
        with self.assertRaises(SystemExit):
            self.bootstrap([], dry=True)
        self.assertEqual(self.calls, [('sts', 'get-caller-identity')])


if __name__ == '__main__': unittest.main()
