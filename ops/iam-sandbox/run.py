#!/usr/bin/env python3
"""Run docs/APP-ROLE-SANDBOX.md steps 2-3 without anyone assuming the test role.

The human access roles can't assume other roles by design, so the transaction checks run inside a
throwaway Lambda that uses the test role. As qsb-operator this script creates, all named
qsb-iam-sandbox-<random>:
- a disposable DynamoDB table (string pk/sk);
- a runtime role under /qsb/runtime/ with qsb-runtime-boundary, whose only permissions are
  terraform/policies/app-records.json scoped to that table, exactly as terraform/compute.tf scopes them;
- a Lambda (handler.py) using that role, making one DynamoDB call per invocation.

It runs each step, reads the rows back with consistent reads between steps, compares everything
with the documented expectations, writes the evidence outside Git, and always deletes what it created
(unless --keep). It never loosens a policy: any mismatch is reported as a failure.
It prints no account numbers, ARNs or item data.
"""
import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
POLICY = ROOT / 'terraform/policies/app-records.json'
HANDLER = Path(__file__).resolve().with_name('handler.py')
DENIED = ('AccessDeniedException',)

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--profile', required=True, help='the qsb-operator profile (or an exported session: use "")')
p.add_argument('--region', default='eu-west-1')
p.add_argument('--evidence', type=Path, required=True, help='evidence JSON path, outside the repository')
p.add_argument('--keep', action='store_true', help='keep the sandbox resources for inspection')


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


