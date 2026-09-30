"""Offline checks that the deploy workflow's helpers never let identifying values into the public Actions log."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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


class ProviderErrors(unittest.TestCase):
    def test_ids_the_provider_names_in_parentheses_are_redacted(self):
        out = gd.redact('│ Error: reading API Gateway v2 API (a1b2c3d4e5): operation error ApiGatewayV2: GetApi\n'
                        'Error: waiting for CloudFront Distribution (EXAMPLEDIST123) deploy\n'
                        'Error: updating Lambda Function (qsb-app-api) configuration', [])
        for leak in ('a1b2c3d4e5', 'EXAMPLEDIST123', 'qsb-app-api'):
            self.assertNotIn(leak, out)
        self.assertIn('reading API Gateway v2 API (<id>)', out)

    def test_the_deploy_checks_own_hints_survive(self):
        text = 'role qsb-app-api must carry qsb-runtime-boundary (iam_permissions_boundary_arn)'
        self.assertEqual(gd.redact(text, []), text)

    def test_every_output_but_the_commit_is_masked(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d, 'outputs.json')
            path.write_text(json.dumps({
                'api_id': {'value': 'a1b2c3d4e5'}, 'cloudfront_distribution_id': {'value': 'EXAMPLEDIST123'},
                'app_url': {'value': 'https://d111111abcdef8.cloudfront.net'}, 'source_commit': {'value': 'f' * 40},
                'gpu_limits': {'value': {'workersMax': 16}}, 'transactions_enabled': {'value': True}}))
            masked = {l.removeprefix('::add-mask::') for l in gd.output_masks(path)}
        self.assertEqual(masked, {'a1b2c3d4e5', 'EXAMPLEDIST123', 'https://d111111abcdef8.cloudfront.net'})


STS_RESPONSE = f"""<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <Credentials><AccessKeyId>ASIAEXAMPLEEXAMPLE12</AccessKeyId><SecretAccessKey>secret/example</SecretAccessKey>
      <SessionToken>session-token-example</SessionToken><Expiration>2026-01-01T00:00:00Z</Expiration></Credentials>
    <AssumedRoleUser><Arn>arn:aws:sts::{ACCOUNT}:assumed-role/qsb-github-deploy/qsb-plan-1</Arn>
      <AssumedRoleId>AROAEXAMPLEEXAMPLE123:qsb-plan-1</AssumedRoleId></AssumedRoleUser>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>""".encode()


class Credentials(unittest.TestCase):
    def assume(self, account=ACCOUNT):
        calls = []

        def fake_request(req, attempts=3):
            calls.append(req)
            return json.dumps({'value': 'oidc-token-example'}).encode() if len(calls) == 1 else STS_RESPONSE

        with tempfile.TemporaryDirectory() as d:
            github_env = Path(d, 'env')
            github_env.write_text('')
            env = {'ROLE_ARN': ROLE, 'ACCOUNT_ID': account, 'REGION': 'eu-west-2', 'GITHUB_ENV': str(github_env),
                   'ACTIONS_ID_TOKEN_REQUEST_URL': 'https://token.example/?api-version=2.0',
                   'ACTIONS_ID_TOKEN_REQUEST_TOKEN': 'request-token'}
            with mock.patch.dict(os.environ, env), mock.patch.object(gd, 'request', fake_request), \
                    mock.patch('builtins.print') as printed:
                code = gd.credentials('qsb-plan-1')
            lines = [str(c.args[0]) for c in printed.call_args_list]
            return code, lines, github_env.read_text(), calls

    def test_everything_sts_returns_is_masked_before_anything_else_prints(self):
        code, lines, github_env, calls = self.assume()
        self.assertEqual(code, 0)
        self.assertTrue(calls[0].full_url.endswith('&audience=sts.amazonaws.com'))
        self.assertEqual(calls[1].full_url, 'https://sts.eu-west-2.amazonaws.com/')
        masked = [l.removeprefix('::add-mask::') for l in lines if l.startswith('::add-mask::')]
        self.assertEqual(set(masked), {'oidc-token-example', 'ASIAEXAMPLEEXAMPLE12', 'secret/example',
                                       'session-token-example', 'AROAEXAMPLEEXAMPLE123:qsb-plan-1',
                                       f'arn:aws:sts::{ACCOUNT}:assumed-role/qsb-github-deploy/qsb-plan-1'})
        plain = [l for l in lines if not l.startswith('::add-mask::')]
        self.assertEqual(plain, ['Assumed the deploy role for one hour.'])
        self.assertIn('AWS_SESSION_TOKEN=session-token-example\n', github_env)
        self.assertIn('AWS_REGION=eu-west-2\n', github_env)

    def test_a_role_in_another_account_is_refused(self):
        code, lines, github_env, _ = self.assume(account='210987654321')
        self.assertEqual((code, github_env), (1, ''))
        self.assertIn('The role is not in the account QSB_AWS_ACCOUNT_ID names.', lines)


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
