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
MINER = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:qsb/slipstream-AbC123'


def role(name, trust=OPERATOR):
    return {'type': 'aws_iam_role', 'name': name, 'mode': 'managed', 'values': {
        'name': f'qsb-app-{name}', 'path': '/qsb/runtime/', 'permissions_boundary': BOUNDARY,
        'assume_role_policy': json.dumps({'Statement': [{'Principal': {'AWS': [trust]}}]})}}


def workflow(retry=None, catch=None, fail=None):
    """The parts of terraform/workflow.tf's definition the checker reads."""
    task = {'Type': 'Task', 'Resource': 'arn:aws:lambda:eu-west-1:123456789012:function:qsb-app-coordinator',
            'Retry': [{'ErrorEquals': ['Lambda.TooManyRequestsException'], 'IntervalSeconds': 3, 'BackoffRate': 2,
                       'MaxAttempts': 6, 'JitterStrategy': 'FULL'}],
            'Catch': [{'ErrorEquals': ['States.ALL'], 'ResultPath': '$.failure', 'Next': 'NeedsOperatorAttention'}],
            'Next': 'SearchFinished'}
    for key, value in (('Retry', retry), ('Catch', catch)):
        if value == 'absent':
            task.pop(key)
        elif value is not None:
            task[key] = value
    states = {'CoordinateSearch': task, 'NeedsOperatorAttention': {'Type': 'Fail', 'Error': 'WorkflowInterrupted'}}
    if fail == 'absent':
        states.pop('NeedsOperatorAttention')
    elif fail is not None:
        states['NeedsOperatorAttention'] = fail
    return json.dumps({'StartAt': 'CoordinateSearch', 'States': states})


