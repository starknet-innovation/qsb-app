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
import fnmatch
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


# Everything the API Lambda's environment may draw on (terraform/compute.tf). In a real first plan that
# environment is unknown until apply, because it includes the CloudFront domain, so the plan's configuration
# references are checked against this list instead: any new reference fails closed until reviewed here.
# References carry no key names or constants; re-run with --deploy after the first apply, when the
# environment is known, and rely on the mock-plan tests for constants.
API_ENV_REFERENCES = {
    'aws_cloudfront_distribution.web', 'aws_cloudfront_distribution.web.domain_name',
    'aws_dynamodb_table.records', 'aws_dynamodb_table.records.name',
    'local.owner_limit_env', 'local.solver_release_id', 'local.workflow_arn',
    'var.exact_submit_enabled', 'var.mainnet_enabled', 'var.network', 'var.slipstream_secret_arn',
}
# The mocked `terraform test` plans whose expanded inventory must pass validate().
MOCK_RUNS = {'baseline', 'configured_single_pipeline', 'miner_credential_api_only'}
# The one secret any application role may read: the API's MARA Slipstream credential.
MINER_SECRET = re.compile(r'^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:qsb/slipstream-[A-Za-z0-9]{6}$')
MINER_POLICY = ('aws_iam_role_policy', 'miner_credential')
MINER_GRANT = {'Effect': 'Allow', 'Action': 'secretsmanager:GetSecretValue'}
# Data sources the stack reads; anything else (an aws_iam_policy_document, say) is unreviewed policy input.
DATA_SOURCES = {'aws_partition', 'aws_cloudfront_cache_policy', 'aws_cloudfront_origin_request_policy'}
# Where file-reading functions may read: the reviewed policies, build artifacts, the build manifest
# override and the GPU spend constants.
FILE_INPUTS = re.compile(r'(?:"\$\{path\.module\}/policies/[a-z0-9-]+\.json"|"\$\{local\.artifacts\}/'
                         r'|var\.build_manifest_path\)|"\$\{path\.module\}/\.\./server/gpu-spend\.json")')


# The withdrawal workflow retries only a throttled coordinator invoke, which Lambda refused before the coordinator
# ran. Every other catchable error, where the coordinator may have run, must end in NeedsOperatorAttention.
COORDINATOR_RETRY_ERRORS = ['Lambda.TooManyRequestsException']
COORDINATOR_CATCH = [{'ErrorEquals': ['States.ALL'], 'ResultPath': '$.failure', 'Next': 'NeedsOperatorAttention'}]


def workflow_rules(rows):
    machine = next(r for r in rows if r['type'] == 'aws_sfn_state_machine')
    definition = machine.get('values', {}).get('definition')
    require(isinstance(definition, str), 'the withdrawal state machine definition must be known at plan')
    states = json.loads(definition).get('States', {})
    task = states.get('CoordinateSearch', {})
    retry = task.get('Retry')
    require(isinstance(retry, list) and len(retry) == 1 and retry[0].get('ErrorEquals') == COORDINATOR_RETRY_ERRORS
            and type(retry[0].get('MaxAttempts')) is int and 1 <= retry[0]['MaxAttempts'] <= 10,
            'CoordinateSearch must retry only Lambda.TooManyRequestsException, a bounded number of times')
    require(task.get('Catch') == COORDINATOR_CATCH, 'Every other CoordinateSearch error must end in NeedsOperatorAttention')
    # A Pass or Succeed here would end an unreconciled outcome as a succeeded execution, with no failure alarm.
    require(states.get('NeedsOperatorAttention', {}).get('Type') == 'Fail',
            'NeedsOperatorAttention must stay a Fail state, so the execution fails and the alarm fires')


def reads_secrets(action):
    """Whether an IAM action or action pattern touches Secrets Manager, including any pattern covering a read."""
    pattern = str(action).lower()
    return pattern.startswith('secretsmanager:') or any(
        fnmatch.fnmatchcase(a, pattern) for a in ('secretsmanager:getsecretvalue', 'secretsmanager:batchgetsecretvalue'))


def as_list(value):
    return [value] if isinstance(value, str) else list(value or [])


