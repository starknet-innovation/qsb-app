#!/usr/bin/env python3
"""Check root application resource inventory without reading credentials.

No argument checks declarations; a JSON plan from `terraform show -json` checks
expanded planned resources, including nested modules. Terraform test -json -verbose
JSONL checks the baseline and configured-provider mock plans. Bootstrap is separate.
Every mode first checks the source rules: secret access and the frontend upload order. Every plan is refused if it
both creates and deletes one frontend object key; --deploy also refuses replacing a frontend object or access block.

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
    'aws_sfn_state_machine', 'aws_cloudwatch_metric_alarm', 'aws_cloudwatch_log_metric_filter',
    'aws_lambda_function_url', 'aws_dynamodb_table_item',
    'aws_cloudfront_origin_access_control', 'aws_cloudfront_response_headers_policy',
    'aws_cloudfront_distribution', 'aws_scheduler_schedule', 'aws_lambda_function_event_invoke_config',
}
EXPECTED = {
    'aws_dynamodb_table': {'records'},
    'aws_s3_bucket': {'frontend'},
    'aws_lambda_function': {'api', 'coordinator', 'reference'},
    'aws_sfn_state_machine': {'withdrawal'},
    # The API's function URL, with AWS_IAM auth (terraform/web.tf), and the row naming the app's origin.
    'aws_lambda_function_url': {'api'},
    'aws_dynamodb_table_item': {'app_origin'},
    # CloudFront's two permissions on the API (terraform/web.tf): the stack's only Lambda permissions.
    'aws_lambda_permission': {'api_url', 'api_invoke'},
}
CLOUDFRONT_PERMISSIONS = {'api_url': 'lambda:InvokeFunctionUrl', 'api_invoke': 'lambda:InvokeFunction'}
# How a saved plan's configuration names the distribution's ARN, where the ARN is unknown until apply.
DISTRIBUTION_ARN_REFERENCES = {'aws_cloudfront_distribution.web.arn', 'aws_cloudfront_distribution.web'}
# The origin row's key in the records table (server/app.ts reads it).
APP_ORIGIN_KEY = {'pk': {'S': 'SYSTEM#DEPLOYMENT'}, 'sk': {'S': 'APP_ORIGIN'}}


# The scheduled webhook dispatcher (webhooks.tf), present only with webhook_dispatcher_enabled. Its resources come
# as a set: the function, its async-invoke settings, its records policy, the schedule and the schedule's role and
# policy. The due-delivery index is on the table either way (data.tf).
DISPATCHER_FUNCTION = 'webhooks'
DISPATCHER_POLICIES = {'webhook_records', 'webhook_schedule'}
DISPATCHER_ROLE = 'webhook_schedule'
DISPATCHER_ENV = {'TABLE_NAME'}
DUE_INDEX = 'webhook-due'
DUE_INDEX_KEYS = [['webhookQueue', 'HASH'], ['webhookDueAt', 'RANGE']]
# What the dispatcher's records policy may grant: Query on the due-delivery index, and GetItem and PutItem on the
# owners' webhook partitions (server/webhooks.ts WEBHOOK_PARTITION), which hold nothing but WEBHOOKS rows.
DISPATCHER_ACTIONS = {'FindDueOwners': ['dynamodb:Query'], 'ReadWriteWebhookRows': ['dynamodb:GetItem', 'dynamodb:PutItem']}
WEBHOOK_KEYS = {'ForAllValues:StringLike': {'dynamodb:LeadingKeys': ['WEBHOOK#*']}, 'Null': {'dynamodb:LeadingKeys': 'false'}}
# Schedule target settings that would send something other than an empty invoke, or send it elsewhere.
SCHEDULE_TARGET_BLOCKS = ('dead_letter_config', 'ecs_parameters', 'eventbridge_parameters', 'kinesis_parameters',
                          'sagemaker_pipeline_parameters', 'sqs_parameters')


def require(condition, message):
    if not condition:
        raise ValueError(message)


# Everything the API Lambda's environment may draw on (terraform/compute.tf). Where a real first plan leaves that
# environment unknown until apply, the plan's configuration references are checked against this list instead:
# any new reference fails closed until reviewed here.
# References carry no key names or constants; re-run with --deploy after the first apply, when the
# environment is known, and rely on the mock-plan tests for constants.
API_ENV_REFERENCES = {
    'aws_dynamodb_table.records', 'aws_dynamodb_table.records.name',
    'local.owner_limit_env', 'local.solver_release_id', 'local.workflow_arn',
    'var.api_keys_enabled', 'var.exact_submit_enabled', 'var.mainnet_enabled', 'var.network',
    'var.slipstream_secret_arn',
}
# The mocked `terraform test` plans whose expanded inventory must pass validate().
MOCK_RUNS = {'baseline', 'configured_single_pipeline', 'miner_credential_api_only', 'webhook_dispatcher_enabled'}
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


def due_index_rules(rows):
    """The table's one secondary index is the keys-only due-delivery index, whatever the switch."""
    table = next(r for r in rows if r['type'] == 'aws_dynamodb_table').get('values', {})
    indexes = table.get('global_secondary_index') or []
    require(len(indexes) == 1 and indexes[0].get('name') == DUE_INDEX and indexes[0].get('projection_type') == 'KEYS_ONLY'
            and not indexes[0].get('non_key_attributes')
            and ([[k.get('attribute_name'), k.get('key_type')] for k in indexes[0].get('key_schema') or []]
                 or [[indexes[0].get('hash_key'), 'HASH'], [indexes[0].get('range_key'), 'RANGE']]) == DUE_INDEX_KEYS
            and not (table.get('local_secondary_index') or []),
            'The table\'s only secondary index must be the keys-only due-delivery index, so a query of it returns no '
            'hook, secret or event')


