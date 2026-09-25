#!/usr/bin/env python3
"""Create the QSB human access identities rendered by this clean, pushed commit.

Requires an administrator profile (today the account root). Without --apply it only
prints the plan. It never changes an existing identity, never creates a password,
access key or MFA device, and prints names only (no ARNs or account numbers).
The operator sets the user's console password and MFA device afterwards.

--resume finishes a run that stopped partway: every identity that already exists must
match the rendered documents exactly (path, policy documents, trust, attachments, no
access keys); then only the missing ones are created. Anything that differs stops it.
"""
import argparse
import json
import re
import subprocess
import time
from pathlib import Path

from access import MANAGED_POLICY_LIMIT, access, size
from analyzer_readiness import ensure_analyzer

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--profile', required=True)
p.add_argument('--inventory', type=Path, required=True)
p.add_argument('--apply', action='store_true')
p.add_argument('--resume', action='store_true', help='finish a partial run; existing identities must match exactly')
a = p.parse_args()
c = json.loads(a.inventory.read_text())
root = Path(__file__).resolve().parents[2]
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip():
    raise SystemExit('Commit and push the clean checkout before bootstrap')
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
branch = subprocess.check_output(['git', 'branch', '--show-current'], cwd=root, text=True).strip()
remote = subprocess.check_output(['git', 'ls-remote', 'origin', 'refs/heads/' + branch], cwd=root, text=True).split()
if not remote or remote[0] != commit:
    raise SystemExit('Commit is not pushed to the matching remote branch')


def call(*args):
    """Run one AWS CLI call; return (ok, parsed output, error code). Never prints output."""
    r = subprocess.run(['aws', '--profile', a.profile, '--region', c['region'], '--output', 'json', '--no-cli-pager', '--cli-connect-timeout', '10', '--cli-read-timeout', '20', *args],
                       capture_output=True, text=True)
    if r.returncode:
        code = re.search(r'\(([A-Za-z]+)\)', r.stderr)
        return False, None, code.group(1) if code else 'error'
    return True, json.loads(r.stdout) if r.stdout.strip() else {}, None


def aws(*args):
    ok, output, code = call(*args)
    if not ok:
        raise SystemExit(f"{' '.join(args[:2])} failed: {code}; reconcile before retrying")
    return output


if aws('sts', 'get-caller-identity')['Account'] != c['account']:
    raise SystemExit('Account mismatch')
out = access(c)
tags = json.dumps([{'Key': 'Application', 'Value': 'qsb-vault'}, {'Key': 'SourceCommit', 'Value': commit}])
viewonly_names = [f'qsb-viewonly-{i}' for i in range(1, len(out['viewonly']['policies']) + 1)]
operator_names = [f'qsb-operator-{i}' for i in range(1, len(out['operator']['policies']) + 1)]
plan = {
    'commit': commit, 'apply': a.apply,
    'user': out['user']['path'] + out['user']['name'],
    'roles': {'qsb-viewonly': ['ViewOnlyAccess', *viewonly_names], 'qsb-operator': operator_names},
    'gpu_boundary': 'qsb-gpu-boundary',
    'external_access_analyzer': 'qsb-external-access (created only if the account has none)',
    'policy_sizes': {n: size(d) for n, d in zip(viewonly_names + operator_names,
                                                out['viewonly']['policies'] + out['operator']['policies'])},
}
for name, used in plan['policy_sizes'].items():
    if used > MANAGED_POLICY_LIMIT:
        raise SystemExit(f'{name} exceeds the managed policy size limit')
print(json.dumps(plan, indent=2), flush=True)
if not a.apply:
    raise SystemExit()

# Fail closed if anything already exists; inspect and reconcile it separately. Role, user
# and customer-managed policy names are unique account-wide, whatever their path.
roles = {r['RoleName']: r for r in aws('iam', 'list-roles')['Roles']}
policies = {x['PolicyName']: x for x in aws('iam', 'list-policies', '--scope', 'Local')['Policies']}
users = {u['UserName']: u for u in aws('iam', 'list-users')['Users']}
user = out['user']
documents = {'qsb-gpu-boundary': out['gpu_boundary']['document'],
             **dict(zip(viewonly_names, out['viewonly']['policies'])),
             **dict(zip(operator_names, out['operator']['policies']))}
clash = ({'qsb-viewonly', 'qsb-operator'} & set(roles)) | (set(documents) & set(policies)) | ({user['name']} & set(users))
if clash and not a.resume:
    raise SystemExit('Already exists, inspect before updating: ' + ', '.join(sorted(clash)))
if 'qsb-runtime-boundary' not in policies:
    raise SystemExit('Run bootstrap.py first: qsb-runtime-boundary is missing')


def drift(name, why):
    raise SystemExit(f'{name} exists but {why}; inspect it, --resume only finishes identical partial runs')


# --resume: prove every existing identity is exactly what this commit renders before any write.
for name in sorted(set(documents) & set(policies)):
    listed = policies[name]
    if listed.get('Path') != '/qsb/bootstrap/':
        drift(name, 'is not under /qsb/bootstrap/')
    version = aws('iam', 'get-policy-version', '--policy-arn', listed['Arn'], '--version-id', listed['DefaultVersionId'])
    if version['PolicyVersion']['Document'] != documents[name]:
        drift(name, 'differs from the rendered document')