def main(a):
    if git('status', '--porcelain'):
        raise SystemExit('Commit and push the clean checkout first')
    commit, branch = git('rev-parse', 'HEAD'), git('branch', '--show-current')
    remote = git('ls-remote', 'origin', 'refs/heads/' + branch).split()
    if not remote or remote[0] != commit:
        raise SystemExit('Commit is not pushed to the matching remote branch')
    evidence = a.evidence.expanduser().resolve()
    if ROOT in evidence.parents:
        raise SystemExit('Write the evidence outside the repository')

    def aws(*args, check=True):
        profile = ['--profile', a.profile] if a.profile else []
        r = subprocess.run(['aws', *profile, '--region', a.region, '--output', 'json', '--no-cli-pager', *args],
                           capture_output=True, text=True)
        if r.returncode:
            code = re.search(r'\(([A-Za-z]+)\)', r.stderr)
            if check:
                raise SystemExit(f"{' '.join(args[:2])} failed: {code.group(1) if code else 'error'}")
            return None, code.group(1) if code else 'error'
        return (json.loads(r.stdout) if r.stdout.strip() else {}), None

    identity, _ = aws('sts', 'get-caller-identity')
    account = identity['Account']
    caller = identity['Arn'].split(':', 5)[5].split('/')
    print(f"running as {'/'.join(caller[:2])}", flush=True)

    suffix = uuid.uuid4().hex[:10]
    name = f'qsb-iam-sandbox-{suffix}'
    table_arn = f'arn:aws:dynamodb:{a.region}:{account}:table/{name}'
    boundary = f'arn:aws:iam::{account}:policy/qsb/bootstrap/qsb-runtime-boundary'
    raw = POLICY.read_bytes()
    role_policy = {'Version': '2012-10-17', 'Statement': [dict(s, Resource=table_arn) for s in json.loads(raw)]}
    tags = [{'Key': 'Application', 'Value': 'qsb-vault'}, {'Key': 'Purpose', 'Value': 'iam-sandbox'},
            {'Key': 'SourceCommit', 'Value': commit}]
    created = []
    report = {'kind': 'APP-ROLE-SANDBOX steps 2-3, run in a throwaway Lambda', 'commit': commit, 'region': a.region,
              'resourceName': name, 'caller': '/'.join(caller[:2]),
              'policySha256': hashlib.sha256(raw).hexdigest(),
              'rolePolicySha256': hashlib.sha256(json.dumps(role_policy, sort_keys=True).encode()).hexdigest(),
              'boundary': 'qsb-runtime-boundary', 'steps': [], 'checks': []}

    def present(prefix):
        item, _ = aws('dynamodb', 'get-item', '--table-name', name, '--consistent-read',
                      '--key', json.dumps({'pk': {'S': prefix + suffix}, 'sk': {'S': 'IAM_TEST'}}))
        return 'Item' in item

    def invoke(step):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'out.json'
            meta, _ = aws('lambda', 'invoke', '--function-name', name, '--cli-binary-format', 'raw-in-base64-out',
                          '--payload', json.dumps({'table': name, 'suffix': suffix, 'step': step}), str(out))
            if meta.get('FunctionError'):
                raise SystemExit(f'{step}: the sandbox Lambda failed ({meta["FunctionError"]}); nothing was loosened')
            result = json.loads(out.read_text())
        report['steps'].append({'step': step, **result})
        print(f"{step}: {'ok' if result.get('ok') else result.get('code')}", flush=True)
        return result

    def check(label, passed, observed):
        report['checks'].append({'check': label, 'passed': bool(passed), 'observed': observed})
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}: {observed}", flush=True)

    denied = lambda r: not r.get('ok') and (r.get('code') in DENIED or
                                           (r.get('code') == 'TransactionCanceledException' and
                                            'AccessDenied' in (r.get('cancellationReasons') or [])))
    try:
        aws('dynamodb', 'create-table', '--table-name', name, '--billing-mode', 'PAY_PER_REQUEST',
            '--attribute-definitions', 'AttributeName=pk,AttributeType=S', 'AttributeName=sk,AttributeType=S',
            '--key-schema', 'AttributeName=pk,KeyType=HASH', 'AttributeName=sk,KeyType=RANGE', '--tags', json.dumps(tags))
        created.append('table')
        aws('dynamodb', 'wait', 'table-exists', '--table-name', name)
        aws('iam', 'create-role', '--role-name', name, '--path', '/qsb/runtime/', '--permissions-boundary', boundary,
            '--assume-role-policy-document', json.dumps({'Version': '2012-10-17', 'Statement': [
                {'Effect': 'Allow', 'Principal': {'Service': 'lambda.amazonaws.com'}, 'Action': 'sts:AssumeRole'}]}),
            '--description', 'Disposable APP-ROLE-SANDBOX test role', '--tags', json.dumps(tags))
        created.append('role')
        aws('iam', 'put-role-policy', '--role-name', name, '--policy-name', 'app-records',
            '--policy-document', json.dumps(role_policy))
        created.append('role-policy')
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as z:
            z.writestr('handler.py', HANDLER.read_text())
        with tempfile.NamedTemporaryFile(suffix='.zip') as bundle:
            bundle.write(buffer.getvalue())
            bundle.flush()
            # A new role can't be assumed by Lambda until IAM has propagated it; retry only that.
            for attempt in range(24):
                _, code = aws('lambda', 'create-function', '--function-name', name, '--runtime', 'python3.13',
                              '--handler', 'handler.handler', '--timeout', '30',
                              '--role', f'arn:aws:iam::{account}:role/qsb/runtime/{name}',
                              '--zip-file', f'fileb://{bundle.name}', '--tags',
                              json.dumps({t['Key']: t['Value'] for t in tags}), check=False)
                if code is None:
                    break
                if code != 'InvalidParameterValueException' or attempt == 23:
                    raise SystemExit(f'lambda create-function failed: {code}')
                time.sleep(5)
        created.append('function')
        aws('lambda', 'wait', 'function-active-v2', '--function-name', name)

        # Step 2: a transaction with a denied SYSTEM# Put must write nothing.
        r = invoke('denied-transaction')
        check('mixed transaction with a SYSTEM# Put is denied', denied(r), r.get('code'))
        check('denied transaction wrote neither row', not present('OWNER#') and not present('SYSTEM#'),
              'owner and system rows absent')
        # The reservation shape: allowed Puts plus a SYSTEM# ConditionCheck.
        r = invoke('allowed-transaction')
        check('owner + outpoint Puts with a SYSTEM# ConditionCheck succeed', r.get('ok'), r.get('code') or 'ok')
        check('allowed transaction wrote owner and outpoint, not system',
              present('OWNER#') and present('OUTPOINT#') and not present('SYSTEM#'), 'rows as expected')
        r = invoke('outpoint-put-again')
        check('conditional re-create of the outpoint fails', r.get('code') == 'ConditionalCheckFailedException',
              r.get('code') or 'ok')
        r = invoke('outpoint-delete')
        check('outpoint delete is denied', denied(r), r.get('code') or 'ok')
        check('outpoint reservation remains', present('OUTPOINT#'), 'outpoint row present')
        # Step 3: a mixed BatchWriteItem must be denied with no partial write.
        aws('dynamodb', 'delete-item', '--table-name', name,
            '--key', json.dumps({'pk': {'S': 'OWNER#' + suffix}, 'sk': {'S': 'IAM_TEST'}}))
        r = invoke('denied-batch')
        check('mixed BatchWriteItem is denied', denied(r), r.get('code') or ('ok, unprocessed' if r.get('unprocessed') else 'ok'))
        check('denied batch wrote neither row', not present('OWNER#') and not present('SYSTEM#'),
              'owner and system rows absent')
    finally:
        if a.keep:
            print(f'kept sandbox resources named {name}', flush=True)
        else:
            if 'function' in created:
                aws('lambda', 'delete-function', '--function-name', name, check=False)
                aws('logs', 'delete-log-group', '--log-group-name', f'/aws/lambda/{name}', check=False)
            if 'role-policy' in created:
                aws('iam', 'delete-role-policy', '--role-name', name, '--policy-name', 'app-records', check=False)
            if 'role' in created:
                aws('iam', 'delete-role', '--role-name', name, check=False)
            if 'table' in created:
                aws('dynamodb', 'delete-table', '--table-name', name, check=False)
            report['cleanedUp'] = created
            print(f"deleted sandbox {', '.join(reversed(created)) or 'nothing'}", flush=True)
        report['passed'] = bool(report['checks']) and all(c['passed'] for c in report['checks'])
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text(json.dumps(report, indent=2) + '\n')
        evidence.chmod(0o600)
    print(json.dumps({'passed': report['passed'], 'checks': len(report['checks']), 'evidence': str(evidence)}), flush=True)
    if not report['passed']:
        raise SystemExit('Sandbox checks failed: do not deposit; do not loosen the policy. See the evidence.')


if __name__ == '__main__':
    main(p.parse_args())
