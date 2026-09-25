#!/usr/bin/env python3
"""Bring installed QSB administrator-managed IAM in line with this clean, pushed commit.

bootstrap.py and bootstrap_access.py create identities once and never change them, so a
reviewed renderer change doesn't reach AWS by itself. This compares every installed
administrator-managed QSB document with what this commit renders:

- qsb-github-deploy's inline deployment policy and qsb-runtime-boundary (render.py);
- qsb-gpu-boundary, the qsb-viewonly-N and qsb-operator-N policies, the operator user's
  inline policy, and the two roles' trust and session length (access.py).

Without --apply it prints the plan: for each target `identical`, `missing` or `differs`,
with the statements added, removed or changed and, for changed ones, the actions,
resources and principals that differ (account numbers masked). With --apply, from `main`
only and with an administrator profile (today the account root), it asks for a typed
confirmation (or --yes after reviewing that exact plan), updates only what differs, and
reads back every change. It never creates or deletes an identity, never attaches or
detaches a policy, and never deletes a policy version. It refuses before any write when a
changed managed policy already has IAM's five versions, the number of rendered access
policies changed, something is missing, or a role carries policies this commit doesn't render.
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from access import access
from render import render

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--profile', required=True)
p.add_argument('--inventory', type=Path, required=True)
p.add_argument('--apply', action='store_true')
p.add_argument('--yes', action='store_true', help='skip the typed confirmation; only after reviewing this exact plan')
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
if a.apply and branch != 'main':
    raise SystemExit('--apply runs only from a clean main that matches origin; plan mode works on any pushed branch')


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


def mask(value):
    return json.loads(re.sub(r'\d{12}', '<ACCOUNT>', json.dumps(value)))


def listed_set(value):
    return {json.dumps(v, sort_keys=True) if not isinstance(v, str) else v
            for v in (value if isinstance(value, list) else [value] if value is not None else [])}


def statement_diff(installed, rendered):
    """Statements added, removed and changed, and for changed ones what exactly differs.

    Values come from the inventory as well as the code, so the detail is what a reviewer
    compares with the reviewed diff: an unexpected principal or resource shows up here.
    """
    sid = lambda doc: {s.get('Sid', f'#{i}'): s for i, s in enumerate(doc.get('Statement', []))}
    old, new = sid(installed or {}), sid(rendered)
    changed = {}
    for k in sorted(set(old) & set(new)):
        if old[k] == new[k]:
            continue
        detail = {}
        for field in ('Action', 'NotAction', 'Resource', 'NotResource'):
            before, after = listed_set(old[k].get(field)), listed_set(new[k].get(field))
            if before != after:
                detail[field] = {'added': mask(sorted(after - before)), 'removed': mask(sorted(before - after))}
        for field in ('Effect', 'Principal', 'Condition'):
            if old[k].get(field) != new[k].get(field):
                detail[field] = {'installed': mask(old[k].get(field)), 'rendered': mask(new[k].get(field))}
        changed[k] = detail or 'reordered only'
    return {'added': sorted(set(new) - set(old)), 'removed': sorted(set(old) - set(new)), 'changed': changed}


def read_back(label, read, wanted):
    if read() != wanted:
        raise SystemExit(f'{label}: the update does not read back as rendered; inspect it')


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
    # Rendered names, so a role whose access policies are all gone shows as missing, not skipped.
    for i, document in enumerate(human[role]['policies'], 1):
        managed(f'qsb-{role}-{i}', document)


def attached(role_name):
    return {x['PolicyArn'] for x in aws('iam', 'list-attached-role-policies', '--role-name', role_name)['AttachedPolicies']}

deploy_policies = aws('iam', 'list-role-policies', '--role-name', 'qsb-github-deploy')['PolicyNames']
if deploy_policies != ['qsb-terraform-deployment']:
    raise SystemExit('qsb-github-deploy has unexpected inline policies; inspect it')
if attached('qsb-github-deploy'):
    raise SystemExit('qsb-github-deploy has attached managed policies this commit does not render; inspect it')
live_deploy_role = aws('iam', 'get-role', '--role-name', 'qsb-github-deploy')['Role']
live_deploy = aws('iam', 'get-role-policy', '--role-name', 'qsb-github-deploy',
                  '--policy-name', 'qsb-terraform-deployment')['PolicyDocument']


def update_deploy():
    aws('iam', 'put-role-policy', '--role-name', 'qsb-github-deploy', '--policy-name', 'qsb-terraform-deployment',
        '--policy-document', json.dumps(rendered['deploy']))
    if aws('iam', 'get-role-policy', '--role-name', 'qsb-github-deploy',
           '--policy-name', 'qsb-terraform-deployment')['PolicyDocument'] != rendered['deploy']:
        raise SystemExit('qsb-github-deploy: the updated policy does not read back as rendered; inspect it')


targets.append(('qsb-github-deploy/qsb-terraform-deployment', 'policy', live_deploy, rendered['deploy'], update_deploy))


def update_deploy_trust():
    aws('iam', 'update-assume-role-policy', '--role-name', 'qsb-github-deploy',
        '--policy-document', json.dumps(rendered['trust']))
    read_back('qsb-github-deploy trust',
              lambda: aws('iam', 'get-role', '--role-name', 'qsb-github-deploy')['Role']['AssumeRolePolicyDocument'],
              rendered['trust'])


targets.append(('qsb-github-deploy trust', 'policy', live_deploy_role['AssumeRolePolicyDocument'], rendered['trust'],
                update_deploy_trust))

user = human['user']
live_user = aws('iam', 'get-user-policy', '--user-name', user['name'], '--policy-name', 'assume-qsb-roles', readable=True)
live_user = UNREADABLE if live_user is None else live_user['PolicyDocument']


def update_user():
    aws('iam', 'put-user-policy', '--user-name', user['name'], '--policy-name', 'assume-qsb-roles',
        '--policy-document', json.dumps(user['inline']))
    read_back(f"{user['name']}/assume-qsb-roles",
              lambda: aws('iam', 'get-user-policy', '--user-name', user['name'],
                          '--policy-name', 'assume-qsb-roles')['PolicyDocument'], user['inline'])


targets.append((f"{user['name']}/assume-qsb-roles", 'policy', live_user, user['inline'], update_user))

def update_trust(spec):
    aws('iam', 'update-assume-role-policy', '--role-name', spec['name'], '--policy-document', json.dumps(spec['trust']))
    read_back(f"{spec['name']} trust",
              lambda: aws('iam', 'get-role', '--role-name', spec['name'])['Role']['AssumeRolePolicyDocument'], spec['trust'])


def update_session(spec):
    aws('iam', 'update-role', '--role-name', spec['name'], '--max-session-duration', str(spec['max_session']))
    read_back(f"{spec['name']} max session",
              lambda: aws('iam', 'get-role', '--role-name', spec['name'])['Role']['MaxSessionDuration'], spec['max_session'])


for role in ('viewonly', 'operator'):
    spec = human[role]
    live = aws('iam', 'get-role', '--role-name', spec['name'])['Role']
    expected = set(spec['managed']) | {listed[f'qsb-{role}-{i}']['Arn'] for i in range(1, len(spec['policies']) + 1)
                                       if f'qsb-{role}-{i}' in listed}
    if not attached(spec['name']) <= expected or aws('iam', 'list-role-policies', '--role-name', spec['name'])['PolicyNames']:
        raise SystemExit(f"{spec['name']} carries policies this commit does not render; inspect it")
    targets.append((f"{spec['name']} trust", 'policy', live['AssumeRolePolicyDocument'], spec['trust'],
                    lambda spec=spec: update_trust(spec)))
    targets.append((f"{spec['name']} max session", 'value', live['MaxSessionDuration'], spec['max_session'],
                    lambda spec=spec: update_session(spec)))

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
changes = [t for t in targets if t[2] != t[3]]
if changes and not a.yes:
    if not sys.stdin.isatty():
        raise SystemExit('Review the plan above, then confirm interactively or rerun with --yes; nothing was changed')
    if input(f'Apply {len(changes)} change(s) to installed IAM? Type "apply" to continue: ').strip() != 'apply':
        raise SystemExit('Not confirmed; nothing was changed')
for label, kind, installed, wanted, update in targets:
    if installed != wanted:
        update()
        print('updated ' + label, flush=True)
print(json.dumps({'done': True, 'commit': commit, 'changes': len(changes),
                  'next': 'run verify.py --role-arn and verify_access.py --live against the installed identities'}),
      flush=True)
