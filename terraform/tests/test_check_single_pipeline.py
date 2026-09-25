"""Offline checks for check-single-pipeline.py --deploy/--first-apply on synthetic saved plans."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent / 'check-single-pipeline.py'
BOUNDARY = 'arn:aws:iam::123456789012:policy/qsb/bootstrap/qsb-runtime-boundary'
OPERATOR = 'arn:aws:iam::123456789012:role/qsb/bootstrap/qsb-operator'


def role(name, trust=OPERATOR):
    return {'type': 'aws_iam_role', 'name': name, 'mode': 'managed', 'values': {
        'name': f'qsb-app-{name}', 'path': '/qsb/runtime/', 'permissions_boundary': BOUNDARY,
        'assume_role_policy': json.dumps({'Statement': [{'Principal': {'AWS': [trust]}}]})}}


def plan():
    rows = [{'type': 'aws_dynamodb_table', 'name': 'records', 'mode': 'managed', 'values': {'name': 'qsb-app-records'}},
            {'type': 'aws_s3_bucket', 'name': 'frontend', 'mode': 'managed', 'values': {}},
            {'type': 'aws_sfn_state_machine', 'name': 'withdrawal', 'mode': 'managed', 'values': {}}]
    # Like the real stack: api and coordinator read the table; the reference Lambda has no environment.
    rows += [{'type': 'aws_lambda_function', 'name': f, 'mode': 'managed',
              'values': {'function_name': f'qsb-app-{f}', 'environment': [{'variables': {'TABLE_NAME': 'qsb-app-records'}}]}}
             for f in ('api', 'coordinator')]
    rows += [{'type': 'aws_lambda_function', 'name': 'reference', 'mode': 'managed',
              'values': {'function_name': 'qsb-app-reference'}}]
    # The validator expects five aws_iam_role rows in an expanded plan (a real plan has three `lambda`
    # roles, one `workflow` and one `operator_reconcile`); any five with those names satisfy it.
    rows += [role('lambda'), role('workflow'), role('operator_reconcile'), role('lambda'), role('workflow')]
    return {'planned_values': {'root_module': {'resources': rows}},
            'resource_changes': [{'mode': 'managed', 'change': {'actions': ['create']}}]}


class DeployChecks(unittest.TestCase):
    def run_check(self, document, *flags, jsonl=False):
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            f.write('\n'.join(json.dumps(e) for e in document) if jsonl else json.dumps(document))
        result = subprocess.run([sys.executable, str(SCRIPT), f.name, *flags], capture_output=True, text=True)
        Path(f.name).unlink()
        return result.returncode, result.stderr

    def refused(self, document, message, *flags):
        code, err = self.run_check(document, *flags)
        self.assertEqual(code, 1, err)
        self.assertIn(message, err)

    def test_a_compliant_first_apply_passes(self):
        self.assertEqual(self.run_check(plan(), '--deploy', '--first-apply')[0], 0)

    def test_role_path_and_boundary_are_required(self):
        wrong_path, no_boundary = plan(), plan()
        next(r for r in wrong_path['planned_values']['root_module']['resources'] if r['type'] == 'aws_iam_role')['values']['path'] = '/'
        next(r for r in no_boundary['planned_values']['root_module']['resources'] if r['type'] == 'aws_iam_role')['values']['permissions_boundary'] = None
        self.refused(wrong_path, 'iam_role_path=/qsb/runtime/', '--deploy')
        self.refused(no_boundary, 'qsb-runtime-boundary', '--deploy')

    def test_stack_name_must_be_covered_by_the_scoped_roles(self):
        for name in ('app', 'qsb-gpu-app'):
            doc = plan()
            for r in doc['planned_values']['root_module']['resources']:
                if r['type'] == 'aws_lambda_function':
                    r['values']['function_name'] = f'{name}-x'
            with self.subTest(name=name):
                self.refused(doc, 'name must start with qsb-', '--deploy')

    def test_reconcile_role_must_trust_only_qsb_operator(self):
        doc = plan()
        rows = doc['planned_values']['root_module']['resources']
        rows[[i for i, r in enumerate(rows) if r['name'] == 'operator_reconcile'][0]] = role(
            'operator_reconcile', trust='arn:aws:iam::123456789012:user/someone')
        self.refused(doc, 'qsb-operator role ARN', '--deploy')

    def test_first_apply_must_be_create_only(self):
        doc = plan()
        doc['resource_changes'].append({'mode': 'managed', 'change': {'actions': ['delete', 'create']}})
        self.refused(doc, 'create-only', '--deploy', '--first-apply')
        # Without --first-apply, an update plan is fine.
        self.assertEqual(self.run_check(doc, '--deploy')[0], 0)

    def unknown_api_env(self, refs=None):
        """A real first plan: Terraform marks the API environment unknown, so its configuration is checked."""
        doc = plan()
        for r in doc['planned_values']['root_module']['resources']:
            if r['type'] == 'aws_lambda_function' and r['name'] == 'api':
                r['values'].pop('environment')
        doc['resource_changes'] += [
            {'type': 'aws_lambda_function', 'name': 'api', 'mode': 'managed',
             'change': {'actions': ['create'], 'after_unknown': {'environment': [{'variables': True}]}}},
            {'type': 'aws_lambda_function', 'name': 'reference', 'mode': 'managed',
             'change': {'actions': ['create'], 'after_unknown': {'environment': []}}}]
        if refs is None:
            refs = ['aws_dynamodb_table.records', 'aws_dynamodb_table.records.name', 'aws_cloudfront_distribution.web',
                    'aws_cloudfront_distribution.web.domain_name', 'var.mainnet_enabled']
        doc['configuration'] = {'root_module': {'resources': [
            {'address': 'aws_lambda_function.api', 'expressions': {'environment': [{'variables': {'references': refs}}]}}]}}
        return doc

    def test_absent_environment_is_known_and_empty(self):
        # The CI mock-plan case: the reference Lambda has no environment block and there's no configuration.
        self.assertEqual(self.run_check(plan(), '--deploy')[0], 0)

    def test_unknown_api_environment_is_checked_against_reviewed_references(self):
        self.assertEqual(self.run_check(self.unknown_api_env(), '--deploy', '--first-apply')[0], 0)
        self.refused(self.unknown_api_env(refs=['aws_dynamodb_table.records.name', 'var.batch_job_queue']),
                     'not reviewed')
        self.refused(self.unknown_api_env(refs=['aws_dynamodb_table.records.name', 'local.batch_env']), 'not reviewed')
        self.refused(self.unknown_api_env(refs=['var.network']), 'must use the same table')
        doc = self.unknown_api_env()
        del doc['configuration']
        self.refused(doc, 'unknown until apply')

    def test_only_the_api_environment_may_be_unknown(self):
        doc = self.unknown_api_env()
        doc['resource_changes'].append({'type': 'aws_lambda_function', 'name': 'coordinator', 'mode': 'managed',
                                        'change': {'actions': ['create'],
                                                   'after_unknown': {'environment': [{'variables': True}]}}})
        self.refused(doc, 'only the API environment is expected')

    def with_unknown(self, doc, name, variables):
        doc['resource_changes'].append({'type': 'aws_lambda_function', 'name': name, 'mode': 'managed',
                                        'change': {'actions': ['create'], 'after_unknown': {'environment': variables}}})
        return doc

    def test_partly_unknown_api_environment_is_checked_by_key(self):
        # The CI mock-plan shape: every key is named, only APP_ORIGIN's value is unknown; no configuration needed.
        doc = self.with_unknown(plan(), 'api', [{'variables': {'APP_ORIGIN': True}}])
        self.assertEqual(self.run_check(doc, '--deploy')[0], 0)
        doc = self.with_unknown(plan(), 'api', [{'variables': {'AWS_BATCH_JOB_QUEUE': True}}])
        self.refused(doc, 'Only coordinator may receive')
        doc = self.with_unknown(plan(), 'api', [{'variables': {'SUPERVISED_ROUTE': True}}])
        self.refused(doc, 'No supervised routing')
        doc = plan()
        for r in doc['planned_values']['root_module']['resources']:
            if r['type'] == 'aws_lambda_function' and r['name'] == 'api':
                r['values']['environment'][0]['variables'].pop('TABLE_NAME')
        self.refused(self.with_unknown(doc, 'api', [{'variables': {'TABLE_NAME': True}}]), 'TABLE_NAME must be known')

    def test_only_the_api_environment_may_be_wholly_unknown(self):
        for shape in (True, [True], [{'variables': True}]):
            with self.subTest(shape=shape):
                self.refused(self.with_unknown(self.unknown_api_env(), 'reference', shape), 'only the API environment')
        self.refused(self.with_unknown(plan(), 'api', [{'variables': {'X': 'odd'}}]), 'unrecognised after_unknown shape')

    def test_known_coordinator_table_is_checked_while_the_api_is_unknown(self):
        doc = self.unknown_api_env()
        for r in doc['planned_values']['root_module']['resources']:
            if r['type'] == 'aws_lambda_function' and r['name'] == 'coordinator':
                r['values']['environment'][0]['variables']['TABLE_NAME'] = 'qsb-other'
        self.refused(doc, 'must use the same table')

    def test_known_table_names_must_match_the_table(self):
        doc = plan()
        for r in doc['planned_values']['root_module']['resources']:
            if r['type'] == 'aws_lambda_function' and r['name'] == 'coordinator':
                r['values']['environment'][0]['variables']['TABLE_NAME'] = 'qsb-other'
        self.refused(doc, 'must use the same table')

    def test_supervised_routing_is_refused(self):
        doc = plan()
        for r in doc['planned_values']['root_module']['resources']:
            if r['type'] == 'aws_lambda_function' and r['name'] == 'api':
                r['values']['environment'][0]['variables']['SUPERVISED_EXECUTION_ENABLED'] = 'true'
        self.refused(doc, 'No supervised routing')

    def test_flags_need_a_saved_plan(self):
        events = [{'type': 'test_run', '@testrun': 'baseline'}, {'type': 'test_summary', 'test_summary': {'status': 'pass'}}]
        code, err = self.run_check(events, '--deploy', jsonl=True)
        self.assertEqual(code, 1)
        self.assertIn('need a saved plan', err)
        self.refused(plan(), 'Usage', '--first-apply')


if __name__ == '__main__':
    unittest.main()
