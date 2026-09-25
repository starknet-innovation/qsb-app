#!/usr/bin/env python3
"""Suspend QSB AWS entry points without deleting persisted data.

Run without --apply first. Keep the resulting snapshot outside the repository.
Requires AWS CLI credentials; does not read secrets or Lambda environments.
"""
import argparse
import json
from pathlib import Path
import subprocess


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--profile', required=True)
    p.add_argument('--region', required=True)
    p.add_argument('--account', required=True)
    p.add_argument('--snapshot', type=Path, required=True)
    p.add_argument('--apply', action='store_true')
    a = p.parse_args()

    def aws(*args):
        out = subprocess.check_output(['aws', '--profile', a.profile, '--region',
                                       a.region, '--output', 'json', *args], text=True)
        return json.loads(out) if out.strip() else {}

    if aws('sts', 'get-caller-identity')['Account'] != a.account:
        raise SystemExit('Account mismatch')
    resources = aws('resourcegroupstaggingapi', 'get-resources', '--tag-filters',
                    'Key=Application,Values=qsb-vault')['ResourceTagMappingList']
    arns = {r['ResourceARN'] for r in resources}
    functions = sorted(r.split(':function:')[1] for r in arns if ':lambda:' in r)
    apis = sorted(r.split('/apis/')[1] for r in arns
                  if ':apigateway:' in r and '/apis/' in r and '/stages/' not in r)
    workflows = sorted(r for r in arns if ':stateMachine:' in r)
    distributions = []
    for d in aws('cloudfront', 'list-distributions').get('DistributionList', {}).get('Items', []):
        tags = aws('cloudfront', 'list-tags-for-resource', '--resource', d['ARN'])['Tags']['Items']
        if {'Key': 'Application', 'Value': 'qsb-vault'} in tags:
            distributions.append(d['Id'])
    state = {'account': a.account, 'region': a.region, 'functions': {},
             'apis': {}, 'distributions': {}, 'runningExecutions': []}
    for f in functions:
        provisioned = aws('lambda', 'list-provisioned-concurrency-configs', '--function-name', f)
        if provisioned.get('ProvisionedConcurrencyConfigs'):
            raise SystemExit(f'Provisioned concurrency requires separate review: {f}')
        state['functions'][f] = aws('lambda', 'get-function-concurrency', '--function-name', f)
    for api in apis:
        state['apis'][api] = aws('apigatewayv2', 'get-api', '--api-id', api).get('DisableExecuteApiEndpoint', False)
    for d in distributions:
        state['distributions'][d] = aws('cloudfront', 'get-distribution-config', '--id', d)
    for w in workflows:
        state['runningExecutions'].extend(e['executionArn'] for e in aws(
            'stepfunctions', 'list-executions', '--state-machine-arn', w,
            '--status-filter', 'RUNNING')['executions'])
    if not functions or not distributions:
        raise SystemExit('No matching QSB functions or distributions; refusing incomplete discovery')
    # Exclusive creation preserves the original state even on retries.
    with a.snapshot.open('x') as out:
        a.snapshot.chmod(0o600)
        json.dump(state, out, indent=2)
    print(json.dumps({'functions': len(functions), 'apis': len(apis),
                      'distributions': len(distributions),
                      'runningExecutions': len(state['runningExecutions'])}), flush=True)
    if not a.apply:
        return
    for f in functions:
        aws('lambda', 'put-function-concurrency', '--function-name', f,
            '--reserved-concurrent-executions', '0')
        print(f'Throttled {f}', flush=True)
    for api in apis:
        aws('apigatewayv2', 'update-api', '--api-id', api, '--disable-execute-api-endpoint')
        print(f'Disabled API endpoint {api}', flush=True)
    for execution in state['runningExecutions']:
        aws('stepfunctions', 'stop-execution', '--execution-arn', execution,
            '--cause', 'Operator-requested QSB suspension')
    for d, original in state['distributions'].items():
        config = dict(original['DistributionConfig'])
        config['Enabled'] = False
        aws('cloudfront', 'update-distribution', '--id', d, '--if-match', original['ETag'],
            '--distribution-config', json.dumps(config))
        print(f'Disabled distribution {d}; propagation may still be pending', flush=True)


if __name__ == '__main__':
    main()