def resource_blocks(text):
    """(type, name, start, end) of each top-level resource or variable block, by brace matching."""
    for match in re.finditer(r'^\s*(?:resource\s+"([^"]+)"|(variable))\s+"([^"]+)"\s*\{', text, re.M):
        depth, end = 1, match.end()
        while depth and end < len(text):
            depth += {'{': 1, '}': -1}.get(text[end], 0)
            end += 1
        yield match.group(1) or match.group(2), match.group(3), match.start(), end


def static_secret_rules(root):
    """Source rules for secrets. Unlike plan values, source is never unknown, so these hold on every plan.

    They are a review aid against ordinary mistakes, not a sandbox: deliberately assembled strings can evade
    any source scan, which is why the runtime boundary also limits the secret to API roles."""
    require(not list(root.glob('*.tf.json')), 'JSON Terraform files are not reviewed by this check')
    for path in sorted(root.glob('*.tf')):
        text = path.read_text()
        blocks = {(kind, name): (start, end) for kind, name, start, end in resource_blocks(text)}
        inside = lambda key, pos: key in blocks and blocks[key][0] <= pos < blocks[key][1]
        require(not re.search(r'not_?actions?', text, re.I), f'{path.name}: NotAction is not allowed in application policies')
        require(not re.search(r'^\s*module\s+"', text, re.M), f'{path.name}: modules are not reviewed by this check')
        for match in re.finditer(r'^\s*data\s+"([^"]+)"', text, re.M):
            require(match.group(1) in DATA_SOURCES, f'{path.name}: data source {match.group(1)} is not reviewed')
        require('templatefile(' not in text, f'{path.name}: templatefile() is not reviewed by this check')
        for match in re.finditer(r'\bfile[a-z0-9]*\(', text):
            require(FILE_INPUTS.match(text, match.end()), f'{path.name}: {match.group(0)} reads an unreviewed input')
        for match in re.finditer(r'secretsmanager', text, re.I):
            require(inside(MINER_POLICY, match.start()) or inside(('variable', 'slipstream_secret_arn'), match.start()),
                    f'{path.name}: only aws_iam_role_policy.miner_credential may mention Secrets Manager')
        for match in re.finditer(r'SLIPSTREAM_SECRET_ARN', text):
            require(inside(('aws_lambda_function', 'api'), match.start()),
                    f'{path.name}: only the API Lambda may receive SLIPSTREAM_SECRET_ARN')
        for match in re.finditer(r'var\.slipstream_secret_arn', text):
            require(any(inside(key, match.start()) for key in
                        (MINER_POLICY, ('aws_lambda_function', 'api'), ('variable', 'slipstream_secret_arn'))),
                    f'{path.name}: var.slipstream_secret_arn may feed only the API and its miner credential policy')
        for match in re.finditer(r'"([A-Za-z0-9*?-]+:[A-Za-z0-9*?]+|\*)"', text):
            action = match.group(1)
            if action == '*':
                # Refuse "*" anywhere in an Action value, however the key is written: `Action = "*"`,
                # `"Action": ["s3:X", "*"]` in a heredoc, `actions = [...]`.
                keys = list(re.finditer(r'["\']?\bactions?\b["\']?\s*[:=]\s*', text[:match.start()], re.I))
                require(not keys or not re.fullmatch(r'(?:\[[^\]]*)?', text[keys[-1].end():match.start()]),
                        f'{path.name}: wildcard IAM action')
            elif reads_secrets(action):
                require(inside(MINER_POLICY, match.start()) and action == MINER_GRANT['Action'],
                        f'{path.name}: {action} would grant Secrets Manager access outside the miner credential policy')
        if MINER_POLICY in blocks:
            start, end = blocks[MINER_POLICY]
            body = text[start:end]
            require(re.search(r'\brole\s*=\s*aws_iam_role\.lambda\["api"\]\.id\b', body)
                    and re.search(r'Resource\s*=\s*var\.slipstream_secret_arn\b', body)
                    and len(re.findall(r'\bEffect\s*=', body)) == 1,
                    'aws_iam_role_policy.miner_credential must be one statement on the API role for '
                    'var.slipstream_secret_arn')
    for path in sorted((root / 'policies').glob('*.json')):
        for statement in json.loads(path.read_text()):
            require('NotAction' not in statement, f'policies/{path.name}: NotAction is not allowed')
            require(not any(reads_secrets(a) for a in as_list(statement.get('Action'))),
                    f'policies/{path.name}: Secrets Manager access is not allowed')


