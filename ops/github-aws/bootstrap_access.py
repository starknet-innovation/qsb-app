#!/usr/bin/env python3
"""Create the QSB human access identities rendered by this clean, pushed commit.

Requires an administrator profile (today the account root). Without --apply it only
prints the plan. It never changes an existing identity, never creates a password,
access key or MFA device, and prints names only (no ARNs or account numbers).
The operator sets the user's console password and MFA device afterwards.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

from access import MANAGED_POLICY_LIMIT, access, size

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--profile', required=True)
p.add_argument('--inventory', type=Path, required=True)
p.add_argument('--apply', action='store_true')
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


def aws(*args):
    r = subprocess.run(['aws', '--profile', a.profile, '--region', c['region'], '--output', 'json', '--no-cli-pager', *args],
                       capture_output=True, text=True)
    if r.returncode:
        code = re.search(r'\(([A-Za-z]+)\)', r.stderr)
        raise SystemExit(f"{' '.join(args[:2])} failed: {code.group(1) if code else 'error'}; reconcile before retrying")
    return json.loads(r.stdout) if r.stdout.strip() else {}


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
roles = {r['RoleName'] for r in aws('iam', 'list-roles')['Roles']}
policies = {x['PolicyName'] for x in aws('iam', 'list-policies', '--scope', 'Local')['Policies']}
users = {u['UserName'] for u in aws('iam', 'list-users')['Users']}
clash = ({'qsb-viewonly', 'qsb-operator'} & roles) | ({'qsb-gpu-boundary', *viewonly_names, *operator_names} & policies) \
    | ({out['user']['name']} & users)
if clash:
    raise SystemExit('Already exists, inspect before updating: ' + ', '.join(sorted(clash)))
if 'qsb-runtime-boundary' not in policies:
    raise SystemExit('Run bootstrap.py first: qsb-runtime-boundary is missing')


def create_policy(name, document, description):
    return aws('iam', 'create-policy', '--policy-name', name, '--path', '/qsb/bootstrap/',
               '--policy-document', json.dumps(document), '--description', description, '--tags', tags)['Policy']['Arn']


create_policy('qsb-gpu-boundary', out['gpu_boundary']['document'], 'Maximum permissions of QSB GPU runtime roles')
print('created policy qsb-gpu-boundary', flush=True)
attached = {}
for role, names in (('viewonly', viewonly_names), ('operator', operator_names)):
    attached[role] = list(out[role]['managed'])
    for name, document in zip(names, out[role]['policies']):
        attached[role].append(create_policy(name, document, f'QSB {role} access; administrator-managed'))
        print('created policy ' + name, flush=True)

user = out['user']
aws('iam', 'create-user', '--user-name', user['name'], '--path', user['path'], '--tags', tags)
for managed in user['managed']:
    aws('iam', 'attach-user-policy', '--user-name', user['name'], '--policy-arn', managed)
aws('iam', 'put-user-policy', '--user-name', user['name'], '--policy-name', 'assume-qsb-roles',
    '--policy-document', json.dumps(user['inline']))
print('created user ' + user['path'] + user['name'] + ' (no password, no keys, no MFA yet)', flush=True)

for role in ('viewonly', 'operator'):
    spec = out[role]
    aws('iam', 'create-role', '--role-name', spec['name'], '--path', spec['path'],
        '--assume-role-policy-document', json.dumps(spec['trust']), '--max-session-duration', str(spec['max_session']),
        '--description', f'QSB {role}: assumed by {user["name"]} with MFA', '--tags', tags)
    for policy_arn in attached[role]:
        aws('iam', 'attach-role-policy', '--role-name', spec['name'], '--policy-arn', policy_arn)
    print(f"created role {spec['name']} with {len(attached[role])} managed policies", flush=True)
# Role trust and S3 bucket policies can name outside principals; flag any such access.
if not aws('accessanalyzer', 'list-analyzers', '--type', 'ACCOUNT')['analyzers']:
    aws('accessanalyzer', 'create-analyzer', '--analyzer-name', 'qsb-external-access', '--type', 'ACCOUNT',
        '--tags', json.dumps({'Application': 'qsb-vault', 'SourceCommit': commit}))
    print('created external-access analyzer qsb-external-access', flush=True)
else:
    print('an external-access analyzer already exists; kept it', flush=True)
print(json.dumps({'done': True, 'commit': commit, 'next': 'set console password and TOTP MFA for the user as root'}),
      flush=True)
