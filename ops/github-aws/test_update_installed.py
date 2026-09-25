"""Offline checks for update_installed.py: no subprocess, network, credentials or IAM writes."""
import contextlib
import copy
import re
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from access import access
from render import render

ROOT = Path(__file__).resolve().parent
COMMIT = 'b' * 40
ACCOUNT = '123456789012'
INVENTORY = dict(account=ACCOUNT, region='eu-west-1', subject='repo:example/qsb:ref:refs/heads/main',
                 state_bucket='qsb-test-state', distributions=['TESTCDN'], apis=['testapi'],
                 origin_access_controls=['TESTOAC'], response_headers_policies=['TESTHEADERS'],
                 operator_user='qsb-operator-user', gpu_vpc='vpc-0test')
WRITES = {'create-policy-version', 'put-role-policy', 'put-user-policy', 'update-assume-role-policy', 'update-role'}


class UpdateInstalled(unittest.TestCase):
    def installed(self):
        """IAM exactly as this commit renders it; tests then introduce drift."""
        rendered, human = render(INVENTORY), access(INVENTORY)
        policies = {'qsb-runtime-boundary': rendered['boundary'], 'qsb-gpu-boundary': human['gpu_boundary']['document']}
        for role in ('viewonly', 'operator'):
            for i, doc in enumerate(human[role]['policies'], 1):
                policies[f'qsb-{role}-{i}'] = doc
        arn = lambda n: f'arn:aws:iam::{ACCOUNT}:policy/qsb/bootstrap/{n}'
        roles = {spec['name']: {'trust': copy.deepcopy(spec['trust']), 'max': spec['max_session'], 'inline': [],
                                'attached': list(spec['managed']) + [arn(f'{spec["name"]}-{i}')
                                                                      for i in range(1, len(spec['policies']) + 1)]}
                 for spec in (human['viewonly'], human['operator'])}
        roles['qsb-github-deploy'] = {'trust': copy.deepcopy(rendered['trust']), 'max': 3600, 'attached': [],
                                      'inline': ['qsb-terraform-deployment']}
        return {'policies': {n: [copy.deepcopy(d)] for n, d in policies.items()},
                'deploy': copy.deepcopy(rendered['deploy']), 'user': copy.deepcopy(human['user']['inline']),
                'roles': roles}

    def run_update(self, iam, apply=True, yes=True, branch='main', plan_hash='auto', tty=False, answer=None):
        if apply and yes and plan_hash == 'auto':
            # Like an operator: review a plan-mode run first, then apply quoting its hash.
            try:
                self.run_update(iam, apply=False, branch=branch)
            except SystemExit:
                pass
            plan_hash = self.plan_hash
        self.calls, self.args = [], []

        def git(args, **kwargs):
            if args[1] == 'status': return ''
            if args[1:3] == ['rev-parse', 'HEAD']: return COMMIT + '\n'
            if args[1] == 'branch': return branch + '\n'
            if args[1] == 'ls-remote': return COMMIT + f'\trefs/heads/{branch}\n'
            raise AssertionError(f'unexpected command {args}')

        def aws(command, **kwargs):
            args = command[command.index('--cli-read-timeout') + 2:]
            service, operation = args[:2]
            opt = lambda flag: args[args.index(flag) + 1]
            self.calls.append((service, operation))
            self.args.append(args)
            arn_name = lambda: opt('--policy-arn').rsplit('/', 1)[-1]
            if (service, operation) == ('sts', 'get-caller-identity'):
                out = {'Account': ACCOUNT}
            elif operation == 'list-policies':
                out = {'Policies': [{'PolicyName': n, 'Arn': f'arn:aws:iam::{ACCOUNT}:policy/qsb/bootstrap/{n}',
                                     'DefaultVersionId': f'v{len(v)}'} for n, v in iam['policies'].items()]}
            elif operation == 'get-policy-version':
                out = {'PolicyVersion': {'Document': iam['policies'][arn_name()][int(opt('--version-id')[1:]) - 1]}}
            elif operation == 'list-policy-versions':
                out = {'Versions': [{'VersionId': f'v{i}'} for i in range(1, len(iam['policies'][arn_name()]) + 1)]}
            elif operation == 'get-policy':
                out = {'Policy': {'DefaultVersionId': f"v{len(iam['policies'][arn_name()])}"}}
            elif operation == 'create-policy-version':
                if not iam.get('ignore_writes'):
                    iam['policies'][arn_name()].append(json.loads(opt('--policy-document')))
                out = {}
            elif operation == 'list-role-policies':
                out = {'PolicyNames': iam['roles'][opt('--role-name')]['inline']}
            elif operation == 'list-attached-role-policies':
                out = {'AttachedPolicies': [{'PolicyArn': x} for x in iam['roles'][opt('--role-name')]['attached']]}
            elif operation == 'get-role-policy':
                self.assertEqual((opt('--role-name'), opt('--policy-name')), ('qsb-github-deploy', 'qsb-terraform-deployment'))
                out = {'PolicyDocument': iam['deploy']}
            elif operation == 'put-role-policy':
                if not iam.get('ignore_writes'):
                    iam['deploy'] = json.loads(opt('--policy-document'))
                out = {}
            elif operation == 'get-user-policy':
                if iam.get('user_denied'):
                    return subprocess.CompletedProcess(command, 254, '', 'An error occurred (AccessDenied) when calling')
                self.assertEqual((opt('--user-name'), opt('--policy-name')), ('qsb-operator-user', 'assume-qsb-roles'))
                out = {'PolicyDocument': iam['user']}
            elif operation == 'put-user-policy':
                if not iam.get('ignore_writes'):
                    iam['user'] = json.loads(opt('--policy-document'))
                out = {}
            elif operation == 'get-role':
                role = iam['roles'][opt('--role-name')]
                out = {'Role': {'AssumeRolePolicyDocument': role['trust'], 'MaxSessionDuration': role['max']}}
            elif operation == 'update-assume-role-policy':
                if not iam.get('ignore_writes'):
                    iam['roles'][opt('--role-name')]['trust'] = json.loads(opt('--policy-document'))
                out = {}
            elif operation == 'update-role':
                if not iam.get('ignore_writes'):
                    iam['roles'][opt('--role-name')]['max'] = int(opt('--max-session-duration'))
                out = {}
            else:
                raise AssertionError(f'unexpected AWS operation {(service, operation)}')
            return subprocess.CompletedProcess(command, 0, json.dumps(out), '')

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'inventory.json'
            path.write_text(json.dumps(INVENTORY))
            argv = ['update_installed.py', '--profile', 'public-test', '--inventory', str(path)] + \
                (['--apply'] if apply else []) + (['--yes'] if apply and yes else []) + \
                (['--plan-hash', plan_hash] if apply and yes and plan_hash else [])
            stdout = io.StringIO()
            try:
                with patch.object(sys, 'argv', argv), patch('subprocess.check_output', side_effect=git), \
                        patch('subprocess.run', side_effect=aws), contextlib.redirect_stdout(stdout), \
                        patch('sys.stdin.isatty', return_value=tty), patch('builtins.input', return_value=answer):
                    runpy.run_path(str(ROOT / 'update_installed.py'), run_name='__main__')
            finally:
                text = stdout.getvalue()
                head = json.loads(text[:text.index('\n}\n') + 2]) if '"plan"' in text else {}
                self.plan, self.plan_hash = head.get('plan', []), head.get('plan_hash')

    def writes(self):
        return [op for s, op in self.calls if s == 'iam' and op in WRITES]

    def status(self, target):
        return next(item for item in self.plan if item['target'] == target)

    def test_identical_installation_writes_nothing(self):
        self.run_update(self.installed())
        self.assertEqual(self.writes(), [])
        self.assertTrue(all(item['status'] == 'identical' for item in self.plan))

    def test_stale_deploy_role_and_runtime_boundary_are_updated_and_read_back(self):
        iam = self.installed()
        iam['deploy']['Statement'].append({'Sid': 'EcrQsb', 'Effect': 'Allow', 'Action': ['ecr:*'], 'Resource': ['*']})
        iam['policies']['qsb-runtime-boundary'][0] = {'Version': '2012-10-17', 'Statement': [
            {'Sid': 'ProviderSecret', 'Effect': 'Allow', 'Action': ['secretsmanager:GetSecretValue'], 'Resource': ['*']}]}
        self.run_update(iam)
        self.assertEqual(sorted(self.writes()), ['create-policy-version', 'put-role-policy'])
        self.assertEqual(self.status('qsb-github-deploy/qsb-terraform-deployment')['removed'], ['EcrQsb'])
        self.assertIn('ProviderSecret', self.status('qsb-runtime-boundary')['removed'])
        self.assertEqual(iam['deploy'], render(INVENTORY)['deploy'])
        self.assertEqual(iam['policies']['qsb-runtime-boundary'][-1], render(INVENTORY)['boundary'])

    def test_session_length_and_trust_drift_are_corrected(self):
        iam = self.installed()
        iam['roles']['qsb-viewonly']['max'] = 14400
        iam['roles']['qsb-operator']['trust']['Statement'][0].pop('Condition')  # MFA requirement lost
        self.run_update(iam)
        self.assertEqual(sorted(self.writes()), ['update-assume-role-policy', 'update-role'])
        self.assertEqual(iam['roles']['qsb-viewonly']['max'], 3600)
        self.assertEqual(iam['roles']['qsb-operator']['trust'], access(INVENTORY)['operator']['trust'])

    def test_plan_mode_never_writes(self):
        iam = self.installed()
        iam['deploy']['Statement'].append({'Sid': 'EcrQsb', 'Effect': 'Allow', 'Action': ['ecr:*'], 'Resource': ['*']})
        with self.assertRaises(SystemExit):
            self.run_update(iam, apply=False)
        self.assertEqual(self.writes(), [])
        self.assertEqual(self.status('qsb-github-deploy/qsb-terraform-deployment')['status'], 'differs')

    def test_refusals_happen_before_any_write(self):
        iam = self.installed()
        iam['deploy']['Statement'].append({'Sid': 'EcrQsb', 'Effect': 'Allow', 'Action': ['ecr:*'], 'Resource': ['*']})
        iam['policies']['qsb-gpu-boundary'] = [{'Version': '2012-10-17', 'Statement': []}] * 5
        with self.assertRaisesRegex(SystemExit, 'already has 5 versions'):
            self.run_update(iam)
        self.assertEqual(self.writes(), [])

    def test_changed_policy_count_or_missing_identity_is_refused(self):
        iam = self.installed()
        iam['policies']['qsb-operator-3'] = [{'Version': '2012-10-17', 'Statement': []}]
        with self.assertRaisesRegex(SystemExit, 'separately reviewed step'):
            self.run_update(iam)
        self.assertEqual(self.writes(), [])
        iam = self.installed()
        del iam['policies']['qsb-gpu-boundary']
        with self.assertRaisesRegex(SystemExit, 'run the bootstrap first'):
            self.run_update(iam)
        self.assertEqual(self.writes(), [])

    def test_plan_mode_reports_an_unreadable_user_policy(self):
        iam = self.installed()
        iam['user_denied'] = True
        with self.assertRaises(SystemExit):
            self.run_update(iam, apply=False)
        self.assertIn('unreadable', self.status('qsb-operator-user/assume-qsb-roles')['status'])
        with self.assertRaisesRegex(SystemExit, 'get-user-policy failed: AccessDenied'):
            self.run_update(iam)
        self.assertEqual(self.writes(), [])

    def test_apply_needs_confirmation_and_main(self):
        iam = self.installed()
        iam['roles']['qsb-viewonly']['max'] = 14400
        with self.assertRaisesRegex(SystemExit, 'confirm interactively or rerun with --yes'):
            self.run_update(iam, yes=False)
        self.assertEqual(self.writes(), [])
        with self.assertRaisesRegex(SystemExit, 'Not confirmed'):
            self.run_update(iam, yes=False, tty=True, answer='yes please')
        self.assertEqual(self.writes(), [])
        self.run_update(iam, yes=False, tty=True, answer='apply')
        self.assertEqual(self.writes(), ['update-role'])
        with self.assertRaisesRegex(SystemExit, 'only from a clean main'):
            self.run_update(iam, branch='ops/elsewhere')
        self.assertEqual(self.calls, [])

    def test_every_write_is_read_back(self):
        def drifted(change):
            iam = self.installed()
            change(iam)
            iam['ignore_writes'] = True  # AWS accepts each write but nothing changes
            return iam
        no_mfa = lambda role: lambda iam: iam['roles'][role]['trust']['Statement'][0].pop('Condition')
        cases = [
            (lambda iam: iam['roles']['qsb-viewonly'].update(max=14400), 'qsb-viewonly max session'),
            (no_mfa('qsb-operator'), 'qsb-operator trust'),
            (lambda iam: iam['roles']['qsb-github-deploy']['trust']['Statement'][0].update(Action='sts:AssumeRole'),
             'qsb-github-deploy trust'),
            (lambda iam: iam['policies']['qsb-gpu-boundary'].__setitem__(0, {'Version': '2012-10-17', 'Statement': []}),
             'qsb-gpu-boundary'),
            (lambda iam: iam['deploy']['Statement'].pop(), 'qsb-github-deploy'),
            (lambda iam: iam['user']['Statement'].pop(), 'qsb-operator-user/assume-qsb-roles'),
        ]
        for change, label in cases:
            with self.subTest(label=label), self.assertRaisesRegex(SystemExit, re.escape(label) + r'.*read back'):
                self.run_update(drifted(change))

    def test_new_default_version_is_set_and_read_back(self):
        iam = self.installed()
        iam['policies']['qsb-gpu-boundary'][0] = {'Version': '2012-10-17', 'Statement': []}
        self.run_update(iam)
        create = next(args for args in self.args if args[1] == 'create-policy-version')
        self.assertIn('--set-as-default', create)
        self.assertIn(('iam', 'get-policy'), self.calls)

    def test_deploy_trust_drift_is_corrected_but_principals_never_move(self):
        iam = self.installed()
        iam['roles']['qsb-github-deploy']['trust']['Statement'][0]['Action'] = 'sts:AssumeRole'
        self.run_update(iam)
        self.assertEqual(self.writes(), ['update-assume-role-policy'])
        self.assertEqual(iam['roles']['qsb-github-deploy']['trust'], render(INVENTORY)['trust'])
        # Changing who is trusted (the GitHub subject, or the operator user) is refused before any write.
        for change in (lambda t: t['Statement'][0]['Condition']['StringEquals'].__setitem__(
                           'token.actions.githubusercontent.com:sub', 'repo:someone/else:ref:refs/heads/main'),):
            iam = self.installed()
            change(iam['roles']['qsb-github-deploy']['trust'])
            with self.assertRaisesRegex(SystemExit, 'trusted principal would change'):
                self.run_update(iam)
            self.assertEqual(self.writes(), [])
        iam = self.installed()
        iam['roles']['qsb-operator']['trust']['Statement'][0]['Principal'] = {'AWS': f'arn:aws:iam::{ACCOUNT}:user/other'}
        with self.assertRaisesRegex(SystemExit, 'trusted principal would change'):
            self.run_update(iam)
        self.assertEqual(self.writes(), [])

    def test_yes_is_bound_to_the_reviewed_plan(self):
        iam = self.installed()
        iam['roles']['qsb-viewonly']['max'] = 14400
        for quoted in (None, '0' * 16):
            with self.subTest(quoted=quoted), self.assertRaisesRegex(SystemExit, 'needs --plan-hash'):
                self.run_update(iam, plan_hash=quoted)
            self.assertEqual(self.writes(), [])
        # A plan reviewed while a target was unreadable doesn't authorise writing it.
        iam['user_denied'] = True
        with self.assertRaises(SystemExit):
            self.run_update(iam, apply=False)
        unseen = self.plan_hash
        iam['user_denied'] = False
        with self.assertRaisesRegex(SystemExit, 'needs --plan-hash'):
            self.run_update(iam, plan_hash=unseen)
        self.assertEqual(self.writes(), [])

    def test_plan_detail_covers_every_field_and_masks_numbers(self):
        iam = self.installed()
        statement = next(s for s in iam['deploy']['Statement'] if s.get('Sid') == 'StateList')
        statement['NotPrincipal'] = {'AWS': f'arn:aws:iam::{ACCOUNT}:root'}
        statement['Condition'] = {'NumericEquals': {'aws:ResourceAccount': 123456789012}}
        with self.assertRaises(SystemExit):
            self.run_update(iam, apply=False)
        detail = self.status('qsb-github-deploy/qsb-terraform-deployment')['changed']['StateList']
        self.assertEqual(detail['NotPrincipal']['installed'], {'AWS': 'arn:aws:iam::<ACCOUNT>:root'})
        self.assertEqual(detail['Condition']['installed'], {'NumericEquals': {'aws:ResourceAccount': '<ACCOUNT>'}})

    def test_inline_policies_on_access_roles_are_refused(self):
        iam = self.installed()
        iam['roles']['qsb-viewonly']['inline'] = ['extra']
        with self.assertRaisesRegex(SystemExit, 'qsb-viewonly carries policies this commit does not render'):
            self.run_update(iam)
        self.assertEqual(self.writes(), [])

    def test_plan_shows_what_changed_inside_a_statement(self):
        iam = self.installed()
        statement = next(s for s in iam['deploy']['Statement'] if s.get('Sid') == 'PassRuntimeRoles')
        statement['Condition'] = {'StringEquals': {'iam:PassedToService': ['ec2.amazonaws.com']}}
        statement['Resource'] = statement['Resource'] + [f'arn:aws:iam::{ACCOUNT}:role/other']
        with self.assertRaises(SystemExit):
            self.run_update(iam, apply=False)
        detail = self.status('qsb-github-deploy/qsb-terraform-deployment')['changed']['PassRuntimeRoles']
        self.assertEqual(detail['Resource']['removed'], ['arn:aws:iam::<ACCOUNT>:role/other'])
        self.assertIn('Condition', detail)

    def test_roles_with_policies_this_commit_does_not_render_are_refused(self):
        for role in ('qsb-github-deploy', 'qsb-operator'):
            iam = self.installed()
            iam['roles'][role]['attached'].append('arn:aws:iam::aws:policy/AdministratorAccess')
            with self.subTest(role=role), self.assertRaisesRegex(SystemExit, 'this commit does not render'):
                self.run_update(iam)
            self.assertEqual(self.writes(), [])

    def test_all_access_policies_missing_is_refused_not_skipped(self):
        iam = self.installed()
        del iam['policies']['qsb-operator-1'], iam['policies']['qsb-operator-2']
        iam['roles']['qsb-operator']['attached'] = []
        with self.assertRaisesRegex(SystemExit, 'run the bootstrap first'):
            self.run_update(iam)
        self.assertEqual(self.writes(), [])
        self.assertIn('missing', self.status('qsb-operator-1')['status'])

    def test_unexpected_deploy_role_policies_are_refused(self):
        iam = self.installed()
        iam['roles']['qsb-github-deploy']['inline'] = ['qsb-terraform-deployment', 'extra']
        with self.assertRaisesRegex(SystemExit, 'unexpected inline policies'):
            self.run_update(iam)
        self.assertEqual(self.writes(), [])


if __name__ == '__main__':
    unittest.main()