def dispatcher_rules(rows, dispatcher):
    """The scheduled webhook dispatcher: all of it or none of it, each grant exactly scoped."""
    by_type = lambda kind, names: [r for r in rows if r['type'] == kind and r['name'] in names]
    schedules = [r for r in rows if r['type'] == 'aws_scheduler_schedule']
    invoke_configs = [r for r in rows if r['type'] == 'aws_lambda_function_event_invoke_config']
    policies = {r['name']: r for r in by_type('aws_iam_role_policy', DISPATCHER_POLICIES)}
    schedule_roles = by_type('aws_iam_role', {DISPATCHER_ROLE})
    table = next(r for r in rows if r['type'] == 'aws_dynamodb_table').get('values', {})
    if not dispatcher:
        require(not schedules and not invoke_configs and not policies and not schedule_roles,
                'The webhook schedule, its roles and invoke settings come only with the webhook dispatcher')
        return
    require(len(schedules) == 1 and schedules[0]['name'] == DISPATCHER_FUNCTION and set(policies) == DISPATCHER_POLICIES
            and len(schedule_roles) == 1 and len(invoke_configs) == 1 and invoke_configs[0]['name'] == DISPATCHER_FUNCTION,
            'The webhook dispatcher needs exactly its schedule, schedule role, two policies and invoke settings')
    function = next(r for r in rows if r['type'] == 'aws_lambda_function' and r['name'] == DISPATCHER_FUNCTION)['values']
    invoke = invoke_configs[0].get('values', {})
    require(invoke.get('function_name') == function.get('function_name') and invoke.get('qualifier') in (None, '')
            and invoke.get('maximum_retry_attempts') == 0 and not invoke.get('destination_config'),
            'Lambda must not retry the webhook dispatcher or send its results anywhere')
    schedule = schedules[0].get('values', {})
    rate = re.fullmatch(r'rate\((\d+) minutes?\)', str(schedule.get('schedule_expression')))
    require(rate and int(rate.group(1)) >= 1, 'The webhook schedule must be a rate of at least one minute')
    require(schedule.get('group_name') in (None, 'default'), 'The webhook schedule must be in the default group')
    target = (schedule.get('target') or [{}])[0]
    function_arn = target.get('arn')
    target_arn = re.fullmatch(r'arn:aws[a-z-]*:lambda:[a-z0-9-]+:([0-9]{12}):function:([A-Za-z0-9_-]+)', str(function_arn))
    require(target_arn is not None and target_arn.group(2) == function.get('function_name'),
            'The webhook schedule must invoke the webhook dispatcher and nothing else')
    retry = target.get('retry_policy') or [{}]
    require(target.get('input') in (None, '') and not any(target.get(block) for block in SCHEDULE_TARGET_BLOCKS)
            and len(retry) == 1 and retry[0].get('maximum_retry_attempts') == 0,
            'The webhook schedule must send an empty invoke with no retry, dead-letter queue or target parameters')
    # The role Scheduler assumes. Unknown until the role exists; then it must be the schedule role.
    role_arn, schedule_role_arn = target.get('role_arn'), schedule_roles[0].get('values', {}).get('arn')
    require(role_arn is None or (isinstance(schedule_role_arn, str) and role_arn == schedule_role_arn),
            'The webhook schedule must run with its own schedule role')
    # The stack's own account, from the dispatcher's ARN: the schedule role trusts Scheduler for this account only.
    account = target_arn.group(1)
    trust = json.loads(schedule_roles[0].get('values', {}).get('assume_role_policy') or '{}').get('Statement')
    require(isinstance(trust, list) and len(trust) == 1 and trust[0].get('Principal') == {'Service': 'scheduler.amazonaws.com'}
            and trust[0].get('Action') == 'sts:AssumeRole' and trust[0].get('Effect') == 'Allow'
            and trust[0].get('Condition') == {'StringEquals': {'aws:SourceAccount': account}},
            'The schedule role must trust only EventBridge Scheduler, from this account')
    documents = {}
    for name, row in policies.items():
        document = row.get('values', {}).get('policy')
        require(isinstance(document, str), f'aws_iam_role_policy.{name} must be known at plan')
        documents[name] = as_list(json.loads(document).get('Statement'))
    require(documents['webhook_schedule'] == [{'Effect': 'Allow', 'Action': 'lambda:InvokeFunction', 'Resource': function_arn}],
            'The schedule role may only invoke the webhook dispatcher')
    records = {s.get('Sid'): s for s in documents['webhook_records']}
    require(len(records) == len(documents['webhook_records']) and set(records) == set(DISPATCHER_ACTIONS)
            and all(s.get('Effect') == 'Allow' and s.get('Action') == DISPATCHER_ACTIONS[sid] for sid, s in records.items()),
            'The webhook dispatcher may only Query the due-delivery index and GetItem/PutItem webhook rows')
    table_arn = records['ReadWriteWebhookRows'].get('Resource')
    require(isinstance(table_arn, str) and table_arn.endswith(f':{account}:table/' + str(table.get('name')))
            and records['FindDueOwners'].get('Resource') == f'{table_arn}/index/{DUE_INDEX}'
            and 'Condition' not in records['FindDueOwners'],
            'The webhook dispatcher reaches only the records table and its due-delivery index')
    require(records['ReadWriteWebhookRows'].get('Condition') == WEBHOOK_KEYS,
            'The webhook dispatcher may only read and write present WEBHOOK# keys: no job, vault, intent, event or '
            'reservation row')
    # Known after the first apply: each dispatcher policy belongs to its own role, and the dispatcher role has no other.
    dispatcher_role = next((r.get('values', {}).get('name') for r in rows if r['type'] == 'aws_iam_role'
                            and r['name'] == 'lambda' and r.get('index') == DISPATCHER_FUNCTION), None)
    schedule_role = schedule_roles[0].get('values', {}).get('name')
    for row in rows:
        owner = row.get('values', {}).get('role') if row['type'] == 'aws_iam_role_policy' else None
        if not isinstance(owner, str):
            continue
        if isinstance(dispatcher_role, str) and owner == dispatcher_role:
            require(row['name'] in ('logs', 'webhook_records'), 'The webhook dispatcher role has only its logs and records policies')
        if isinstance(schedule_role, str) and owner == schedule_role:
            require(row['name'] == 'webhook_schedule', 'The schedule role has only its invoke policy')


