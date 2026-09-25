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
PROPAGATION = {'MalformedPolicyDocument': 'Invalid principal in policy: "AWS":"arn:aws:iam::123456789012:user/x"'}
READS = {'list-roles', 'list-users', 'list-policies', 'get-policy-version', 'list-policy-versions',
         'list-entities-for-policy', 'get-user-policy', 'get-role', 'list-attached-user-policies', 'list-user-policies',
         'list-access-keys', 'list-groups-for-user', 'list-ssh-public-keys', 'list-service-specific-credentials',
         'list-signing-certificates', 'list-mfa-devices', 'get-login-profile', 'list-attached-role-policies',
         'list-role-policies'}


class BootstrapAnalyzerReadiness(unittest.TestCase):
    def bootstrap(self, existing, statuses=(), dry=False, *, responses_override=None, cli_failure=None,
                  resume=False, errors=None):
        self.calls = []
        errors = {key: list(codes) for key, codes in (errors or {}).items()}
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
            if errors.get(key):
                code = errors[key].pop(0)
                if code:
                    code, text = code if isinstance(code, tuple) else (code, PROPAGATION.get(code, ''))
                    return subprocess.CompletedProcess(command, 254, '',
                        f'An error occurred ({code}) when calling the operation: {text}')
            if key == cli_failure:
                return subprocess.CompletedProcess(command, 254, '',
                    'An error occurred (AccessDeniedException) when calling the operation')
            if key in (responses_override or {}):
                response = responses_override[key]
                if hasattr(response, '__next__'):
                    response = next(response)
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
            if resume: argv.append('--resume')
            with patch.object(sys, 'argv', argv), patch('subprocess.check_output', side_effect=git), \
                    patch('subprocess.run', side_effect=aws), patch('analyzer_readiness.time.sleep'), \
                    contextlib.redirect_stdout(io.StringIO()):
                runpy.run_path(str(ROOT / 'bootstrap_access.py'), run_name='__main__')

    def assert_no_iam_mutations(self):
        self.assertFalse([(s, op) for s, op in self.calls if s == 'iam' and op not in READS])

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

    def test_role_creation_rides_out_new_user_propagation(self):
        self.bootstrap([{'status': 'ACTIVE'}],
                       errors={('iam', 'create-role'): ['MalformedPolicyDocument', 'MalformedPolicyDocument']})
        self.assertEqual(self.calls.count(('iam', 'create-role')), 4)
        self.assertEqual(self.calls.count(('iam', 'attach-role-policy')), 4)

    def test_role_creation_retry_is_bounded_and_specific(self):
        with self.assertRaisesRegex(SystemExit, 'create-role failed: MalformedPolicyDocument'):
            self.bootstrap([{'status': 'ACTIVE'}], errors={('iam', 'create-role'): ['MalformedPolicyDocument'] * 24})
        self.assertEqual(self.calls.count(('iam', 'create-role')), 24)
        # A genuinely malformed document is not retried: only the propagation message is.
        with self.assertRaisesRegex(SystemExit, 'create-role failed: MalformedPolicyDocument'):
            self.bootstrap([{'status': 'ACTIVE'}],
                           errors={('iam', 'create-role'): [('MalformedPolicyDocument', 'Syntax errors in policy')]})
        self.assertEqual(self.calls.count(('iam', 'create-role')), 1)
        self.assertNotIn(('iam', 'attach-role-policy'), self.calls)
        with self.assertRaisesRegex(SystemExit, 'create-role failed: AccessDenied'):
            self.bootstrap([{'status': 'ACTIVE'}], errors={('iam', 'create-role'): ['AccessDenied']})
        self.assertEqual(self.calls.count(('iam', 'create-role')), 1)

    def partial_run(self, **drift):
        """IAM as the interrupted run left it: policies and user created, no roles."""
        from access import access
        out = access(dict(account=ACCOUNT, region='eu-west-1', subject='repo:example/qsb:ref:refs/heads/main',
                          state_bucket='qsb-test-state', distributions=['TESTCDN'], apis=['testapi'],
                          origin_access_controls=['TESTOAC'], response_headers_policies=['TESTHEADERS'],
                          operator_user='qsb-operator-user', gpu_vpc='vpc-0test'))
        docs = {'qsb-gpu-boundary': out['gpu_boundary']['document'],
                'qsb-viewonly-1': out['viewonly']['policies'][0],
                **{f'qsb-operator-{i}': d for i, d in enumerate(out['operator']['policies'], 1)}}
        listed = [{'PolicyName': 'qsb-runtime-boundary', 'Path': '/qsb/bootstrap/'}] + [
            {'PolicyName': n, 'Path': drift.get('path', '/qsb/bootstrap/'),
             'Arn': f'arn:aws:iam::{ACCOUNT}:policy/qsb/bootstrap/{n}', 'DefaultVersionId': 'v1'} for n in docs]
        versions = iter([{'PolicyVersion': {'Document': drift.get('document', d)}} for _, d in sorted(docs.items())])
        return {
            ('iam', 'list-policies'): {'Policies': listed},
            ('iam', 'list-users'): {'Users': [{'UserName': 'qsb-operator-user', 'Path': '/qsb/operators/'}]},
            ('iam', 'get-policy-version'): versions,
            ('iam', 'list-attached-user-policies'): {'AttachedPolicies': [{'PolicyArn': a} for a in out['user']['managed']]},
            ('iam', 'list-user-policies'): {'PolicyNames': drift.get('user_policies', ['assume-qsb-roles'])},
            ('iam', 'get-user-policy'): {'PolicyDocument': drift.get('user_inline', out['user']['inline'])},
            ('iam', 'list-access-keys'): {'AccessKeyMetadata': drift.get('keys', [])},
            ('iam', 'list-groups-for-user'): {'Groups': drift.get('groups', [])},
            ('iam', 'list-policy-versions'): {'Versions': drift.get('versions', [{'VersionId': 'v1'}])},
            ('iam', 'list-entities-for-policy'): {'PolicyUsers': [], 'PolicyGroups': [],
                                                  'PolicyRoles': drift.get('attached_to', [])},
            ('iam', 'list-ssh-public-keys'): {'SSHPublicKeys': drift.get('ssh', [])},
            ('iam', 'list-service-specific-credentials'): {'ServiceSpecificCredentials': []},
            ('iam', 'list-signing-certificates'): {'Certificates': []},
            ('iam', 'list-mfa-devices'): {'MFADevices': []},
            ('iam', 'get-login-profile'): {'LoginProfile': {}},
        }

    def test_resume_creates_only_the_missing_roles(self):
        self.bootstrap([{'status': 'ACTIVE'}], resume=True, responses_override=self.partial_run())
        for write in ('create-policy', 'create-user', 'attach-user-policy', 'put-user-policy'):
            self.assertNotIn(('iam', write), self.calls)
        self.assertEqual(self.calls.count(('iam', 'create-role')), 2)
        self.assertEqual(self.calls.count(('iam', 'attach-role-policy')), 4)
        self.assertEqual(self.calls.count(('iam', 'get-policy-version')), 4)

    def with_roles(self, responses, **role):
        """Add an existing qsb-viewonly role to a partial run, optionally drifted."""
        from access import access
        out = access(dict(account=ACCOUNT, region='eu-west-1', subject='repo:example/qsb:ref:refs/heads/main',
                          state_bucket='qsb-test-state', distributions=['TESTCDN'], apis=['testapi'],
                          origin_access_controls=['TESTOAC'], response_headers_policies=['TESTHEADERS'],
                          operator_user='qsb-operator-user', gpu_vpc='vpc-0test'))
        spec = out['viewonly']
        responses[('iam', 'list-roles')] = {'Roles': [{'RoleName': 'qsb-viewonly', 'Path': '/qsb/bootstrap/'}]}
        responses[('iam', 'get-role')] = {'Role': {'Path': '/qsb/bootstrap/', 'MaxSessionDuration': spec['max_session'],
                                                   'AssumeRolePolicyDocument': role.get('trust', spec['trust'])}}
        attached = role.get('attached', [spec['managed'][0], f'arn:aws:iam::{ACCOUNT}:policy/qsb/bootstrap/qsb-viewonly-1'])
        responses[('iam', 'list-attached-role-policies')] = {'AttachedPolicies': [{'PolicyArn': x} for x in attached]}
        responses[('iam', 'list-role-policies')] = {'PolicyNames': role.get('inline', [])}
        return responses

    def test_resume_fills_in_missing_policies_but_nothing_else(self):
        # User created but its inline policy never written; role created with one attachment missing.
        responses = self.with_roles(self.partial_run(user_policies=[]),
                                    attached=[f'arn:aws:iam::{ACCOUNT}:policy/qsb/bootstrap/qsb-viewonly-1'])
        self.bootstrap([{'status': 'ACTIVE'}], resume=True, responses_override=responses)
        self.assertEqual(self.calls.count(('iam', 'put-user-policy')), 1)
        self.assertNotIn(('iam', 'get-user-policy'), self.calls)
        # qsb-viewonly gets only its missing managed policy; qsb-operator is created with its two.
        self.assertEqual(self.calls.count(('iam', 'create-role')), 1)
        self.assertEqual(self.calls.count(('iam', 'attach-role-policy')), 3)

    def test_resume_refuses_role_drift(self):
        other = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow', 'Principal': {'AWS': '*'}, 'Action': 'sts:AssumeRole'}]}
        for role, message in (({'trust': other}, 'differs in path, trust or session length'),
                              ({'attached': ['arn:aws:iam::aws:policy/AdministratorAccess']}, 'policies this commit does not render'),
                              ({'inline': ['extra']}, 'policies this commit does not render')):
            with self.subTest(role=list(role)), self.assertRaisesRegex(SystemExit, message):
                self.bootstrap([{'status': 'ACTIVE'}], resume=True,
                               responses_override=self.with_roles(self.partial_run(), **role))
            self.assert_no_iam_mutations()

    def test_resume_refuses_anything_that_differs(self):
        for drift, message in (({'document': {'Version': '2012-10-17', 'Statement': []}}, 'differs from the rendered'),
                               ({'path': '/elsewhere/'}, 'is not under /qsb/bootstrap/'),
                               ({'keys': [{'AccessKeyId': 'AKIAEXAMPLE'}]}, 'has access keys'),
                               ({'versions': [{'VersionId': 'v1'}, {'VersionId': 'v2'}]}, 'more than one version'),
                               ({'attached_to': [{'RoleName': 'someone-else'}]}, 'outside'),
                               ({'ssh': [{'SSHPublicKeyId': 'APKAEXAMPLE'}]}, 'has SSH keys'),
                               ({'groups': [{'GroupName': 'admins'}]}, 'is in a group'),
                               ({'user_inline': {'Version': '2012-10-17', 'Statement': []}}, 'different inline policy')):
            with self.subTest(drift=list(drift)), self.assertRaisesRegex(SystemExit, message):
                self.bootstrap([{'status': 'ACTIVE'}], resume=True, responses_override=self.partial_run(**drift))
            self.assert_no_iam_mutations()
            self.assertFalse([call for call in self.calls if call[0] == 'accessanalyzer'])

    def test_plan_does_not_create_or_inspect_analyzers(self):
        with self.assertRaises(SystemExit):
            self.bootstrap([], dry=True)
        self.assertEqual(self.calls, [('sts', 'get-caller-identity')])


if __name__ == '__main__': unittest.main()
