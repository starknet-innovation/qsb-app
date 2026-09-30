#!/usr/bin/env python3
"""Helpers for .github/workflows/deploy.yml. The repository is public, so its Actions logs and step summaries are too.

Plans, applies and AWS CLI output carry account IDs, ARNs and resource IDs. Nothing from them reaches the log except
through redact(): the raw output goes to a private log file, which the workflow keeps in the state bucket.

  credential-process               an AWS credential_process: the deploy role's credentials, from GitHub's OIDC token
  run LOG [--ok CODES] -- CMD...   run CMD with its output in LOG; on failure print only its redacted errors
  masks TFVARS                     print ::add-mask:: for the tfvars' identifying values, and record them for redact()
  masks --outputs OUTPUTS_JSON     the same for every value `terraform output -json` returns, except source_commit
  summary PLAN_JSON                a redacted Markdown summary of a saved plan's changes, for the step summary
  redact                           redact stdin to stdout
  require-approver                 fail unless the qsb-deploy environment requires a reviewer
"""
import json
import io
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

PATTERNS = [
    # credential_process output, should an SDK ever quote it in an error.
    (re.compile(r'("(?:AccessKeyId|SecretAccessKey|SessionToken)"\s*:\s*)"[^"]*"'), r'\1"<redacted>"'),
    (re.compile(r'((?:aws_secret_access_key|aws_session_token|SecretAccessKey|SessionToken)\s*[=:]\s*)\S+', re.I),
     r'\1<redacted>'),
    (re.compile(r'arn:aws[^\s"\'`,\]\)}>]*'), '<arn>'),
    (re.compile(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'), '<access-key>'),
    (re.compile(r'(?<!\d)\d{12}(?!\d)'), '<account>'),
    (re.compile(r'\b[a-z0-9]+\.cloudfront\.net\b'), '<cloudfront-domain>'),
    (re.compile(r'\b[a-z0-9]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com\b'), '<api-endpoint>'),
    (re.compile(r'\bE[A-Z0-9]{12,14}\b'), '<cloudfront-id>'),
    (re.compile(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b'), '<uuid>'),
    (re.compile(r'/apis/[a-z0-9]+'), '/apis/<id>'),
    (re.compile(r'\[id=[^\]]*\]'), '[id=<redacted>]'),
    (re.compile(r'\bARO[A-Z0-9]{17,}\b'), '<role-id>'),
    # Provider errors name the resource in parentheses: "reading API Gateway v2 API (a1b2c3d4e5)".
    (re.compile(r'(\b(?:reading|creating|updating|deleting|waiting for|describing|listing|(?:un)?tagging|modifying|'
                r'putting|setting|flattening|expanding|importing|finding|refreshing)\b[^()\n]{0,80}?)\([^)\s]{6,}\)', re.I),
     r'\1(<id>)'),
    (re.compile(r's3://[^\s/"\']+'), 's3://<bucket>'),
]
# Values of these variables are shown in the summary; they're public (the app's /api/config serves them).
SWITCHES = ['network', 'solver_release_id', 'mainnet_enabled', 'exact_submit_enabled', 'api_keys_enabled',
            'webhook_dispatcher_enabled']
MAX_ERROR_LINES = 60
ENVIRONMENT = 'qsb-deploy'
STS = {'sts': 'https://sts.amazonaws.com/doc/2011-06-15/'}


def literals():
    path = os.environ.get('QSB_REDACT_FILE')
    if not path or not Path(path).is_file():
        return []
    return sorted({l for l in Path(path).read_text().splitlines() if l}, key=len, reverse=True)


def redact(text, extra=None):
    for value in (literals() if extra is None else extra):
        text = text.replace(value, '<redacted>')
    for pattern, replacement in PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def identifying(value):
    """A tfvars string worth masking: an ARN, an account ID, or anything that names or locates a resource."""
    return isinstance(value, str) and len(value) >= 6 and bool(re.search(r'[:/]|\d{12}', value))


def strings(value):
    if isinstance(value, dict):
        for v in value.values():
            yield from strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from strings(v)
    elif isinstance(value, str):
        yield value


def record(values):
    path = os.environ.get('QSB_REDACT_FILE')
    if path:
        with open(path, 'a') as f:
            f.writelines(v + '\n' for v in values)
    return [f'::add-mask::{v}' for v in values]


def masks(tfvars_path):
    return record(sorted({v for v in strings(json.loads(Path(tfvars_path).read_text())) if identifying(v)}))


def output_masks(outputs_path):
    """Every string output: IDs such as the API's don't look identifying, so none are left to chance."""
    outputs = json.loads(Path(outputs_path).read_text())
    return record(sorted({v for name, o in outputs.items() if name != 'source_commit'
                          for v in strings(o.get('value')) if len(v) >= 6}))


def error_excerpt(output):
    """The redacted output of a failed command from its first error on, or its last lines when it named none."""
    lines = output.splitlines()
    first = next((i for i, line in enumerate(lines) if re.match(
        r'^\s*(?:│\s*)?(?:Error\b|fatal error|An error occurred|Traceback|Single pipeline inventory failed)', line)), None)
    picked = lines[first:] if first is not None else lines[-20:]
    return redact('\n'.join(picked[:MAX_ERROR_LINES]))


def run(log, ok, cmd):
    with open(log, 'a') as out:
        out.write(f'$ {" ".join(cmd)}\n')
        out.flush()
        start = out.tell()
        child = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT)
        # If an interrupt reaches Terraform, it stops cleanly and saves its state; this wrapper keeps waiting rather
        # than killing it, as subprocess.run would. A cancelled job may still kill the tree before that: don't
        # cancel mid-apply.
        previous = {sig: signal.signal(sig, lambda *_: None) for sig in (signal.SIGINT, signal.SIGTERM)}
        try:
            code = child.wait()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    if code not in ok:
        print(f'{Path(cmd[0]).name} failed with exit code {code}; redacted errors follow. '
              f'The full log is kept privately with the deploy record.')
        with open(log, errors='replace') as f:
            f.seek(start)
            print(error_excerpt(f.read()))
    return code


# STS reports these as HTTP 400, but they're transient.
TRANSIENT_STS = ('IDPCommunicationError', 'InvalidIdentityToken', 'Throttling')


def request(req, deadline):
    """The response body, retrying transient failures until the monotonic deadline."""
    attempt = 0
    while True:
        remaining = deadline - time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=max(1, min(10, remaining))) as response:
                return response.read()
        except urllib.error.HTTPError as e:
            body = e.read()
            transient = e.code >= 500 or e.code == 429 or any(c.encode() in body for c in TRANSIENT_STS)
            if not transient or remaining < 5:
                raise urllib.error.HTTPError(e.url, e.code, e.reason, e.headers, io.BytesIO(body)) from None
        except (urllib.error.URLError, TimeoutError):
            if remaining < 5:
                raise
        time.sleep(min(2 ** attempt, 4))
        attempt += 1


def sts_credentials(body):
    """The credentials and identity in an AssumeRoleWithWebIdentity response."""
    result = ET.fromstring(body).find('sts:AssumeRoleWithWebIdentityResult', STS)
    field = lambda parent, name: result.find(f'sts:{parent}/sts:{name}', STS).text
    return {name: field('Credentials', name) for name in ('AccessKeyId', 'SecretAccessKey', 'SessionToken',
                                                          'Expiration')} | {
        name: field('AssumedRoleUser', name) for name in ('Arn', 'AssumedRoleId')}


def credential_failure(message):
    """Report on stderr, and in the private log too: Terraform's provider drops a credential_process's stderr."""
    sys.stderr.write(message + '\n')
    path = os.environ.get('QSB_CREDENTIAL_LOG')
    if path:
        with open(path, 'a') as f:
            f.write(f'{time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())} {message}\n')
    return 1


def credential_process():
    """The deploy role's credentials in credential_process form, for the AWS CLI, Terraform and its S3 backend.

    The workflow names this in an AWS config profile, so each SDK asks for credentials when it needs them. They go
    to the SDK over a pipe; nothing stores or logs them, and the SDKs refresh them before they expire. A fresh
    OIDC token each time means no token outlives its use. Reads QSB_ROLE_ARN, QSB_ACCOUNT_ID, QSB_SESSION and
    AWS_REGION, and refuses a role outside that account, as configure-aws-credentials' allowed-account-ids does.
    Everything, retries included, finishes within the SDKs' one-minute limit on a credential_process."""
    role, account = os.environ['QSB_ROLE_ARN'], os.environ['QSB_ACCOUNT_ID']
    region, session = os.environ['AWS_REGION'], os.environ['QSB_SESSION']
    deadline = time.monotonic() + 50
    try:
        oidc = json.loads(request(urllib.request.Request(
            os.environ['ACTIONS_ID_TOKEN_REQUEST_URL'] + '&audience=sts.amazonaws.com',
            headers={'Authorization': f'Bearer {os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]}'}), deadline))['value']
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError) as e:
        return credential_failure(f'GitHub OIDC token request failed: {redact(str(e), [role, account])}')
    body = urllib.parse.urlencode({'Action': 'AssumeRoleWithWebIdentity', 'Version': '2011-06-15', 'RoleArn': role,
                                   'RoleSessionName': session, 'WebIdentityToken': oidc,
                                   'DurationSeconds': '3600'}).encode()
    try:
        c = sts_credentials(request(urllib.request.Request(
            f'https://sts.{region}.amazonaws.com/', data=body,
            headers={'Content-Type': 'application/x-www-form-urlencoded'}), deadline))
    except urllib.error.HTTPError as e:
        return credential_failure(f'AssumeRoleWithWebIdentity failed with HTTP {e.code}: '
                                  f'{redact(e.read().decode(errors="replace"), [role, account])[:2000]}')
    except (urllib.error.URLError, TimeoutError, ET.ParseError, AttributeError) as e:
        return credential_failure(f'AssumeRoleWithWebIdentity failed: {redact(str(e), [role, account])}')
    if c['Arn'].split(':')[4] != account:
        return credential_failure('The role is not in the account QSB_AWS_ACCOUNT_ID names.')
    json.dump({'Version': 1, 'AccessKeyId': c['AccessKeyId'], 'SecretAccessKey': c['SecretAccessKey'],
               'SessionToken': c['SessionToken'], 'Expiration': c['Expiration']}, sys.stdout)
    return 0


def changed_paths(before, after, path=''):
    if isinstance(before, dict) and isinstance(after, dict):
        out = []
        for k in sorted(set(before) | set(after)):
            out += changed_paths(before.get(k), after.get(k), f'{path}.{k}' if path else str(k))
        return out
    if isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
        out = []
        for i, (b, a) in enumerate(zip(before, after)):
            out += changed_paths(b, a, f'{path}[{i}]')
        return out
    return [] if before == after else [path or '(value)']


def unknown_paths(unknown, path=''):
    if unknown is True:
        return [path or '(value)']
    if isinstance(unknown, dict):
        return [p for k, v in sorted(unknown.items()) for p in unknown_paths(v, f'{path}.{k}' if path else str(k))]
    if isinstance(unknown, list):
        return [p for i, v in enumerate(unknown) for p in unknown_paths(v, f'{path}[{i}]')]
    return []


def action_name(actions):
    if actions in (['delete', 'create'], ['create', 'delete']):
        return 'replace'
    return actions[0] if len(actions) == 1 else '+'.join(actions)


def summary(plan, commit='', plan_digest=''):
    rows, tag_only, counts = [], Counter(), Counter()
    for rc in plan.get('resource_changes', []):
        if rc.get('mode') != 'managed':
            continue
        change = rc['change']
        action = action_name(change['actions'])
        counts[action] += 1
        if action == 'no-op':
            continue
        paths = []
        if action == 'update':
            paths = sorted(set(changed_paths(change.get('before'), change.get('after'))) |
                           set(unknown_paths(change.get('after_unknown'))))
            if paths and all(p.split('.')[0].split('[')[0] in ('tags', 'tags_all') for p in paths):
                tag_only[rc['type']] += 1
                continue
        shown = ', '.join(f'`{p}`' for p in paths[:8]) + (f' and {len(paths) - 8} more' if len(paths) > 8 else '')
        rows.append(f'| `{rc["address"]}` | {action} | {shown} |')
    variables = plan.get('variables', {})
    out = ['## App stack plan', '']
    if commit:
        out.append(f'Commit `{commit}`' + (f', plan sha256 `{plan_digest}`' if plan_digest else '') + '.')
        out.append('')
    out.append(', '.join(f'{n} {a}' for a, n in sorted(counts.items()) if a != 'no-op') or 'No changes.')
    if counts['delete'] or counts['replace']:
        out += ['', f'**{counts["delete"]} destroyed and {counts["replace"]} replaced: check these before approving.**']
    out += ['', '| Setting | Value |', '| --- | --- |']
    out += [f'| `{k}` | `{json.dumps(variables[k]["value"])}` |' for k in SWITCHES if k in variables]
    if rows:
        out += ['', '| Resource | Action | Changed attributes |', '| --- | --- | --- |', *rows]
    if tag_only:
        out += ['', 'Tags only: ' + ', '.join(f'{n} × `{t}`' for t, n in sorted(tag_only.items())) + '.']
    return redact('\n'.join(out) + '\n')


def approvers(environment):
    """How many reviewers an environment (GitHub's environment API response) requires before its jobs run."""
    return sum(len(rule.get('reviewers') or []) for rule in (environment or {}).get('protection_rules') or []
               if rule.get('type') == 'required_reviewers')


def require_approver():
    # GitHub creates a missing environment on first use, with no protection rules; the apply would then run unapproved.
    request = urllib.request.Request(
        f'https://api.github.com/repos/{os.environ["GITHUB_REPOSITORY"]}/environments/{ENVIRONMENT}',
        headers={'Authorization': f'Bearer {os.environ["GH_TOKEN"]}', 'Accept': 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            environment = json.load(response)
    except (urllib.error.URLError, ValueError):
        environment = None
    if approvers(environment) < 1:
        print(f'The {ENVIRONMENT} environment must exist and require at least one reviewer.')
        return 1
    return 0


def main(argv):
    if argv[:1] == ['run'] and '--' in argv:
        head, cmd = argv[1:argv.index('--')], argv[argv.index('--') + 1:]
        ok = {0}
        if len(head) == 3 and head[1] == '--ok':
            ok, head = {int(c) for c in head[2].split(',')}, head[:1]
        if len(head) != 1 or not cmd:
            raise SystemExit(__doc__)
        return run(head[0], ok, cmd)
    if argv[:1] == ['masks'] and len(argv) == 2:
        print('\n'.join(masks(argv[1])))
        return 0
    if argv[:2] == ['masks', '--outputs'] and len(argv) == 3:
        print('\n'.join(output_masks(argv[2])))
        return 0
    if argv == ['credential-process']:
        return credential_process()
    if argv[:1] == ['summary'] and len(argv) == 2:
        sys.stdout.write(summary(json.loads(Path(argv[1]).read_text()), os.environ.get('GITHUB_SHA', ''),
                                 os.environ.get('QSB_PLAN_DIGEST', '')))
        return 0
    if argv == ['require-approver']:
        return require_approver()
    if argv == ['redact']:
        sys.stdout.write(redact(sys.stdin.read()))
        return 0
    raise SystemExit(__doc__)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