def static_dispatcher_rules(root):
    """Source rules for the webhook dispatcher's two roles, which hold even while role names are unknown at plan."""
    allowed = {'aws_iam_role.lambda["webhooks"]': {('aws_iam_role_policy', 'webhook_records'), ('aws_lambda_function', 'webhooks')},
               'aws_iam_role.webhook_schedule': {('aws_iam_role_policy', 'webhook_schedule'), ('aws_scheduler_schedule', 'webhooks')}}
    scheduled = False
    for path in sorted(root.glob('*.tf')):
        text = path.read_text()
        blocks = list(resource_blocks(text))
        for kind, name, start, end in blocks:
            if (kind, name) == ('aws_scheduler_schedule', 'webhooks'):
                body = text[start:end]
                scheduled = True
                require(re.search(r'\brole_arn\s*=\s*aws_iam_role\.webhook_schedule\[0\]\.arn\s*$', body, re.M)
                        and re.search(r'^\s*arn\s*=\s*local\.webhook_function_arn\s*$', body, re.M),
                        f'{path.name}: aws_scheduler_schedule.webhooks must invoke local.webhook_function_arn with '
                        'aws_iam_role.webhook_schedule[0].arn')
        for reference, owners in allowed.items():
            for match in re.finditer(re.escape(reference), text):
                inside = [(kind, name) for kind, name, start, end in blocks if start <= match.start() < end]
                require(inside and inside[-1] in owners,
                        f'{path.name}: only {sorted(f"{k}.{n}" for k, n in owners)} may use {reference}')
    require(scheduled, 'aws_scheduler_schedule.webhooks is missing from the source')


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


