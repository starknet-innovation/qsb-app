#!/usr/bin/env python3
"""Bring installed QSB administrator-managed IAM in line with this clean, pushed commit.

bootstrap.py and bootstrap_access.py create identities once and never change them, so a
reviewed renderer change doesn't reach AWS by itself. This compares every installed
administrator-managed QSB document with what this commit renders:

- qsb-github-deploy's inline deployment policy and qsb-runtime-boundary (render.py);
- qsb-gpu-boundary, the qsb-viewonly-N and qsb-operator-N policies, the operator user's
  inline policy, and the two roles' trust and session length (access.py).

Without --apply it prints the plan: for each target `identical`, `missing` or `differs`,
with the statement IDs added, removed or changed. With --apply (administrator profile,
today the account root) it updates only what differs, then re-reads each change. It
never creates or deletes an identity, never deletes a policy version, and refuses when
a managed policy already has the IAM maximum of five versions or when the number of
rendered access policies changed. It prints names and statement IDs only.
"""
import argparse
import json
import re
import subprocess
from pathlib import Path

from access import access
from render import render

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--profile', required=True)
p.add_argument('--inventory', type=Path, required=True)
p.add_argument('--apply', action='store_true')
a = p.parse_args()
c = json.loads(a.inventory.read_text())
root = Path(__file__).resolve().parents[2]
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip():
    raise SystemExit('Commit and push the clean checkout before updating installed IAM')
commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
branch = subprocess.check_output(['git', 'branch', '--show-current'], cwd=root, text=True).strip()
remote = subprocess.check_output(['git', 'ls-remote', 'origin', 'refs/heads/' + branch], cwd=root, text=True).split()
if not remote or remote[0] != commit:
    raise SystemExit('Commit is not pushed to the matching remote branch')


def aws(*args, readable=False):
    """One AWS CLI call. With readable=True in plan mode, an AccessDenied read returns None instead of stopping."""
    r = subprocess.run(['aws', '--profile', a.profile, '--region', c['region'], '--output', 'json', '--no-cli-pager',
                        '--cli-connect-timeout', '10', '--cli-read-timeout', '20', *args], capture_output=True, text=True)
    if r.returncode:
        code = re.search(r'\(([A-Za-z]+)\)', r.stderr)
        code = code.group(1) if code else 'error'
        if readable and not a.apply and code in ('AccessDenied', 'AccessDeniedException'):
            return None
        raise SystemExit(f"{' '.join(args[:2])} failed: {code}; nothing after it ran")
    return json.loads(r.stdout) if r.stdout.strip() else {}


def statement_diff(installed, rendered):
    """Statement IDs added, removed and changed between two policy documents."""
    sid = lambda doc: {s.get('Sid', f'#{i}'): s for i, s in enumerate(doc.get('Statement', []))}
    old, new = sid(installed or {}), sid(rendered)
    return {'added': sorted(set(new) - set(old)), 'removed': sorted(set(old) - set(new)),
            'changed': sorted(k for k in set(old) & set(new) if old[k] != new[k])}


if aws('sts', 'get-caller-identity')['Account'] != c['account']:
    raise SystemExit('Account mismatch')
rendered, human = render(c), access(c)
listed = {x['PolicyName']: x for x in aws('iam', 'list-policies', '--scope', 'Local', '--path-prefix', '/qsb/bootstrap/')['Policies']}
names = {'viewonly': sorted(n for n in listed if re.fullmatch(r'qsb-viewonly-\d+', n)),
         'operator': sorted(n for n in listed if re.fullmatch(r'qsb-operator-\d+', n))}
for role in ('viewonly', 'operator'):
    if names[role] and len(names[role]) != len(human[role]['policies']):
        raise SystemExit(f'qsb-{role} now renders {len(human[role]["policies"])} policies but {len(names[role])} are '
                         'installed; adding or removing access policies needs a separately reviewed step')

targets = []  # (label, kind, installed document or value, rendered, apply function)
UNREADABLE = object()  # plan mode only: this profile may not read the target
blockers = []  # refusals found while planning; checked before any write


