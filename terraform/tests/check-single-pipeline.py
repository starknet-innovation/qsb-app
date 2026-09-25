#!/usr/bin/env python3
"""Check root application resource inventory without reading credentials.

No argument checks declarations; a JSON plan from `terraform show -json` checks
expanded planned resources, including nested modules. Terraform test -json -verbose
JSONL checks the baseline and configured-provider mock plans. Bootstrap is separate.
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
    require(len(roles) == (4 if expanded else 2), 'Expected only Lambda and workflow service roles')
    if expanded:
        funcs = {r['name']: r for r in rows if r['type'] == 'aws_lambda_function'}
        envs = {name: (row.get('values', {}).get('environment') or [{}])[0].get('variables', {})
                for name, row in funcs.items()}
        require(envs['api'].get('TABLE_NAME') and envs['api']['TABLE_NAME'] == envs['coordinator'].get('TABLE_NAME'),
                'API and coordinator must use the same table')
        require(all(not any(k.startswith('SUPERVISED_') for k in env) for env in envs.values()),
                'No supervised routing in application Lambda environments')
        require('RUNPOD_SECRET_ARN' not in envs['api'] and 'RUNPOD_SECRET_ARN' not in envs['reference'],
                'Only coordinator may receive the provider credential reference')
        policies = [r for r in rows if r['type'] == 'aws_iam_role_policy' and r['name'] == 'runpod']
        require(len(policies) == (1 if envs['coordinator'].get('RUNPOD_SECRET_ARN') else 0),
                'Exactly one provider credential policy when configured')
    return {'resourcesExcludingFrontendObjects': sum(v for k,v in types.items() if k != 'aws_s3_object'),
            'frontendObjects': types.get('aws_s3_object', 0), 'resourceTypes': dict(sorted(types.items()))}


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
        require(len(sys.argv) == 2, 'Usage: check-single-pipeline.py [plan.json]')
        content = Path(sys.argv[1]).read_text()
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
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError) as exc:
        print(f'Single pipeline inventory failed: {exc}', file=sys.stderr)
        sys.exit(1)
