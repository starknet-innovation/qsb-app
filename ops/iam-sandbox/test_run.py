"""Offline checks for run.py and handler.py: git and AWS are mocked; nothing is created anywhere."""
import contextlib
import importlib
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
ACCOUNT = '123456789012'
COMMIT = 'c' * 40
APP_DENY = {'ok': False, 'code': 'AccessDeniedException', 'denial': 'explicit-deny-identity'}


class SandboxRunner(unittest.TestCase):
    def run_sandbox(self, behaviour=None, fail=None, keep=False, function_error=None, propagation=0,
                    delete_fails=(), leaky=(), interrupt=None):
        """behaviour maps a step to the Lambda's result; defaults model the documented AWS evaluation.
        The mock table applies each step's effect, so the runner's row reads see what really happened."""
        self.calls, self.gets, self.deleted_names, rows = [], [], [], set()
        results = {'control-owner-put': {'ok': True}, 'denied-transaction': APP_DENY,
                   'allowed-transaction': {'ok': True},
                   'outpoint-put-again': {'ok': False, 'code': 'ConditionalCheckFailedException'},
                   'outpoint-delete': APP_DENY, 'denied-batch': APP_DENY, **(behaviour or {})}
        effects = {'control-owner-put': {'OWNER#'}, 'denied-transaction': {'OWNER#', 'SYSTEM#'},
                   'allowed-transaction': {'OWNER#', 'OUTPOINT#'}, 'denied-batch': {'OWNER#', 'SYSTEM#'}}
        pending = {'propagation': propagation}

        def git(args, **kwargs):
            if args[1] == 'status': return ''
            if args[1:3] == ['rev-parse', 'HEAD']: return COMMIT + '\n'
            if args[1] == 'branch': return 'main\n'
            if args[1] == 'ls-remote': return COMMIT + '\trefs/heads/main\n'
            raise AssertionError(args)

        def error(command, code):
            return subprocess.CompletedProcess(command, 254, '', f'An error occurred ({code}) when calling')

        def aws(command, **kwargs):
            args = command[command.index('--no-cli-pager') + 1:]
            service, operation = args[:2]
            self.calls.append((service, operation))
            if (service, operation) == interrupt:
                raise KeyboardInterrupt
            if (service, operation) == fail:
                return error(command, 'AccessDeniedException')
            if operation in delete_fails:
                return error(command, 'AccessDeniedException')
            opt = lambda flag: args[args.index(flag) + 1]
            out = {}
            if operation.startswith('delete') and operation != 'delete-item':
                self.deleted_names.append(next(args[i + 1] for i, x in enumerate(args)
                                               if x in ('--function-name', '--role-name', '--table-name',
                                                        '--log-group-name')))
            if (service, operation) == ('sts', 'get-caller-identity'):
                out = {'Account': ACCOUNT, 'Arn': f'arn:aws:sts::{ACCOUNT}:assumed-role/qsb-operator/adrien-session'}
            elif (service, operation) == ('iam', 'create-role'):
                self.role_args = args
            elif (service, operation) == ('iam', 'put-role-policy'):
                self.role_policy = json.loads(opt('--policy-document'))
            elif (service, operation) == ('lambda', 'create-function'):
                if pending['propagation']:
                    pending['propagation'] -= 1
                    return error(command, 'InvalidParameterValueException')
            elif (service, operation) == ('lambda', 'invoke'):
                step = json.loads(opt('--payload'))['step']
                if step == function_error:
                    return subprocess.CompletedProcess(command, 0, json.dumps({'FunctionError': 'Unhandled'}), '')
                result = results[step]
                if step in leaky:  # a table that writes despite the denial, to prove the row checks stand alone
                    rows.update(effects.get(step, set()))
                if result.get('ok'):
                    rows.update(effects.get(step, set()))
                    if step == 'outpoint-put-again':
                        rows.add('OUTPOINT#')
                    if step == 'outpoint-delete':
                        rows.discard('OUTPOINT#')
                Path(args[-1]).write_text(json.dumps(result))
            elif (service, operation) == ('dynamodb', 'get-item'):
                self.gets.append('--consistent-read' in args)
                pk = json.loads(opt('--key'))['pk']['S']
                out = {'Item': {}} if any(pk.startswith(p) for p in rows) else {}
            elif (service, operation) == ('dynamodb', 'delete-item'):
                pk = json.loads(opt('--key'))['pk']['S']
                rows.difference_update({p for p in list(rows) if pk.startswith(p)})
            elif (service, operation) == ('logs', 'delete-log-group'):
                return error(command, 'ResourceNotFoundException')  # the role can't log, so none exists
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
                self.evidence_text = evidence.read_text() if evidence.exists() else ''
                self.report = json.loads(self.evidence_text) if self.evidence_text else None
                self.output = stdout.getvalue()

    def check(self, label):
        return next(c for c in self.report['checks'] if c['check'].startswith(label))

    def test_documented_behaviour_passes_and_cleans_up(self):
        self.run_sandbox()
        self.assertTrue(self.report['passed'])
        self.assertEqual(len(self.report['checks']), 10)
        self.assertEqual(self.report['cleanup'], {'function': 'deleted', 'role-policy': 'deleted', 'role': 'deleted',
                                                  'table': 'deleted'})
        self.assertTrue(self.report['cleanupComplete'])
        self.assertTrue(self.gets and all(self.gets), 'every row read must be a consistent read')

    def test_no_account_number_or_session_name_leaves_the_run(self):
        self.run_sandbox()
        for text in (self.output, self.evidence_text):
            self.assertNotIn(ACCOUNT, text)
            self.assertNotIn('adrien-session', text)

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
        boundary = {'ok': False, 'code': 'AccessDeniedException', 'denial': 'no-boundary-allow'}
        cases = {
            'allowed-transaction': boundary,                            # the ConditionCheckItem boundary gap
            'denied-transaction': {'ok': True},                         # SYSTEM# write allowed
            'outpoint-put-again': {'ok': True},                         # the creation guard is missing
            'outpoint-delete': {'ok': True},                            # reservation deletable
            'denied-batch': {'ok': True},                               # partial batch write
        }
        for step, result in cases.items():
            with self.subTest(step=step), self.assertRaisesRegex(SystemExit, 'do not loosen the app policy'):
                self.run_sandbox({step: result})
            self.assertFalse(self.report['passed'])
            self.assertTrue(self.report['cleanupComplete'])

    def test_a_denial_from_the_boundary_is_not_an_app_policy_denial(self):
        for reason in ('no-boundary-allow', 'explicit-deny-boundary', 'explicit-deny-scp', 'unattributed', None):
            with self.subTest(reason=reason), self.assertRaises(SystemExit):
                self.run_sandbox({'denied-transaction': {'ok': False, 'code': 'AccessDeniedException', 'denial': reason}})
            self.assertFalse(self.check('mixed transaction')['passed'])

    def test_row_checks_fail_on_their_own(self):
        for step, label in (('denied-transaction', 'denied transaction wrote'), ('denied-batch', 'denied batch wrote')):
            with self.subTest(step=step), self.assertRaisesRegex(SystemExit, 'do not loosen the app policy'):
                self.run_sandbox(leaky=(step,))
            self.assertTrue(next(c for c in self.report['checks'] if c['check'].startswith('mixed')
                                 and (step == 'denied-transaction') == ('transaction' in c['check']))['passed'])
            self.assertFalse(self.check(label)['passed'])
            self.assertEqual(self.report['outcome'], 'failed')

    def test_cleanup_targets_only_the_sandbox_resources(self):
        self.run_sandbox()
        self.assertEqual(len(self.deleted_names), 5)
        self.assertTrue(all(n.startswith('qsb-iam-sandbox-') or n.startswith('/aws/lambda/qsb-iam-sandbox-')
                            for n in self.deleted_names), self.deleted_names)
        self.assertEqual(len({n.rsplit('/', 1)[-1] for n in self.deleted_names}), 1)

    def test_a_definite_failure_is_not_masked_as_inconclusive(self):
        unattributed = {'ok': False, 'code': 'AccessDeniedException', 'denial': 'unattributed'}
        with self.assertRaisesRegex(SystemExit, 'do not loosen the app policy'):
            self.run_sandbox({'denied-transaction': unattributed}, leaky=('denied-batch',))
        self.assertEqual(self.report['outcome'], 'failed')

    def test_a_pass_needs_every_documented_check(self):
        self.run_sandbox()
        self.assertEqual((self.report['outcome'], self.report['completed'], len(self.report['checks'])),
                         ('passed', True, 10))

    def test_control_failure_or_unattributed_denial_is_inconclusive(self):
        for behaviour in ({'control-owner-put': APP_DENY},
                          {'denied-transaction': {'ok': False, 'code': 'AccessDeniedException', 'denial': 'unattributed'}}):
            with self.subTest(behaviour=list(behaviour)), self.assertRaisesRegex(SystemExit, 'INCONCLUSIVE'):
                self.run_sandbox(behaviour)
            self.assertEqual(self.report['outcome'], 'inconclusive')
            self.assertFalse(self.report['passed'])

    def test_row_evidence_records_what_was_seen(self):
        with self.assertRaises(SystemExit):
            self.run_sandbox({'denied-transaction': {'ok': True}})
        self.assertEqual(self.check('denied transaction wrote')['observed'], {'owner': True, 'system': True})

    def test_lambda_failure_and_setup_failure_clean_up(self):
        with self.assertRaisesRegex(SystemExit, r'ABORTED .*\(allowed-transaction: the sandbox Lambda failed'):
            self.run_sandbox(function_error='allowed-transaction')
        self.assertTrue(self.report['cleanupComplete'])
        # Every check recorded so far passed, but the run stopped: the evidence must not read as a pass.
        self.assertTrue(self.report['checks'] and all(c['passed'] for c in self.report['checks']))
        self.assertEqual((self.report['passed'], self.report['outcome'], self.report['completed']),
                         (False, 'aborted', False))
        with self.assertRaisesRegex(SystemExit, r'ABORTED .*\(iam put-role-policy failed'):
            self.run_sandbox(fail=('iam', 'put-role-policy'))
        self.assertEqual(set(self.report['cleanup']), {'role-policy', 'role', 'table'})
        self.assertNotIn(('lambda', 'delete-function'), self.calls)

    def test_interruption_still_cleans_up_and_reports_aborted(self):
        with self.assertRaisesRegex(SystemExit, r'ABORTED .*\(KeyboardInterrupt\).*Do not deposit'):
            self.run_sandbox(interrupt=('dynamodb', 'get-item'))
        self.assertEqual(self.report['outcome'], 'aborted')
        self.assertTrue(self.report['cleanupComplete'])
        self.assertEqual(set(self.report['cleanup']), {'function', 'role-policy', 'role', 'table'})

    def test_role_propagation_is_retried_then_bounded(self):
        self.run_sandbox(propagation=3)
        self.assertEqual(self.calls.count(('lambda', 'create-function')), 4)
        self.assertTrue(self.report['passed'])
        with self.assertRaisesRegex(SystemExit, 'create-function failed: InvalidParameterValueException'):
            self.run_sandbox(propagation=30)
        self.assertEqual(self.calls.count(('lambda', 'create-function')), 24)

    def test_failed_cleanup_is_reported_not_hidden(self):
        with self.assertRaisesRegex(SystemExit, 'cleanup is incomplete'):
            self.run_sandbox(delete_fails=('delete-role',))
        self.assertTrue(self.report['passed'])
        self.assertFalse(self.report['cleanupComplete'])
        self.assertIn('failed', self.report['cleanup']['role'])

    def test_keep_leaves_resources(self):
        self.run_sandbox(keep=True)
        self.assertTrue(self.report['passed'])
        self.assertNotIn('cleanup', self.report)