def frontend_order_rules(root):
    """The upload order that keeps the served index.html naming only objects that exist (see terraform/data.tf).

    index.html alone names the hashed assets, so aws_s3_object.index waits for every other frontend object, and
    those use create_before_destroy, so a file dropped from the build is deleted only after the new index.html is
    uploaded. The existing index.html object must move to aws_s3_object.index rather than be destroyed and created
    again, which a plan without prior state can't show. Plans show neither lifecycle nor depends_on either, so this
    reads the source."""
    blocks, moves = {}, []
    for path in sorted(root.glob('*.tf')):
        text = path.read_text()
        blocks.update({name: text[start:end] for kind, name, start, end in resource_blocks(text) if kind == 'aws_s3_object'})
        for match in re.finditer(r'^\s*moved\s*\{', text, re.M):
            depth, end = 1, match.end()
            while depth and end < len(text):
                depth += {'{': 1, '}': -1}.get(text[end], 0)
                end += 1
            body = text[match.end():end - 1]
            side = lambda name: next(iter(re.findall(rf'^\s*{name}\s*=\s*(\S+)\s*$', body, re.M)), None)
            moves.append((side('from'), side('to')))
    require([m for m in moves if any('aws_s3_object.' in str(side) for side in m)]
            == [('aws_s3_object.frontend["index.html"]', 'aws_s3_object.index')],
            'exactly one moved { from = aws_s3_object.frontend["index.html"], to = aws_s3_object.index } must keep the '
            'existing index.html object')
    require(set(blocks) == {'frontend', 'index'}, 'the frontend is uploaded as aws_s3_object.frontend and aws_s3_object.index only')
    require(re.search(r'\bfor_each\s*=\s*setsubtract\([^\n]*,\s*\[\s*"index\.html"\s*\]\s*\)', blocks['frontend']),
            'aws_s3_object.frontend must leave index.html to aws_s3_object.index')
    require(re.search(r'\blifecycle\s*\{[^}]*\bcreate_before_destroy\s*=\s*true\b', blocks['frontend']),
            'aws_s3_object.frontend needs create_before_destroy, so removed files are deleted after the new index.html')
    require(re.search(r'\bkey\s*=\s*"index\.html"', blocks['index'])
            and re.search(r'\bdepends_on\s*=\s*\[[^\]]*\baws_s3_object\.frontend\b', blocks['index']),
            'aws_s3_object.index must upload index.html after every aws_s3_object.frontend object')


def frontend_key_rules(changes):
    """No plan may both create and delete the same frontend object key.

    Every aws_s3_object in this stack is in the frontend bucket, and S3 holds one object per key. Creating a key at
    one address and deleting it at another leaves it missing for part of the apply (a pre-split commit applied over
    post-split state deletes index.html, then uploads it again). Replacing one in place with create_before_destroy
    deletes the upload itself: the provider removes every version of the key."""
    created, deleted = set(), set()
    for row in changes:
        if row.get('type') != 'aws_s3_object' or row.get('mode', 'managed') != 'managed':
            continue
        change = row.get('change', {})
        if 'create' in change.get('actions', []):
            created.add((change.get('after') or {}).get('key'))
        if 'delete' in change.get('actions', []):
            deleted.add((change.get('before') or {}).get('key'))
    both = sorted(str(key) for key in created & deleted)
    require(not both, f'the plan both creates and deletes frontend object key(s) {both}; for a commit from before the '
                      'index.html split, follow "Rolling back past the index.html split" in docs/OPERATIONAL-RUNBOOK.md')


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


