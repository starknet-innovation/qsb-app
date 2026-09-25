"""Opt-in one-instance launch and verified independent cleanup enrollment.

No setup or benchmark runs here. AWS mutations require --execute and a reviewed
launch config. Tests inject an in-memory AWS transport; importing is inert.
"""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import subprocess
import uuid

HERE = Path(__file__).resolve().parent
BOOT = '''#!/bin/bash
set -euo pipefail
# Arm before any setup; failure shuts down immediately. No downloads or secrets.
/sbin/shutdown -h +55 || { /sbin/shutdown -h now; exit 1; }
touch /run/qsb-shutdown-armed
'''


def parse_time(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Timestamp must include timezone')
    return result.astimezone(timezone.utc)


def schedule_request(instance_id, launch_time, role_arn, name):
    # Scheduler has minute precision. Target early; termination latency is not bounded.
    deadline = (parse_time(launch_time) + timedelta(minutes=59)).replace(second=0, microsecond=0)
    return dict(Name=name, GroupName='default', ScheduleExpression=f'at({deadline:%Y-%m-%dT%H:%M:%S})',
                ScheduleExpressionTimezone='UTC', FlexibleTimeWindow={'Mode': 'OFF'}, State='ENABLED',
                ActionAfterCompletion='DELETE', Target={
                    'Arn': 'arn:aws:scheduler:::aws-sdk:ec2:terminateInstances', 'RoleArn': role_arn,
                    'Input': json.dumps({'InstanceIds': [instance_id]}),
                    'RetryPolicy': {'MaximumEventAgeInSeconds': 60, 'MaximumRetryAttempts': 0}})


def verify_schedule(actual, expected):
    for key in ('Name', 'GroupName', 'ScheduleExpression', 'ScheduleExpressionTimezone',
                'FlexibleTimeWindow', 'State', 'ActionAfterCompletion'):
        if actual.get(key) != expected[key]:
            raise ValueError(f'Cleanup schedule mismatch: {key}')
    target = actual.get('Target', {})
    for key in ('Arn', 'RoleArn', 'RetryPolicy'):
        if target.get(key) != expected['Target'][key]:
            raise ValueError(f'Cleanup target mismatch: {key}')
    if json.loads(target.get('Input', '{}')) != json.loads(expected['Target']['Input']):
        raise ValueError('Cleanup instance ID mismatch')


def launch(config, aws, receipt_path, now=lambda: datetime.now(timezone.utc)):
    """AWS adapter accepts service, operation, request dict and returns response dict."""
    receipt_path = Path(receipt_path)
    if receipt_path.exists():
        raise ValueError('Receipt exists; reconcile it instead of launching again')
    if config.get('region') != 'eu-west-1':
        raise ValueError('Only the reviewed eu-west-1 experiment is supported')
    for key, pattern in [('ami', r'ami-[0-9a-f]{17}'), ('subnet', r'subnet-[0-9a-f]+'),
                         ('securityGroup', r'sg-[0-9a-f]+'), ('instanceProfile', r'[\w+=,.@-]{1,128}')]:
        if not re.fullmatch(pattern, config.get(key, '')):
            raise ValueError(f'Invalid {key}')
    identity = aws('sts', 'get-caller-identity', {})
    account = identity['Account']
    if account != config['account'] or not re.fullmatch(r'\d{12}', account):
        raise ValueError('Wrong AWS account')
    policy = json.loads((HERE / 'instance-policy.json').read_text())
    roles = aws('iam', 'get-instance-profile', {'InstanceProfileName': config['instanceProfile']})['InstanceProfile']['Roles']
    if len(roles) != 1:
        raise ValueError('One dedicated SSM-only instance role required')
    role = roles[0]['RoleName']
    attached = aws('iam', 'list-attached-role-policies', {'RoleName': role})
    inline = aws('iam', 'list-role-policies', {'RoleName': role})
    if attached.get('AttachedPolicies') or attached.get('IsTruncated') or inline.get('IsTruncated') or inline.get('PolicyNames') != ['qsb-benchmark-session-only']:
        raise ValueError('Instance role must contain only the reviewed inline policy')
    actual = aws('iam', 'get-role-policy', {'RoleName': role, 'PolicyName': 'qsb-benchmark-session-only'})['PolicyDocument']
    if actual != policy:
        raise ValueError('Instance role policy mismatch')
    groups = aws('ec2', 'describe-security-groups', {'GroupIds': [config['securityGroup']]})['SecurityGroups']
    if len(groups) != 1 or groups[0]['IpPermissions']:
        raise ValueError('No inbound security-group rules allowed')
    images = aws('ec2', 'describe-images', {'ImageIds': [config['ami']]})['Images']
    if len(images) != 1 or images[0]['Architecture'] != 'x86_64' or images[0]['RootDeviceType'] != 'ebs':
        raise ValueError('Pinned x86_64 EBS AMI required')
    image = images[0]
    if len(image['BlockDeviceMappings']) != 1:
        raise ValueError('AMI must have one reviewed root volume only')
    token = str(uuid.uuid4())
    request = dict(ImageId=config['ami'], InstanceType='g5.xlarge', MinCount=1, MaxCount=1,
                   SubnetId=config['subnet'], SecurityGroupIds=[config['securityGroup']],
                   IamInstanceProfile={'Name': config['instanceProfile']}, ClientToken=token,
                   InstanceInitiatedShutdownBehavior='terminate', DisableApiTermination=False,
                   UserData=base64.b64encode(BOOT.encode()).decode(),
                   MetadataOptions={'HttpTokens': 'required', 'HttpPutResponseHopLimit': 1},
                   BlockDeviceMappings=[{'DeviceName': image['RootDeviceName'], 'Ebs': {
                       'Encrypted': True, 'DeleteOnTermination': True, 'VolumeSize': 80, 'VolumeType': 'gp3'}}])
    receipt = {'status': 'submission-intent', 'clientToken': token, 'request': request}
    # Persist before the paid call. A transport failure is uncertain, never retried here.
    with receipt_path.open('x') as out:
        json.dump(receipt, out, indent=2)
    instances = aws('ec2', 'run-instances', request)['Instances']
    if len(instances) != 1:
        raise ValueError('Unexpected launch response; reconcile client token immediately')
    instance_id = instances[0]['InstanceId']
    try:
        receipt.update(status='arming', instanceId=instance_id, launchTime=instances[0]['LaunchTime'])
        receipt_path.write_text(json.dumps(receipt, indent=2)+'\n')
        if now() >= parse_time(receipt['launchTime']) + timedelta(minutes=2):
            raise ValueError('Cleanup enrollment delayed; terminate before setup')
        behavior = aws('ec2', 'describe-instance-attribute', {'InstanceId': instance_id, 'Attribute': 'instanceInitiatedShutdownBehavior'})
        data = aws('ec2', 'describe-instance-attribute', {'InstanceId': instance_id, 'Attribute': 'userData'})
        if behavior['InstanceInitiatedShutdownBehavior']['Value'] != 'terminate' or data['UserData']['Value'] != request['UserData']:
            raise ValueError('Boot termination settings mismatch')
        name = 'qsb-benchmark-' + instance_id
        cleanup_arn = f'arn:aws:iam::{account}:role/{name}'
        trust = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow',
            'Principal': {'Service': 'scheduler.amazonaws.com'}, 'Action': 'sts:AssumeRole',
            'Condition': {'StringEquals': {'aws:SourceAccount': account},
                          'ArnEquals': {'aws:SourceArn': f'arn:aws:scheduler:{config["region"]}:{account}:schedule-group/default'}}}]}
        cleanup_policy = {'Version': '2012-10-17', 'Statement': [{'Effect': 'Allow',
            'Action': 'ec2:TerminateInstances', 'Resource': f'arn:aws:ec2:{config["region"]}:{account}:instance/{instance_id}'}]}
        aws('iam', 'create-role', {'RoleName': name, 'AssumeRolePolicyDocument': json.dumps(trust)})
        aws('iam', 'put-role-policy', {'RoleName': name, 'PolicyName': 'terminate-exact-instance', 'PolicyDocument': json.dumps(cleanup_policy)})
        if aws('iam', 'get-role-policy', {'RoleName': name, 'PolicyName': 'terminate-exact-instance'})['PolicyDocument'] != cleanup_policy:
            raise ValueError('Cleanup role policy mismatch')
        expected = schedule_request(instance_id, receipt['launchTime'], cleanup_arn, name)
        aws('scheduler', 'create-schedule', expected)
        verify_schedule(aws('scheduler', 'get-schedule', {'Name': name, 'GroupName': 'default'}), expected)
        if now() >= parse_time(receipt['launchTime']) + timedelta(minutes=2):
            raise ValueError('Cleanup enrollment exceeded deadline')
        receipt.update(status='cleanup-enrolled', schedule=expected,
                       setupAuthorized=False, bootMarkerCheckRequired=True)
        receipt_path.write_text(json.dumps(receipt, indent=2)+'\n')
        return receipt
    except Exception:
        # No setup may run on this path. If AWS termination itself fails, preserve the
        # instance ID and enrollment state for immediate operator reconciliation.
        receipt['status'] = 'enrollment-failed-termination-required'
        try:
            receipt_path.write_text(json.dumps(receipt, indent=2)+'\n')
        finally:
            aws('ec2', 'terminate-instances', {'InstanceIds': [instance_id]})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute:
        parser.error('No launch performed. --execute requires separate launch authorization.')
    config = json.loads(args.config.read_text())
    def aws(service, operation, request):
        result = subprocess.check_output(['aws', '--profile', args.profile, '--region', config['region'],
            '--no-cli-pager', '--cli-connect-timeout', '5', '--cli-read-timeout', '10', '--output', 'json', service, operation, '--cli-input-json', json.dumps(request)], text=True, timeout=20)
        return json.loads(result) if result.strip() else {}
    print(json.dumps(launch(config, aws, args.receipt), indent=2))


if __name__ == '__main__':
    main()