def plan():
    rows = [{'type': 'aws_dynamodb_table', 'name': 'records', 'mode': 'managed', 'values': {'name': 'qsb-app-records'}},
            {'type': 'aws_s3_bucket', 'name': 'frontend', 'mode': 'managed', 'values': {}},
            {'type': 'aws_sfn_state_machine', 'name': 'withdrawal', 'mode': 'managed', 'values': {'definition': workflow()}}]
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

    def with_miner_credential(self, arn=MINER, grant=None, env=True, policy_name='miner_credential'):
        doc = plan()
        rows = doc['planned_values']['root_module']['resources']
        if env:
            next(r for r in rows if r['name'] == 'api')['values']['environment'][0]['variables']['SLIPSTREAM_SECRET_ARN'] = arn
        statement = grant or {'Effect': 'Allow', 'Action': 'secretsmanager:GetSecretValue', 'Resource': arn}
        rows.append({'type': 'aws_iam_role_policy', 'name': policy_name, 'mode': 'managed',
                     'values': {'policy': json.dumps({'Version': '2012-10-17', 'Statement': [statement]})}})
        return doc

    def test_the_api_miner_credential_passes(self):
        self.assertEqual(self.run_check(self.with_miner_credential(), '--deploy')[0], 0)

    def test_the_miner_credential_grant_is_exactly_scoped(self):
        self.refused(self.with_miner_credential(policy_name='records'), 'Only the miner_credential policy')
        for grant in ({'Effect': 'Allow', 'Action': 'secretsmanager:*', 'Resource': MINER},
                      {'Effect': 'Allow', 'Action': ['secretsmanager:GetSecretValue'], 'Resource': MINER},
                      {'Effect': 'Allow', 'Action': 'secretsmanager:GetSecretValue', 'Resource': '*'},
                      {'Effect': 'Allow', 'Action': 'secretsmanager:GetSecretValue', 'Resource': MINER.replace('slipstream', 'other')},
                      {'Effect': 'Allow', 'Action': 'secretsmanager:GetSecretValue', 'Resource': [MINER]}):
            with self.subTest(grant=grant):
                self.refused(self.with_miner_credential(grant=grant), 'qsb/slipstream secret only')

    def test_a_wildcard_action_counts_as_a_secret_grant(self):
        self.refused(self.with_miner_credential(grant={'Effect': 'Allow', 'Action': '*', 'Resource': '*'}, policy_name='start'),
                     'Only the miner_credential policy')

    def test_the_api_gets_the_reference_exactly_with_its_grant(self):
        self.refused(self.with_miner_credential(env=False), 'exactly when its read grant exists')
        doc = plan()
        next(r for r in doc['planned_values']['root_module']['resources'] if r['name'] == 'api')['values']['environment'][0]['variables']['SLIPSTREAM_SECRET_ARN'] = MINER
        self.refused(doc, 'exactly when its read grant exists')
        other = MINER.replace('AbC123', 'XyZ789')
        doc = self.with_miner_credential()
        next(r for r in doc['planned_values']['root_module']['resources'] if r['name'] == 'api')['values']['environment'][0]['variables']['SLIPSTREAM_SECRET_ARN'] = other
        self.refused(doc, 'exactly the secret the API is given')

    def test_only_the_api_receives_the_miner_credential(self):
        doc = self.with_miner_credential()
        next(r for r in doc['planned_values']['root_module']['resources'] if r['name'] == 'coordinator')['values']['environment'][0]['variables']['SLIPSTREAM_SECRET_ARN'] = MINER
        self.refused(doc, 'Only the API may receive the miner credential')

    def test_the_miner_credential_policy_must_really_grant_the_secret(self):
        for statement in ({'Effect': 'Allow', 'Action': 's3:GetObject', 'Resource': '*'}, None):
            doc = self.with_miner_credential()
            policy = next(r for r in doc['planned_values']['root_module']['resources'] if r['name'] == 'miner_credential')
            policy['values']['policy'] = json.dumps({'Statement': [statement] if statement else []})
            with self.subTest(statement=statement):
                self.refused(doc, 'exactly one Secrets Manager read')
        doc = self.with_miner_credential()
        next(r for r in doc['planned_values']['root_module']['resources'] if r['name'] == 'miner_credential')['values'].pop('policy')
        self.refused(doc, 'must be known at plan')

    def test_the_miner_credential_policy_must_belong_to_the_api_role(self):
        doc = self.with_miner_credential()
        rows = doc['planned_values']['root_module']['resources']
        lambdas = [r for r in rows if r['type'] == 'aws_iam_role' and r['name'] == 'lambda']
        for r, index in zip(lambdas, ('api', 'coordinator')):
            r['index'], r['values']['name'] = index, f'qsb-app-{index}'
        policy = next(r for r in rows if r['name'] == 'miner_credential')
        policy['values']['role'] = 'qsb-app-api'
        self.assertEqual(self.run_check(doc, '--deploy')[0], 0)
        policy['values']['role'] = 'qsb-app-coordinator'
        self.refused(doc, 'must belong to the API role')

    def test_not_action_and_pattern_wildcards_are_refused(self):
        self.refused(self.with_miner_credential(grant={'Effect': 'Allow', 'NotAction': 's3:*', 'Resource': '*'},
                                                policy_name='start'), 'NotAction is not allowed')
        for action in ('s*:*', 'secretsmanager:Get*', 'SecretsManager:GetSecretValue', 'secretsmanager:BatchGet*',
                       'secretsmanager:PutResourcePolicy'):
            with self.subTest(action=action):
                self.refused(self.with_miner_credential(grant={'Effect': 'Allow', 'Action': action, 'Resource': '*'},
                                                        policy_name='logs'), 'Only the miner_credential policy')

    def with_workflow(self, **changes):
        doc = plan()
        machine = next(r for r in doc['planned_values']['root_module']['resources'] if r['type'] == 'aws_sfn_state_machine')
        machine['values']['definition'] = workflow(**changes)
        return doc

    def test_only_a_throttled_coordinator_invoke_is_retried(self):
        throttled = {'ErrorEquals': ['Lambda.TooManyRequestsException'], 'MaxAttempts': 6}
        for retry in ('absent', [], [{'ErrorEquals': ['States.ALL'], 'MaxAttempts': 6}],
                      [{'ErrorEquals': ['States.TaskFailed'], 'MaxAttempts': 6}],
                      [{'ErrorEquals': ['Lambda.TooManyRequestsException', 'Lambda.ServiceException'], 'MaxAttempts': 6}],
                      [{'ErrorEquals': ['TooManyRequestsException'], 'MaxAttempts': 6}],
                      [throttled, {'ErrorEquals': ['States.Timeout'], 'MaxAttempts': 1}],
                      [{'ErrorEquals': ['Lambda.TooManyRequestsException']}],
                      [dict(throttled, MaxAttempts=99999999)], [dict(throttled, MaxAttempts=0)],
                      [dict(throttled, MaxAttempts=True)]):
            with self.subTest(retry=retry):
                self.refused(self.with_workflow(retry=retry), 'retry only Lambda.TooManyRequestsException')

    def test_every_other_coordinator_error_needs_an_operator(self):
        for catch in ('absent', [], [{'ErrorEquals': ['States.ALL'], 'ResultPath': '$.failure', 'Next': 'SearchFinished'}],
                      [{'ErrorEquals': ['Lambda.TooManyRequestsException'], 'ResultPath': '$.failure',
                        'Next': 'NeedsOperatorAttention'}]):
            with self.subTest(catch=catch):
                self.refused(self.with_workflow(catch=catch), 'must end in NeedsOperatorAttention')
        doc = plan()
        next(r for r in doc['planned_values']['root_module']['resources']
             if r['type'] == 'aws_sfn_state_machine')['values'].pop('definition')
        self.refused(doc, 'definition must be known at plan')

    def test_needs_operator_attention_stays_a_fail_state(self):
        # Otherwise an unreconciled outcome would end as a succeeded execution and the failure alarm would stay silent.
        for fail in ('absent', {'Type': 'Pass', 'End': True}, {'Type': 'Succeed'}):
            with self.subTest(fail=fail):
                self.refused(self.with_workflow(fail=fail), 'NeedsOperatorAttention must stay a Fail state')

    def test_flags_need_a_saved_plan(self):
        events = [{'type': 'test_run', '@testrun': 'baseline'}, {'type': 'test_summary', 'test_summary': {'status': 'pass'}}]
        code, err = self.run_check(events, '--deploy', jsonl=True)
        self.assertEqual(code, 1)
        self.assertIn('need a saved plan', err)
        self.refused(plan(), 'Usage', '--first-apply')