def cloudfront_permission_rules(rows, configuration):
    """Each Lambda permission lets CloudFront invoke the API for this stack's distribution only. The IAM guards
    can't check a permission's SourceArn (ops/github-aws/README.md), so the plan must."""
    distribution = next((r for r in rows if r['type'] == 'aws_cloudfront_distribution' and r['name'] == 'web'), {})
    arn = distribution.get('values', {}).get('arn')
    resources = {r['address']: r for r in (configuration or {}).get('root_module', {}).get('resources', [])}
    for row in (r for r in rows if r['type'] == 'aws_lambda_permission'):
        values, address = row.get('values', {}), f"aws_lambda_permission.{row['name']}"
        require(values.get('principal') == 'cloudfront.amazonaws.com' and
                values.get('action') == CLOUDFRONT_PERMISSIONS[row['name']],
                f'{address} must grant {CLOUDFRONT_PERMISSIONS[row["name"]]} to cloudfront.amazonaws.com')
        if values.get('source_arn') is not None:
            require(arn is not None and values['source_arn'] == arn,
                    f"{address} must name this stack's distribution as its source_arn")
        else:
            expression = resources.get(address, {}).get('expressions', {}).get('source_arn', {})
            require(set(expression.get('references', [])) == DISTRIBUTION_ARN_REFERENCES,
                    f'{address}: source_arn is unknown at plan, so it must be aws_cloudfront_distribution.web.arn '
                    "in the saved plan's configuration section")


def app_origin_rules(rows):
    """The origin row is exactly SYSTEM#DEPLOYMENT / APP_ORIGIN in the records table, naming this stack's
    distribution. A deploy can write any row through an aws_dynamodb_table_item, and the API names this origin in
    its sign-in challenges, so both its key and its value must be known at plan and match."""
    values = next(r for r in rows if r['type'] == 'aws_dynamodb_table_item').get('values', {})
    table = next((r.get('values', {}).get('name') for r in rows if r['type'] == 'aws_dynamodb_table'), None)
    domain = next((r.get('values', {}).get('domain_name') for r in rows
                   if r['type'] == 'aws_cloudfront_distribution' and r['name'] == 'web'), None)
    require(table is not None and values.get('table_name') == table and values.get('hash_key') == 'pk' and
            values.get('range_key') == 'sk', 'aws_dynamodb_table_item.app_origin must be in the records table, keyed by pk and sk')
    require(isinstance(values.get('item'), str) and domain is not None,
            'aws_dynamodb_table_item.app_origin and the distribution domain must be known at plan')
    require(json.loads(values['item']) == dict(APP_ORIGIN_KEY, version={'N': '0'}, origin={'S': f'https://{domain}'}),
            "aws_dynamodb_table_item.app_origin must be exactly the SYSTEM#DEPLOYMENT / APP_ORIGIN row naming this "
            "stack's distribution")


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
    dispatcher = any(r['type'] == 'aws_lambda_function' and r['name'] == DISPATCHER_FUNCTION for r in rows)
    for kind, names in EXPECTED.items():
        if kind == 'aws_lambda_function' and dispatcher:
            names = names | {DISPATCHER_FUNCTION}
        selected = [r for r in rows if r['type'] == kind]
        require(len(selected) == len(names) and {r['name'] for r in selected} == names,
                f'Expected only {kind}: {sorted(names)}')
    for url in (r for r in rows if expanded and r['type'] == 'aws_lambda_function_url'):
        require(url.get('values', {}).get('authorization_type') == 'AWS_IAM',
                'the API function URL must take AWS_IAM auth, so only CloudFront origin access control can call it')
    roles = [r for r in rows if r['type'] == 'aws_iam_role']
    role_names = {'lambda', 'workflow', 'operator_reconcile'} | ({DISPATCHER_ROLE} if dispatcher else set())
    require(len(roles) == ((7 if dispatcher else 5) if expanded else len(role_names)) and {r['name'] for r in roles} == role_names,
            'Expected only Lambda/workflow service roles, one reconciliation operator role and, with the webhook '
            'dispatcher, its schedule role')
    if expanded:
        workflow_rules(rows)
        cloudfront_permission_rules(rows, configuration)
        app_origin_rules(rows)
        due_index_rules(rows)
        dispatcher_rules(rows, dispatcher)
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
        require(all('AWS_BATCH_JOB_QUEUE' not in env for name, env in envs.items() if name != 'coordinator'),
                'Only coordinator may receive the AWS Batch binding reference')
        for name in envs.keys() - {'api'}:
            require('SLIPSTREAM_SECRET_ARN' not in envs[name], 'Only the API may receive the miner credential reference')
        if dispatcher:
            require(DISPATCHER_FUNCTION not in whole and set(envs[DISPATCHER_FUNCTION]) == DISPATCHER_ENV
                    and table is not None and envs[DISPATCHER_FUNCTION]['TABLE_NAME'] == table,
                    'The webhook dispatcher gets only TABLE_NAME, the records table: no mainnet, workflow, compute, '
                    'reference or credential setting')
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