def managed(name, document):
    if name not in listed:
        targets.append((name, 'missing', None, document, None))
        return
    pol = listed[name]
    live = aws('iam', 'get-policy-version', '--policy-arn', pol['Arn'], '--version-id', pol['DefaultVersionId'])
    versions = aws('iam', 'list-policy-versions', '--policy-arn', pol['Arn'])['Versions']
    if live['PolicyVersion']['Document'] != document and len(versions) >= 5:
        blockers.append(f'{name} already has 5 versions; remove an old one as an administrator first')

    def update():
        aws('iam', 'create-policy-version', '--policy-arn', pol['Arn'], '--policy-document', json.dumps(document),
            '--set-as-default')
        latest = aws('iam', 'get-policy', '--policy-arn', pol['Arn'])['Policy']['DefaultVersionId']
        if aws('iam', 'get-policy-version', '--policy-arn', pol['Arn'], '--version-id', latest)['PolicyVersion']['Document'] != document:
            raise SystemExit(f'{name}: the new default version does not read back as rendered; inspect it')
    targets.append((name, 'policy', live['PolicyVersion']['Document'], document, update))


managed('qsb-runtime-boundary', rendered['boundary'])
managed('qsb-gpu-boundary', human['gpu_boundary']['document'])
for role in ('viewonly', 'operator'):
    for name, document in zip(names[role], human[role]['policies']):
        managed(name, document)

deploy_policies = aws('iam', 'list-role-policies', '--role-name', 'qsb-github-deploy')['PolicyNames']
if deploy_policies != ['qsb-terraform-deployment']:
    raise SystemExit('qsb-github-deploy has unexpected inline policies; inspect it')
live_deploy = aws('iam', 'get-role-policy', '--role-name', 'qsb-github-deploy',
                  '--policy-name', 'qsb-terraform-deployment')['PolicyDocument']


def update_deploy():
    aws('iam', 'put-role-policy', '--role-name', 'qsb-github-deploy', '--policy-name', 'qsb-terraform-deployment',
        '--policy-document', json.dumps(rendered['deploy']))
    if aws('iam', 'get-role-policy', '--role-name', 'qsb-github-deploy',
           '--policy-name', 'qsb-terraform-deployment')['PolicyDocument'] != rendered['deploy']:
        raise SystemExit('qsb-github-deploy: the updated policy does not read back as rendered; inspect it')


targets.append(('qsb-github-deploy/qsb-terraform-deployment', 'policy', live_deploy, rendered['deploy'], update_deploy))

user = human['user']
live_user = aws('iam', 'get-user-policy', '--user-name', user['name'], '--policy-name', 'assume-qsb-roles', readable=True)
live_user = UNREADABLE if live_user is None else live_user['PolicyDocument']


def update_user():
    aws('iam', 'put-user-policy', '--user-name', user['name'], '--policy-name', 'assume-qsb-roles',
        '--policy-document', json.dumps(user['inline']))


targets.append((f"{user['name']}/assume-qsb-roles", 'policy', live_user, user['inline'], update_user))

for role in ('viewonly', 'operator'):
    spec = human[role]
    live = aws('iam', 'get-role', '--role-name', spec['name'])['Role']
    targets.append((f"{spec['name']} trust", 'policy', live['AssumeRolePolicyDocument'], spec['trust'],
                    lambda spec=spec: aws('iam', 'update-assume-role-policy', '--role-name', spec['name'],
                                          '--policy-document', json.dumps(spec['trust']))))
    targets.append((f"{spec['name']} max session", 'value', live['MaxSessionDuration'], spec['max_session'],
                    lambda spec=spec: aws('iam', 'update-role', '--role-name', spec['name'],
                                          '--max-session-duration', str(spec['max_session']))))

plan = []
for label, kind, installed, wanted, _ in targets:
    if kind == 'missing':
        plan.append({'target': label, 'status': 'missing (create it with the bootstrap, not here)'})
    elif installed is UNREADABLE:
        plan.append({'target': label, 'status': 'unreadable with this profile (checked again by --apply)'})
    elif installed == wanted:
        plan.append({'target': label, 'status': 'identical'})
    elif kind == 'value':
        plan.append({'target': label, 'status': 'differs', 'installed': installed, 'rendered': wanted})
    else:
        plan.append({'target': label, 'status': 'differs', **statement_diff(installed, wanted)})
print(json.dumps({'commit': commit, 'apply': a.apply, 'plan': plan}, indent=2), flush=True)
if any(t[1] == 'missing' for t in targets):
    raise SystemExit('Some identities are missing; run the bootstrap first')
if blockers:
    raise SystemExit('; '.join(blockers))
if not a.apply:
    raise SystemExit()
for label, kind, installed, wanted, update in targets:
    if installed != wanted:
        update()
        print('updated ' + label, flush=True)
print(json.dumps({'done': True, 'commit': commit,
                  'next': 'run verify.py --role-arn and verify_access.py --live against the installed identities'}),
      flush=True)