if user['name'] in users:
    if users[user['name']].get('Path') != user['path']:
        drift(user['name'], 'is not under ' + user['path'])
    attached = {x['PolicyArn'] for x in aws('iam', 'list-attached-user-policies', '--user-name', user['name'])['AttachedPolicies']}
    inline = aws('iam', 'list-user-policies', '--user-name', user['name'])['PolicyNames']
    # A run can stop between creating the user and adding its policies: missing ones are
    # added below, anything extra stops the resume.
    if not attached <= set(user['managed']) or not set(inline) <= {'assume-qsb-roles'}:
        drift(user['name'], 'has policies this commit does not render')
    if inline:
        document = aws('iam', 'get-user-policy', '--user-name', user['name'], '--policy-name', 'assume-qsb-roles')['PolicyDocument']
        if document != user['inline']:
            drift(user['name'], 'has a different inline policy')
    user_missing = {'managed': sorted(set(user['managed']) - attached), 'inline': not inline}
    if aws('iam', 'list-access-keys', '--user-name', user['name'])['AccessKeyMetadata']:
        drift(user['name'], 'has access keys')
    if aws('iam', 'list-groups-for-user', '--user-name', user['name'])['Groups']:
        drift(user['name'], 'is in a group')
else:
    user_missing = None
expected_role_policies, role_attached = {}, {}
for role, names in (('viewonly', viewonly_names), ('operator', operator_names)):
    spec = out[role]
    expected_role_policies[role] = list(spec['managed']) + [policies[n]['Arn'] if n in policies else n for n in names]
    if spec['name'] not in roles:
        continue
    live = aws('iam', 'get-role', '--role-name', spec['name'])['Role']
    if live.get('Path') != spec['path'] or live.get('AssumeRolePolicyDocument') != spec['trust'] \
            or live.get('MaxSessionDuration') != spec['max_session']:
        drift(spec['name'], 'differs in path, trust or session length')
    attached = {x['PolicyArn'] for x in aws('iam', 'list-attached-role-policies', '--role-name', spec['name'])['AttachedPolicies']}
    if not attached <= set(expected_role_policies[role]) or aws('iam', 'list-role-policies', '--role-name', spec['name'])['PolicyNames']:
        drift(spec['name'], 'has policies this commit does not render')
    role_attached[role] = attached


# An analyzer failure must leave the create-once human identities untouched.
readiness = ensure_analyzer(aws, commit)
print(f'external-access analyzer {readiness}', flush=True)


def create_policy(name, document, description):
    return aws('iam', 'create-policy', '--policy-name', name, '--path', '/qsb/bootstrap/',
               '--policy-document', json.dumps(document), '--description', description, '--tags', tags)['Policy']['Arn']


arns = {name: policies[name]['Arn'] for name in documents if name in policies}
for name in ['qsb-gpu-boundary', *viewonly_names, *operator_names]:
    if name in arns:
        print('kept identical policy ' + name, flush=True)
        continue
    purpose = 'Maximum permissions of QSB GPU runtime roles' if name == 'qsb-gpu-boundary' \
        else f"QSB {name.split('-')[1]} access; administrator-managed"
    arns[name] = create_policy(name, documents[name], purpose)
    print('created policy ' + name, flush=True)

if user_missing is not None:
    for managed in user_missing['managed']:
        aws('iam', 'attach-user-policy', '--user-name', user['name'], '--policy-arn', managed)
    if user_missing['inline']:
        aws('iam', 'put-user-policy', '--user-name', user['name'], '--policy-name', 'assume-qsb-roles',
            '--policy-document', json.dumps(user['inline']))
    print('kept user ' + user['path'] + user['name'] + (' and added its missing policies'
          if user_missing['managed'] or user_missing['inline'] else ''), flush=True)
else:
    aws('iam', 'create-user', '--user-name', user['name'], '--path', user['path'], '--tags', tags)
    for managed in user['managed']:
        aws('iam', 'attach-user-policy', '--user-name', user['name'], '--policy-arn', managed)
    aws('iam', 'put-user-policy', '--user-name', user['name'], '--policy-name', 'assume-qsb-roles',
        '--policy-document', json.dumps(user['inline']))
    print('created user ' + user['path'] + user['name'] + ' (no password, no keys, no MFA yet)', flush=True)

# A trust policy naming a just-created user is rejected as MalformedPolicyDocument until IAM
# has propagated the new principal. Retry only that error, a bounded number of times.
ROLE_ATTEMPTS, ROLE_WAIT = 8, 5
for role, names in (('viewonly', viewonly_names), ('operator', operator_names)):
    spec = out[role]
    if spec['name'] in roles:
        missing = [arn for arn in list(spec['managed']) + [arns[n] for n in names] if arn not in role_attached[role]]
        for policy_arn in missing:
            aws('iam', 'attach-role-policy', '--role-name', spec['name'], '--policy-arn', policy_arn)
        print(f"kept role {spec['name']}" + (f' and attached {len(missing)} missing policies' if missing else ''),
              flush=True)
        continue
    for attempt in range(ROLE_ATTEMPTS):
        ok, _, code = call('iam', 'create-role', '--role-name', spec['name'], '--path', spec['path'],
                           '--assume-role-policy-document', json.dumps(spec['trust']),
                           '--max-session-duration', str(spec['max_session']),
                           '--description', f'QSB {role}: assumed by {user["name"]} with MFA', '--tags', tags)
        if ok:
            break
        if code != 'MalformedPolicyDocument' or attempt + 1 == ROLE_ATTEMPTS:
            raise SystemExit(f'iam create-role failed: {code}; reconcile before retrying (use --resume)')
        time.sleep(ROLE_WAIT)
    for policy_arn in list(spec['managed']) + [arns[n] for n in names]:
        aws('iam', 'attach-role-policy', '--role-name', spec['name'], '--policy-arn', policy_arn)
    print(f"created role {spec['name']} with {len(spec['managed']) + len(names)} managed policies", flush=True)
print(json.dumps({'done': True, 'commit': commit, 'next': 'set console password and TOTP MFA for the user as root'}),
      flush=True)
