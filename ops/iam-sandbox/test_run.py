"""Offline checks for run.py: git and AWS are mocked; nothing is created anywhere."""
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

HERE = Path(__file__).resolve().parent
ACCOUNT = '123456789012'
COMMIT = 'c' * 40


class SandboxRunner(unittest.TestCase):
    def run_sandbox(self, behaviour=None, fail=None, keep=False):
        """behaviour maps a step to the Lambda's result; defaults model the documented AWS evaluation."""
        self.calls, rows = [], set()
        defaults = {
            'denied-transaction': {'ok': False, 'code': 'AccessDeniedException'},
            'allowed-transaction': {'ok': True},
            'outpoint-put-again': {'ok': False, 'code': 'ConditionalCheckFailedException'},
            'outpoint-delete': {'ok': False, 'code': 'AccessDeniedException'},
            'denied-batch': {'ok': False, 'code': 'AccessDeniedException'},
        }
        results = {**defaults, **(behaviour or {})}

        def git(args, **kwargs):
            if args[1] == 'status': return ''
            if args[1:3] == ['rev-parse', 'HEAD']: return COMMIT + '\n'
            if args[1] == 'branch': return 'main\n'
            if args[1] == 'ls-remote': return COMMIT + '\trefs/heads/main\n'
            raise AssertionError(args)

        def aws(command, **kwargs):
            args = command[command.index('--no-cli-pager') + 1:]
            service, operation = args[:2]
            self.calls.append((service, operation))
            if (service, operation) == fail:
                return subprocess.CompletedProcess(command, 254, '', 'An error occurred (AccessDeniedException) x')
            opt = lambda flag: args[args.index(flag) + 1]
            out = {}
            if (service, operation) == ('sts', 'get-caller-identity'):
                out = {'Account': ACCOUNT, 'Arn': f'arn:aws:sts::{ACCOUNT}:assumed-role/qsb-operator/session'}
            elif (service, operation) == ('iam', 'put-role-policy'):
                self.role_policy = json.loads(opt('--policy-document'))
            elif (service, operation) == ('iam', 'create-role'):
                self.role_args = args
            elif (service, operation) == ('lambda', 'invoke'):
                step = json.loads(opt('--payload'))['step']
                result = results[step]
                # Model the effect of each outcome on the table, so row checks are meaningful.
                if step == 'allowed-transaction' and result.get('ok'):
                    rows.update({'OWNER#', 'OUTPOINT#'})
                if step == 'denied-transaction' and result.get('ok'):
                    rows.update({'OWNER#', 'SYSTEM#'})
                if step == 'denied-batch' and result.get('ok'):
                    rows.update({'OWNER#', 'SYSTEM#'})
                if step == 'outpoint-delete' and result.get('ok'):
                    rows.discard('OUTPOINT#')
                Path(args[-1]).write_text(json.dumps(result))
            elif (service, operation) == ('dynamodb', 'get-item'):
                pk = json.loads(opt('--key'))['pk']['S']
                out = {'Item': {}} if any(pk.startswith(p) for p in rows) else {}
            elif (service, operation) == ('dynamodb', 'delete-item'):
                pk = json.loads(opt('--key'))['pk']['S']
                rows.difference_update({p for p in list(rows) if pk.startswith(p)})
            return subprocess.CompletedProcess(command, 0, json.dumps(out), '')

        with tempfile.TemporaryDirectory() as tmp:
            evidence = Path(tmp) / 'evidence.json'
            argv = ['run.py', '--profile', 'public-test', '--evidence', str(evidence)] + (['--keep'] if keep else [])
            stdout = io.StringIO()
            try:
                with patch.object(sys, 'argv', argv), patch('subprocess.check_output', side_effect=git), \
                        patch('subprocess.run', side_effect=aws), patch('time.sleep'), contextlib.redirect_stdout(stdout):
                    runpy.run_path(str(HERE / 'run.py'), run_name='__main__')
            finally:
                self.report = json.loads(evidence.read_text()) if evidence.exists() else None
                self.output = stdout.getvalue()

    def deletes(self):
        return [c for c in self.calls if c[1].startswith('delete')]

    def test_documented_behaviour_passes_and_cleans_up(self):
        self.run_sandbox()
        self.assertTrue(self.report['passed'])
        self.assertEqual(len(self.report['checks']), 9)
        self.assertEqual({c[1] for c in self.deletes()},
                         {'delete-function', 'delete-log-group', 'delete-role-policy', 'delete-role', 'delete-table',
                          'delete-item'})
        self.assertNotIn(ACCOUNT, self.output)

    def test_role_gets_only_app_records_scoped_to_the_sandbox_table(self):
        self.run_sandbox()
        policy = json.loads((HERE.parents[1] / 'terraform/policies/app-records.json').read_text())
        self.assertEqual([dict(s, Resource=None) for s in self.role_policy['Statement']],
                         [dict(s, Resource=None) for s in policy])
        self.assertTrue(all(s['Resource'].startswith(f'arn:aws:dynamodb:eu-west-1:{ACCOUNT}:table/qsb-iam-sandbox-')
                            for s in self.role_policy['Statement']))
        self.assertIn('/qsb/runtime/', self.role_args)
        self.assertIn(f'arn:aws:iam::{ACCOUNT}:policy/qsb/bootstrap/qsb-runtime-boundary', self.role_args)

    def test_any_mismatch_fails_but_still_cleans_up(self):
        cases = {
            'allowed-transaction': {'ok': False, 'code': 'AccessDeniedException'},  # whole-transaction evaluation
            'denied-transaction': {'ok': True},                                        # SYSTEM# write allowed
            'outpoint-delete': {'ok': True},                                           # reservation deletable
            'denied-batch': {'ok': True},                                              # partial batch write
        }
        for step, result in cases.items():
            with self.subTest(step=step), self.assertRaisesRegex(SystemExit, 'do not loosen the policy'):
                self.run_sandbox({step: result})
            self.assertFalse(self.report['passed'])
            self.assertIn(('iam', 'delete-role'), self.calls)
            self.assertIn(('dynamodb', 'delete-table'), self.calls)

    def test_setup_failure_cleans_up_what_was_created(self):
        with self.assertRaisesRegex(SystemExit, 'put-role-policy failed'):
            self.run_sandbox(fail=('iam', 'put-role-policy'))
        self.assertIn(('iam', 'delete-role'), self.calls)
        self.assertIn(('dynamodb', 'delete-table'), self.calls)
        self.assertNotIn(('lambda', 'delete-function'), self.calls)
        self.assertFalse(self.report['passed'])

    def test_keep_leaves_resources(self):
        self.run_sandbox(keep=True)
        self.assertTrue(self.report['passed'])
        self.assertFalse([c for c in self.deletes() if c[1] != 'delete-item'])


if __name__ == '__main__':
    unittest.main()
