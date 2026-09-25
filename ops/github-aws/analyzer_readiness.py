"""Require an active external-access analyzer before creating human IAM access."""
import json
import time


def ensure_analyzer(aws, commit, attempts=20, sleep=None):
    """Read or create an ACCOUNT analyzer; never alter an existing analyzer.

    Poll at most twenty times with three-second intervals. A failed, disabled,
    unknown or still-pending analyzer aborts before the bootstrap's IAM writes.
    The AWS CLI wrapper bounds individual requests separately.
    """
    sleep = time.sleep if sleep is None else sleep
    analyzers = aws('accessanalyzer', 'list-analyzers', '--type', 'ACCOUNT')['analyzers']
    active = next((item for item in analyzers if item.get('status') == 'ACTIVE'), None)
    if active:
        return 'existing-active'
    if analyzers:
        # Do not replace or silently trust another administrator's inactive analyzer.
        raise SystemExit('Existing external-access analyzer is not ACTIVE; inspect it before bootstrap')
    result = aws('accessanalyzer', 'create-analyzer', '--analyzer-name', 'qsb-external-access',
                 '--type', 'ACCOUNT', '--tags', json.dumps({'Application': 'qsb-vault', 'SourceCommit': commit}))
    arn = result.get('arn')
    if not arn:
        raise SystemExit('Analyzer creation returned no identity; inspect before retrying')
    for attempt in range(attempts):
        analyzer = aws('accessanalyzer', 'get-analyzer', '--analyzer-name', 'qsb-external-access')['analyzer']
        if analyzer.get('arn') != arn or analyzer.get('type') != 'ACCOUNT':
            raise SystemExit('Analyzer identity mismatch; inspect before bootstrap')
        status = analyzer.get('status')
        if status == 'ACTIVE':
            return 'created-active'
        if status != 'CREATING':
            raise SystemExit('Created external-access analyzer is not ACTIVE; inspect before bootstrap')
        if attempt + 1 < attempts:
            sleep(3)
    raise SystemExit('External-access analyzer remains pending; no human IAM access was created. Retry after it is ACTIVE')