def secret_grants(rows):
    """(policy row, statement) for every known planned role-policy statement that could read a secret."""
    grants = []
    for row in rows:
        if row['type'] != 'aws_iam_role_policy':
            continue
        document = row.get('values', {}).get('policy')
        if not isinstance(document, str):
            # Unknown at plan (it names a resource created in this apply): static_secret_rules covers its source.
            require(row['name'] != 'miner_credential', 'the miner credential policy must be known at plan')
            continue
        for statement in as_list(json.loads(document).get('Statement')):
            require('NotAction' not in statement, f'aws_iam_role_policy.{row["name"]}: NotAction is not allowed')
            if any(reads_secrets(a) for a in as_list(statement.get('Action'))):
                grants.append((row, statement))
    return grants


def config_env_references(configuration, name):
    """References behind a Lambda's environment map in a saved plan's configuration section."""
    resources = {r['address']: r for r in (configuration or {}).get('root_module', {}).get('resources', [])}
    function = resources.get(f'aws_lambda_function.{name}')
    require(function is not None, f'aws_lambda_function.{name} missing from the plan configuration')
    variables = (function.get('expressions', {}).get('environment') or [{}])[0].get('variables', {})
    return set(variables.get('references', [])) if isinstance(variables, dict) else set()


def validate(rows, expanded, configuration=None, unknown_env=None):
    """unknown_env is unknown_lambda_env(): 'whole', or the set of keys whose values are unknown."""
    unknown_env = unknown_env or {}
    types = Counter(row['type'] for row in rows)
    require(not (types.keys() - ALLOWED), 'Unexpected application resource type')
    for kind, names in EXPECTED.items():
        selected = [r for r in rows if r['type'] == kind]
        require(len(selected) == len(names) and {r['name'] for r in selected} == names,
                f'Expected only {kind}: {sorted(names)}')
    roles = [r for r in rows if r['type'] == 'aws_iam_role']
    require(len(roles) == (5 if expanded else 3) and {r['name'] for r in roles} == {'lambda', 'workflow', 'operator_reconcile'}, 'Expected only Lambda/workflow service roles and one reconciliation operator role')
    if expanded:
        workflow_rules(rows)
        funcs = {r['name']: r for r in rows if r['type'] == 'aws_lambda_function'}
        envs = {name: dict((row.get('values', {}).get('environment') or [{}])[0].get('variables', {}) or {})
                for name, row in funcs.items()}
        whole = {name for name, how in unknown_env.items() if how == 'whole'}
        require(whole <= {'api'}, f'environment of {sorted(whole - {"api"})} is wholly unknown at plan; '
                                  'only the API environment is expected to be')
        # Partly unknown maps still name every key: check the keys, with unknown values as None.
        for name, how in unknown_env.items():
            if how != 'whole':
                envs[name].update({key: None for key in how})
        table = next((r.get('values', {}).get('name') for r in rows if r['type'] == 'aws_dynamodb_table'), None)
        for name in ('api', 'coordinator'):
            if name in whole:
                require(configuration is not None, 'the API environment is unknown until apply; pass a saved '
                                                   'plan with its configuration section')
                refs = config_env_references(configuration, name)
                require(refs <= API_ENV_REFERENCES, 'API environment draws on something not reviewed: '
                        f'{sorted(refs - API_ENV_REFERENCES)}')
                require('aws_dynamodb_table.records.name' in refs, 'API and coordinator must use the same table')
            else:
                value = envs[name].get('TABLE_NAME')
                require(value and (value == table if table else value == envs['coordinator'].get('TABLE_NAME')),
                        'API and coordinator must use the same table (TABLE_NAME must be known at plan)')
        require(all(not any(k.startswith('SUPERVISED_') for k in env) for env in envs.values()),
                'No supervised routing in application Lambda environments')
        require('AWS_BATCH_JOB_QUEUE' not in envs['api'] and 'AWS_BATCH_JOB_QUEUE' not in envs['reference'],
                'Only coordinator may receive the AWS Batch binding reference')
        for name in ('coordinator', 'reference'):
            require('SLIPSTREAM_SECRET_ARN' not in envs[name], 'Only the API may receive the miner credential reference')
        miner = [r for r in rows if r['type'] == 'aws_iam_role_policy' and r['name'] == 'miner_credential']
        require(len(miner) <= 1, 'At most one miner credential policy')
        grants = secret_grants(rows)
        require(all(row['name'] == 'miner_credential' for row, _ in grants),
                'Only the miner_credential policy may grant Secrets Manager access')
        for row, statement in grants:
            require({k: statement.get(k) for k in MINER_GRANT} == MINER_GRANT
                    and isinstance(statement.get('Resource'), str) and MINER_SECRET.match(statement['Resource'])
                    and set(statement) <= {'Sid', 'Effect', 'Action', 'Resource'},
                    'The miner credential grant must be GetSecretValue on the qsb/slipstream secret only')
        if miner:
            statements = as_list(json.loads(miner[0]['values']['policy']).get('Statement'))
            require(len(statements) == 1 and len(grants) == 1,
                    'The miner credential policy must be exactly one Secrets Manager read')
            api_role = next((r.get('values', {}).get('name') for r in rows
                             if r['type'] == 'aws_iam_role' and r['name'] == 'lambda' and r.get('index') == 'api'), None)
            owner = miner[0].get('values', {}).get('role')
            require(not (isinstance(owner, str) and isinstance(api_role, str)) or owner == api_role,
                    'The miner credential policy must belong to the API role')
        if 'api' not in whole:
            arn = envs['api'].get('SLIPSTREAM_SECRET_ARN')
            require(bool(miner) == ('SLIPSTREAM_SECRET_ARN' in envs['api']),
                    'The API receives the miner credential reference exactly when its read grant exists')
            require(arn is None or MINER_SECRET.match(arn), 'SLIPSTREAM_SECRET_ARN must name the qsb/slipstream secret')
            require(arn is None or all(statement.get('Resource') == arn for _, statement in grants),
                    'The miner credential grant must cover exactly the secret the API is given')
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


