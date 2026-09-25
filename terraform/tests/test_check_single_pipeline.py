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
    rows = [{'type': 'aws_dynamodb_table', 'name': 'records', 'mode': 'managed', 'values': {}},
            {'type': 'aws_s3_bucket', 'name': 'frontend', 'mode': 'managed', 'values': {}},
            {'type': 'aws_sfn_state_machine', 'name': 'withdrawal', 'mode': 'managed', 'values': {}}]
    rows += [{'type': 'aws_lambda_function', 'name': f, 'mode': 'managed',
              'values': {'function_name': f'qsb-app-{f}', 'environment': [{'variables': {'TABLE_NAME': 't'}}]}}
             for f in ('api', 'coordinator', 'reference')]
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

    def test_flags_need_a_saved_plan(self):
        events = [{'type': 'test_run', '@testrun': 'baseline'}, {'type': 'test_summary', 'test_summary': {'status': 'pass'}}]
        code, err = self.run_check(events, '--deploy', jsonl=True)
        self.assertEqual(code, 1)
        self.assertIn('need a saved plan', err)
        self.refused(plan(), 'Usage', '--first-apply')


if __name__ == '__main__':
    unittest.main()