class SourceRules(unittest.TestCase):
    """static_secret_rules on a copy of the Terraform source: they hold even where plan values are unknown."""
    def check(self, edit):
        source = SCRIPT.parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'terraform'
            (root / 'tests').mkdir(parents=True)
            (root / 'policies').mkdir()
            for path in [*source.glob('*.tf'), *(source / 'policies').glob('*.json')]:
                (root / path.relative_to(source)).write_text(path.read_text())
            (root / 'tests' / SCRIPT.name).write_text(SCRIPT.read_text())
            if edit:
                name, old, new = edit
                if old is None:  # append, creating the file if needed
                    path = root / name
                    path.write_text((path.read_text() if path.exists() else '') + new)
                else:
                    text = (root / name).read_text()
                    self.assertIn(old, text)
                    (root / name).write_text(text.replace(old, new, 1))
            result = subprocess.run([sys.executable, str(root / 'tests' / SCRIPT.name)], capture_output=True, text=True)
            return result.returncode, result.stderr

    def refused(self, edit, message):
        code, err = self.check(edit)
        self.assertEqual(code, 1, err)
        self.assertIn(message, err)

    def test_the_current_source_passes(self):
        self.assertEqual(self.check(None), (0, ''))

    def test_secret_access_outside_the_miner_policy_is_refused(self):
        logs = 'Action = ["logs:CreateLogStream", "logs:PutLogEvents"]'
        self.refused(('compute.tf', logs, 'Action = ["logs:CreateLogStream", "secretsmanager:GetSecretValue"]'),
                     'only aws_iam_role_policy.miner_credential may mention Secrets Manager')
        self.refused(('compute.tf', logs, 'Action = ["logs:CreateLogStream", "s*:*"]'), 'would grant Secrets Manager access')
        self.refused(('compute.tf', logs, 'Action = ["logs:CreateLogStream", "*"]'), 'wildcard IAM action')
        self.refused(('compute.tf', logs, 'Action = "*"'), 'wildcard IAM action')
        self.refused(('compute.tf', logs, 'NotAction = ["s3:*"]'), 'NotAction is not allowed')
        self.refused(('policies/app-records.json', '"dynamodb:GetItem"', '"secretsmanager:GetSecretValue"'),
                     'Secrets Manager access is not allowed')
        self.refused(('policies/app-records.json', '"dynamodb:GetItem"', '"*"'), 'Secrets Manager access is not allowed')

    def test_other_ways_of_writing_a_policy_are_refused(self):
        logs = 'Action = ["logs:CreateLogStream", "logs:PutLogEvents"]'
        self.refused(('compute.tf', logs, '"Action" = "*"'), 'wildcard IAM action')
        self.refused(('compute.tf', logs, 'Action : ["logs:CreateLogStream", "*"]'), 'wildcard IAM action')
        self.refused(('compute.tf', None, '\nlocals {\n  doc = <<EOT\n{"Statement": [{"Effect": "Allow", "Action": ["s3:GetObject", "*"], "Resource": "*"}]}\nEOT\n}\n'),
                     'wildcard IAM action')
        self.refused(('compute.tf', logs, 'not_actions = ["s3:*"]'), 'NotAction is not allowed')
        self.refused(('compute.tf', None, '\ndata "aws_iam_policy_document" "x" {\n  statement {\n    actions = ["s3:GetObject"]\n    resources = ["*"]\n  }\n}\n'),
                     'data source aws_iam_policy_document is not reviewed')
        self.refused(('compute.tf', None, '\nmodule "x" {\n  source = "./x"\n}\n'), 'modules are not reviewed')
        self.refused(('extra.tf.json', None, '{}'), 'JSON Terraform files are not reviewed')
        self.refused(('compute.tf', 'file("${path.module}/policies/app-records.json")', 'templatefile("${path.module}/policies/app-records.json", {})'),
                     'templatefile() is not reviewed')
        self.refused(('compute.tf', 'file("${path.module}/policies/app-records.json")', 'file("${path.module}/extra.json")'),
                     'reads an unreviewed input')
        self.refused(('variables.tf', None, '\nvariable "x" {\n  default = var.slipstream_secret_arn\n}\n'), 'may feed only the API')

    def test_the_miner_policy_stays_on_the_api_role_and_secret(self):
        self.refused(('compute.tf', 'role   = aws_iam_role.lambda["api"].id\n  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "secretsmanager',
                      'role   = aws_iam_role.lambda["coordinator"].id\n  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "secretsmanager'),
                     'one statement on the API role')
        self.refused(('compute.tf', 'Resource = var.slipstream_secret_arn', 'Resource = "*"'), 'one statement on the API role')

    def test_index_html_stays_out_of_the_other_frontend_objects(self):
        self.refused(('data.tf', 'setsubtract(fileset("${local.artifacts}/frontend", "**"), ["index.html"])',
                      'fileset("${local.artifacts}/frontend", "**")'), 'must leave index.html to aws_s3_object.index')

    def test_removed_frontend_files_are_deleted_after_the_new_index(self):
        self.refused(('data.tf', 'lifecycle { create_before_destroy = true }', ''), 'needs create_before_destroy')
        self.refused(('data.tf', 'lifecycle { create_before_destroy = true }', 'lifecycle { create_before_destroy = false }'),
                     'needs create_before_destroy')

    def test_index_html_is_uploaded_after_the_other_frontend_objects(self):
        self.refused(('data.tf', 'aws_s3_bucket_public_access_block.frontend, aws_s3_object.frontend]',
                      'aws_s3_bucket_public_access_block.frontend]'), 'must upload index.html after')

    def test_the_existing_index_html_object_is_moved_not_recreated(self):
        moved = 'moved {\n  from = aws_s3_object.frontend["index.html"]\n  to   = aws_s3_object.index\n}\n'
        message = 'moved { from = aws_s3_object.frontend["index.html"], to = aws_s3_object.index }'
        self.refused(('data.tf', moved, ''), message)
        self.refused(('data.tf', 'from = aws_s3_object.frontend["index.html"]', 'from = aws_s3_object.frontend["assets/index.html"]'), message)
        self.refused(('data.tf', 'to   = aws_s3_object.index', 'to   = aws_s3_object.frontend["index.html"]'), message)
        self.refused(('data.tf', None, '\nmoved {\n  from = aws_s3_object.index\n  to   = aws_s3_object.entrypoint\n}\n'), message)

    def test_frontend_objects_stay_in_the_two_reviewed_resources(self):
        self.refused(('data.tf', None, '\nresource "aws_s3_object" "extra" {\n  bucket = aws_s3_bucket.frontend.id\n}\n'),
                     'aws_s3_object.frontend and aws_s3_object.index only')

    def test_only_the_api_receives_the_secret_reference(self):
        self.refused(('compute.tf', 'REFERENCE_FUNCTION = aws_lambda_function.reference.function_name',
                      'REFERENCE_FUNCTION = aws_lambda_function.reference.function_name, SLIPSTREAM_SECRET_ARN = var.slipstream_secret_arn'),
                     'only the API Lambda may receive SLIPSTREAM_SECRET_ARN')
        self.refused(('compute.tf', 'REFERENCE_FUNCTION = aws_lambda_function.reference.function_name',
                      'REFERENCE_FUNCTION = aws_lambda_function.reference.function_name, X = var.slipstream_secret_arn'),
                     'may feed only the API')


if __name__ == '__main__':
    unittest.main()