class SandboxHandler(unittest.TestCase):
    """handler.py with stub boto3/botocore modules, so the tests need no AWS SDK."""

    def setUp(self):
        class ClientError(Exception):
            def __init__(self, response, name):
                super().__init__(name)
                self.response = response
        self.ClientError, self.calls, self.raise_error = ClientError, [], None
        test = self

        class Client:
            def __getattr__(self, name):
                def call(**kwargs):
                    test.calls.append((name, kwargs))
                    if test.raise_error:
                        raise test.raise_error
                    return {}
                return call
        stubs = {'boto3': types.SimpleNamespace(client=lambda *a, **k: Client()),
                 'botocore': types.ModuleType('botocore'),
                 'botocore.config': types.SimpleNamespace(Config=lambda **k: None),
                 'botocore.exceptions': types.SimpleNamespace(ClientError=ClientError)}
        self.patcher = patch.dict(sys.modules, stubs)
        self.patcher.start()
        sys.path.insert(0, str(HERE))
        self.handler = importlib.reload(importlib.import_module('handler')) if 'handler' in sys.modules \
            else importlib.import_module('handler')

    def tearDown(self):
        self.patcher.stop()
        sys.path.remove(str(HERE))
        sys.modules.pop('handler', None)

    def run_step(self, step):
        return self.handler.handler({'table': 'qsb-iam-sandbox-x', 'suffix': 'abc', 'step': step}, None)

    def test_each_step_uses_the_documented_keys(self):
        # A wrong key would let a step "pass" without exercising the deny it is meant to test.
        keys = lambda call: sorted(
            k['pk']['S'] for k in
            [call[1].get('Item'), call[1].get('Key')] +
            [next(iter(i.values())).get('Item') or next(iter(i.values())).get('Key') for i in call[1].get('TransactItems', [])] +
            [r['PutRequest']['Item'] for r in next(iter(call[1].get('RequestItems', {}).values()), [])]
            if k)
        expected = {'control-owner-put': ['OWNER#abc'], 'denied-transaction': ['OWNER#abc', 'SYSTEM#abc'],
                    'allowed-transaction': ['OUTPOINT#abc', 'OWNER#abc', 'SYSTEM#abc'],
                    'outpoint-put-again': ['OUTPOINT#abc'], 'outpoint-delete': ['OUTPOINT#abc'],
                    'denied-batch': ['OWNER#abc', 'SYSTEM#abc']}
        for step, want in expected.items():
            self.calls.clear()
            self.run_step(step)
            self.assertEqual(keys(self.calls[0]), want, step)

    def test_each_step_makes_the_documented_call(self):
        expected = {'control-owner-put': 'put_item', 'denied-transaction': 'transact_write_items',
                    'allowed-transaction': 'transact_write_items', 'outpoint-put-again': 'put_item',
                    'outpoint-delete': 'delete_item', 'denied-batch': 'batch_write_item'}
        for step, method in expected.items():
            self.calls.clear()
            self.assertTrue(self.run_step(step)['ok'])
            self.assertEqual([c[0] for c in self.calls], [method], step)
        self.calls.clear()
        self.run_step('allowed-transaction')
        items = self.calls[0][1]['TransactItems']
        self.assertEqual([next(iter(i)) for i in items], ['Put', 'Put', 'ConditionCheck'])
        self.assertEqual(items[2]['ConditionCheck']['Key']['pk']['S'], 'SYSTEM#abc')
        self.assertTrue(all(i[next(iter(i))]['ConditionExpression'] == 'attribute_not_exists(pk)' for i in items))

    def test_denials_are_attributed_without_arns(self):
        message = ('User: arn:aws:sts::123456789012:assumed-role/x/y is not authorized to perform: dynamodb:PutItem '
                   'on resource: arn:aws:dynamodb:eu-west-1:123456789012:table/t with an explicit deny in an '
                   'identity-based policy')
        self.raise_error = self.ClientError({'Error': {'Code': 'AccessDeniedException', 'Message': message}}, 'x')
        result = self.run_step('denied-transaction')
        self.assertEqual(result, {'ok': False, 'code': 'AccessDeniedException', 'cancellationReasons': None,
                                  'denial': 'explicit-deny-identity'})
        self.assertNotIn('123456789012', json.dumps(result))
        for text, label in (('because no permissions boundary allows the dynamodb:ConditionCheckItem action',
                             'no-boundary-allow'),
                            ('because no identity-based policy allows the dynamodb:BatchWriteItem action',
                             'no-identity-allow'),
                            ('with an explicit deny in a service control policy', 'explicit-deny-scp'),
                            ('something else', 'unattributed')):
            self.assertEqual(self.handler.denial_reason(text), label)

    def test_other_errors_carry_no_denial_reason(self):
        self.raise_error = self.ClientError({'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'x'}}, 'x')
        self.assertEqual(self.run_step('outpoint-put-again')['denial'], None)


if __name__ == '__main__':
    unittest.main()
