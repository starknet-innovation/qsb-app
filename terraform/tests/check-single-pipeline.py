#!/usr/bin/env python3
"""Check root application resource inventory without reading credentials.

No argument checks declarations; a JSON plan from `terraform show -json` checks
expanded planned resources, including nested modules. Terraform test -json -verbose
JSONL checks the baseline and configured-provider mock plans. Bootstrap is separate.

For a real deployment plan add --deploy: every role must sit under /qsb/runtime/ with the
administrator-owned qsb-runtime-boundary, the stack name must be qsb-* (not qsb-gpu*), and
the reconcile role must trust only the qsb-operator role, so the scoped roles can manage the
stack afterwards. Add --first-apply as well for an account's first apply: create-only.
"""
import json
from pathlib import Path
import re
import sys
from collections import Counter

ALLOWED = {
    'terraform_data', 'aws_dynamodb_table', 'aws_s3_bucket',
    'aws_s3_bucket_public_access_block', 'aws_s3_bucket_versioning',
    'aws_s3_bucket_server_side_encryption_configuration', 'aws_s3_object',
    'aws_s3_bucket_policy', 'aws_cloudwatch_log_group', 'aws_iam_role',
    'aws_iam_role_policy', 'aws_lambda_function', 'aws_lambda_permission',
    'aws_sfn_state_machine', 'aws_cloudwatch_metric_alarm',
    'aws_apigatewayv2_api', 'aws_apigatewayv2_integration',
    'aws_apigatewayv2_route', 'aws_apigatewayv2_stage',
    'aws_cloudfront_origin_access_control', 'aws_cloudfront_response_headers_policy',
    'aws_cloudfront_distribution',
}
EXPECTED = {
    'aws_dynamodb_table': {'records'},
    'aws_s3_bucket': {'frontend'},
    'aws_lambda_function': {'api', 'coordinator', 'reference'},
    'aws_sfn_state_machine': {'withdrawal'},
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(rows, expanded):
    types = Counter(row['type'] for row in rows)
    require(not (types.keys() - ALLOWED), 'Unexpected application resource type')
    for kind, names in EXPECTED.items():
        selected = [r for r in rows if r['type'] == kind]
        require(len(selected) == len(names) and {r['name'] for r in selected} == names,
                f'Expected only {kind}: {sorted(names)}')
    roles = [r for r in rows if r['type'] == 'aws_iam_role']
    require(len(roles) == (5 if expanded else 3) and {r['name'] for r in roles} == {'lambda', 'workflow', 'operator_reconcile'}, 'Expected only Lambda/workflow service roles and one reconciliation operator role')
    if expanded:
        funcs = {r['name']: r for r in rows if r['type'] == 'aws_lambda_function'}
        envs = {name: (row.get('values', {}).get('environment') or [{}])[0].get('variables', {})
                for name, row in funcs.items()}
        require(envs['api'].get('TABLE_NAME') and envs['api']['TABLE_NAME'] == envs['coordinator'].get('TABLE_NAME'),
                'API and coordinator must use the same table')
        require(all(not any(k.startswith('SUPERVISED_') for k in env) for env in envs.values()),
                'No supervised routing in application Lambda environments')
        require('AWS_BATCH_JOB_QUEUE' not in envs['api'] and 'AWS_BATCH_JOB_QUEUE' not in envs['reference'],
                'Only coordinator may receive the AWS Batch binding reference')
        policies = [r for r in rows if r['type'] == 'aws_iam_role_policy' and r['name'] == 'batch']
        require(len(policies) == (1 if envs['coordinator'].get('AWS_BATCH_JOB_QUEUE') else 0),
                'Exactly one AWS Batch binding policy when configured')
    return {'resourcesExcludingFrontendObjects': sum(v for k,v in types.items() if k != 'aws_s3_object'),
            'frontendObjects': types.get('aws_s3_object', 0), 'resourceTypes': dict(sorted(types.items()))}


def deploy_checks(plan, first_apply):
    """What the scoped deploy and operator roles need in order to manage what an admin first applied."""
    rows = module_resources(plan['planned_values']['root_module'])
    roles = [r['values'] for r in rows if r['type'] == 'aws_iam_role']
    for role in roles:
        require(role.get('path') == '/qsb/runtime/', f"role {role.get('name')} must use iam_role_path=/qsb/runtime/")
        require(str(role.get('permissions_boundary') or '').endswith(':policy/qsb/bootstrap/qsb-runtime-boundary'),
                f"role {role.get('name')} must carry qsb-runtime-boundary (iam_permissions_boundary_arn)")
    names = [r['values'].get('function_name', '') for r in rows if r['type'] == 'aws_lambda_function']
    require(names and all(n.startswith('qsb-') and not n.startswith('qsb-gpu') for n in names),
            'name must start with qsb- and not qsb-gpu, so the scoped roles cover the stack')
    reconcile = next(r['values'] for r in rows if r['type'] == 'aws_iam_role' and r['name'] == 'operator_reconcile')
    trust = json.loads(reconcile['assume_role_policy'])
    principals = [p for s in trust['Statement'] for p in (s['Principal']['AWS'] if isinstance(s['Principal']['AWS'], list)
                                                         else [s['Principal']['AWS']])]
    require(principals and all(p.endswith(':role/qsb/bootstrap/qsb-operator') for p in principals),
            'operator_principal_arns must be exactly the qsb-operator role ARN')
    if first_apply:
        actions = {tuple(r['change']['actions']) for r in plan.get('resource_changes', []) if r.get('mode') == 'managed'}
        require(actions <= {('create',)}, 'first apply must be create-only: the state key must be empty and no '
                                          'resource may already exist')
    return {'deployChecks': 'passed', 'roles': len(roles), 'firstApply': first_apply}


def module_resources(module):
    rows = [r for r in module.get('resources', []) if r.get('mode') == 'managed']
    for child in module.get('child_modules', []):
        rows.extend(module_resources(child))
    return rows


def main():
    if len(sys.argv) == 1:
        root = Path(__file__).resolve().parents[1]
        rows = [{'type': kind, 'name': name}
                for file in root.glob('*.tf')
                for kind, name in re.findall(r'^resource\s+"([^"]+)"\s+"([^"]+)"', file.read_text(), re.M)]
        result = validate(rows, False)
        result = {'evidence': 'source-declarations-only', 'resourceDeclarations': result['resourcesExcludingFrontendObjects'] + result['frontendObjects'], 'declaredResourceTypes': result['resourceTypes']}
    else:
        flags = [a for a in sys.argv[1:] if a.startswith('--')]
        paths = [a for a in sys.argv[1:] if not a.startswith('--')]
        require(len(paths) == 1 and set(flags) <= {'--deploy', '--first-apply'} and
                ('--first-apply' not in flags or '--deploy' in flags),
                'Usage: check-single-pipeline.py [plan.json [--deploy [--first-apply]]]')
        content = Path(paths[0]).read_text()
        try:
            plan = json.loads(content)
        except json.JSONDecodeError:
            events = [json.loads(line) for line in content.splitlines() if line.strip()]
            require(any(e.get('type') == 'test_summary' and e['test_summary']['status'] == 'pass' for e in events),
                    'Terraform test suite must pass before its mock plans count as evidence')
            result = {'evidence': 'mock-provider-plan-inventory', 'runs': {}}
            for event in events:
                name = event.get('@testrun')
                if event.get('type') == 'test_plan' and name in ('baseline', 'configured_single_pipeline'):
                    rows = [dict(row, values=row['change']['after'])
                            for row in event['test_plan']['resource_changes']
                            if row.get('mode') == 'managed' and row['change']['after'] is not None]
                    result['runs'][name] = validate(rows, True)
            require(set(result['runs']) == {'baseline', 'configured_single_pipeline'},
                    'Both baseline and configured-provider plans are required')
        else:
            result = validate(module_resources(plan['planned_values']['root_module']), True)
            result['evidence'] = 'saved-plan-inventory'
            if '--deploy' in flags:
                result.update(deploy_checks(plan, '--first-apply' in flags))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError) as exc:
        print(f'Single pipeline inventory failed: {exc}', file=sys.stderr)
        sys.exit(1)