def unknown_lambda_env(changes):
    """How Terraform marks each Lambda's environment in after_unknown.

    Returns {name: 'whole'} when the block or the whole variables map is unknown (only key-less configuration
    references remain), or {name: {keys...}} when only some values are unknown: those key names are still known.
    A Lambda that isn't listed is fully known.
    """
    out = {}
    for row in changes:
        if row.get('type') != 'aws_lambda_function' or row.get('mode', 'managed') != 'managed':
            continue
        env = (row.get('change', {}).get('after_unknown') or {}).get('environment')
        if env is True or (isinstance(env, list) and env and (env[0] is True or
                                                               (isinstance(env[0], dict) and env[0].get('variables') is True))):
            out[row['name']] = 'whole'
        elif isinstance(env, list) and env and isinstance(env[0], dict) and isinstance(env[0].get('variables'), dict):
            require(all(v in (True, False) for v in env[0]['variables'].values()),
                    f"unrecognised after_unknown shape for aws_lambda_function.{row['name']}")
            keys = {k for k, v in env[0]['variables'].items() if v is True}
            if keys:
                out[row['name']] = keys
        elif env not in (None, [], [{}]):
            require(False, f"unrecognised after_unknown shape for aws_lambda_function.{row['name']}")
    return out


def module_resources(module):
    rows = [r for r in module.get('resources', []) if r.get('mode') == 'managed']
    for child in module.get('child_modules', []):
        rows.extend(module_resources(child))
    return rows


def main():
    root = Path(__file__).resolve().parents[1]
    static_secret_rules(root)
    if len(sys.argv) == 1:
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
            require(not flags, '--deploy and --first-apply need a saved plan from terraform show -json, '
                               'not terraform test output')
            events = [json.loads(line) for line in content.splitlines() if line.strip()]
            require(any(e.get('type') == 'test_summary' and e['test_summary']['status'] == 'pass' for e in events),
                    'Terraform test suite must pass before its mock plans count as evidence')
            result = {'evidence': 'mock-provider-plan-inventory', 'runs': {}}
            for event in events:
                name = event.get('@testrun')
                if event.get('type') == 'test_plan' and name in MOCK_RUNS:
                    rows = [dict(row, values=row['change']['after'])
                            for row in event['test_plan']['resource_changes']
                            if row.get('mode') == 'managed' and row['change']['after'] is not None]
                    result['runs'][name] = validate(rows, True, None,
                                                    unknown_lambda_env(event['test_plan']['resource_changes']))
            require(set(result['runs']) == MOCK_RUNS,
                    'The baseline, configured-provider and miner-credential plans are all required')
        else:
            result = validate(module_resources(plan['planned_values']['root_module']), True, plan.get('configuration'),
                              unknown_lambda_env(plan.get('resource_changes', [])))
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