def region_checks(plan):
    """Refuse a plan that would move an existing stack to another region, or recreate resources it lost.

    With AWS provider 6.x each resource keeps its region in state and is refreshed there, so a change of
    var.region shows up as existing resources whose ARNs name another region: refuse those. Separately,
    resources in state that refresh no longer finds (deleted outside Terraform) would be recreated
    silently: refuse that drift too. The region_pin resource refuses the change at plan as well.
    See docs/REGION-MIGRATION.md."""
    region = (plan.get('variables', {}).get('region') or {}).get('value')
    require(isinstance(region, str) and region, 'the plan must set var.region explicitly')
    gone = [r['address'] for r in plan.get('resource_drift', [])
            if r.get('mode') == 'managed' and 'delete' in r.get('change', {}).get('actions', [])]
    require(not gone, f'{len(gone)} resources in state were not found (e.g. {", ".join(gone[:3])}): deleted '
                      'outside Terraform, or planned with the wrong credentials. Investigate before applying')
    for row in module_resources((plan.get('prior_state') or {}).get('values', {}).get('root_module', {})):
        parts = str(row.get('values', {}).get('arn') or '').split(':')
        if len(parts) > 3 and parts[3]:  # global services (IAM, CloudFront, S3 buckets) carry no region
            require(parts[3] == region, f"{row['type']}.{row['name']} is in {parts[3]}, not {region}")
    return region


def deploy_checks(plan, first_apply):
    """What the scoped deploy and operator roles need in order to manage what an admin first applied."""
    region = region_checks(plan)
    # A wrong backend bucket or state key loads an empty state, and a plan against it only creates, so it
    # would start a second stack while the live one stays unmanaged. Only a first apply may start empty.
    existing = module_resources((plan.get('prior_state') or {}).get('values', {}).get('root_module', {}))
    require(first_apply or existing, 'the state holds no resources: wrong backend bucket or key? A new stack '
                                     'needs --first-apply')
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
    # Frontend objects and, through them, the access block are create_before_destroy: a replacement writes the new
    # one and then deletes it (the same S3 key, or the bucket's only access block).
    for r in plan.get('resource_changes', []):
        actions = r.get('change', {}).get('actions', [])
        require(not (r.get('type') in ('aws_s3_object', 'aws_s3_bucket_public_access_block')
                     and 'create' in actions and 'delete' in actions),
                f"{r.get('address')} must not be replaced; see \"Upload order\" in terraform/README.md")
    if first_apply:
        actions = {tuple(r['change']['actions']) for r in plan.get('resource_changes', []) if r.get('mode') == 'managed'}
        require(actions <= {('create',)}, 'first apply must be create-only: the state key must be empty and no '
                                          'resource may already exist')
    return {'deployChecks': 'passed', 'roles': len(roles), 'firstApply': first_apply, 'region': region}


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
    static_dispatcher_rules(root)
    frontend_order_rules(root)
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
                if event.get('type') == 'test_plan':
                    # Every planned run, including the migration runs that plan against seeded state.
                    frontend_key_rules(event['test_plan'].get('resource_changes', []))
                if event.get('type') == 'test_plan' and name in MOCK_RUNS:
                    rows = [dict(row, values=row['change']['after'])
                            for row in event['test_plan']['resource_changes']
                            if row.get('mode') == 'managed' and row['change']['after'] is not None]
                    result['runs'][name] = validate(rows, True, None,
                                                    unknown_lambda_env(event['test_plan']['resource_changes']))
            require(set(result['runs']) == MOCK_RUNS,
                    'The baseline, configured-provider, miner-credential and webhook-dispatcher plans are all required')
        else:
            frontend_key_rules(plan.get('resource_changes', []))
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
