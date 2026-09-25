import base64
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from launch import BOOT, HERE, launch, schedule_request, verify_schedule

TIME = '2026-09-25T12:00:45+00:00'
ID = 'i-0123456789abcdef0'
CONFIG = dict(account='123456789012', region='eu-west-1', ami='ami-0123456789abcdef0',
              subnet='subnet-123', securityGroup='sg-123', instanceProfile='benchmark-only')


class FakeAws:
    def __init__(self, fail=None, tamper=None):
        self.calls = []
        self.fail = fail
        self.tamper = tamper
        self.policy = json.loads((HERE/'instance-policy.json').read_text())

    def __call__(self, service, operation, request):
        self.calls.append((service, operation, copy.deepcopy(request)))
        if operation == self.fail: raise RuntimeError('injected AWS failure')
        if operation == 'get-caller-identity': return {'Account': CONFIG['account']}
        if operation == 'get-instance-profile': return {'InstanceProfile': {'Roles': [{'RoleName': 'benchmark-only'}]}}
        if operation == 'list-attached-role-policies': return {'AttachedPolicies': []}
        if operation == 'list-role-policies': return {'PolicyNames': ['qsb-benchmark-session-only']}
        if operation == 'get-role-policy':
            return {'PolicyDocument': self.policy if request['RoleName'] == 'benchmark-only' else self.cleanup}
        if operation == 'describe-security-groups': return {'SecurityGroups': [{'IpPermissions': []}]}
        if operation == 'describe-images': return {'Images': [{'Architecture': 'x86_64', 'RootDeviceType': 'ebs',
            'RootDeviceName': '/dev/sda1', 'BlockDeviceMappings': [{'DeviceName': '/dev/sda1'}]}]}
        if operation == 'run-instances':
            self.run = request
            return {'Instances': [{'InstanceId': ID, 'LaunchTime': TIME}]}
        if operation == 'describe-instance-attribute':
            if request['Attribute'] == 'userData': return {'UserData': {'Value': self.run['UserData']}}
            return {'InstanceInitiatedShutdownBehavior': {'Value': 'terminate'}}
        if operation == 'put-role-policy': self.cleanup = json.loads(request['PolicyDocument'])
        if operation == 'create-schedule': self.schedule = copy.deepcopy(request)
        if operation == 'get-schedule':
            value = copy.deepcopy(self.schedule)
            if self.tamper: self.tamper(value)
            return value
        return {}


class LaunchTests(unittest.TestCase):
    def run_launch(self, aws, now=lambda: datetime(2026,9,25,12,1,tzinfo=timezone.utc)):
        with tempfile.TemporaryDirectory() as directory:
            return launch(CONFIG, aws, Path(directory)/'receipt.json', now=now)

    def test_boot_and_independent_exact_instance_cap(self):
        aws = FakeAws()
        receipt = self.run_launch(aws)
        self.assertEqual(aws.run['InstanceInitiatedShutdownBehavior'], 'terminate')
        self.assertEqual(base64.b64decode(aws.run['UserData']).decode(), BOOT)
        self.assertIn('/sbin/shutdown -h +55', BOOT)
        self.assertTrue(aws.run['BlockDeviceMappings'][0]['Ebs']['DeleteOnTermination'])
        self.assertTrue(aws.run['BlockDeviceMappings'][0]['Ebs']['Encrypted'])
        self.assertEqual((aws.run['MinCount'], aws.run['MaxCount'], aws.run['InstanceType']), (1, 1, 'g5.xlarge'))
        self.assertEqual(aws.cleanup['Statement'], [{'Effect': 'Allow', 'Action': 'ec2:TerminateInstances',
            'Resource': 'arn:aws:ec2:eu-west-1:123456789012:instance/'+ID}])
        self.assertEqual(receipt['schedule']['ScheduleExpression'], 'at(2026-09-25T12:59:00)')
        self.assertFalse(receipt['setupAuthorized'])
        self.assertEqual(receipt['status'], 'cleanup-enrolled')
        self.assertNotIn('terminate-instances', [op for _, op, _ in aws.calls])

    def test_enrollment_failure_terminates_before_return(self):
        for operation in ('describe-instance-attribute', 'create-role', 'put-role-policy', 'create-schedule', 'get-schedule'):
            aws = FakeAws(fail=operation)
            with self.subTest(operation=operation), self.assertRaises(RuntimeError): self.run_launch(aws)
            self.assertEqual(aws.calls[-1], ('ec2', 'terminate-instances', {'InstanceIds': [ID]}))

    def test_schedule_target_time_role_and_state_tampering_terminates(self):
        changes = [lambda r: r.update(State='DISABLED'), lambda r: r.update(ScheduleExpression='at(2027-01-01T00:00:00)'),
                   lambda r: r['Target'].update(RoleArn='arn:wrong'),
                   lambda r: r['Target'].update(Input=json.dumps({'InstanceIds': ['i-wrong']})),
                   lambda r: r['Target'].update(Arn='arn:wrong')]
        for change in changes:
            aws = FakeAws(tamper=change)
            with self.assertRaises(ValueError): self.run_launch(aws)
            self.assertEqual(aws.calls[-1][1], 'terminate-instances')

    def test_extra_instance_permissions_rejected_before_launch(self):
        aws = FakeAws()
        aws.policy['Statement'][0]['Action'].append('secretsmanager:GetSecretValue')
        with self.assertRaisesRegex(ValueError, 'policy mismatch'): self.run_launch(aws)
        self.assertNotIn('run-instances', [op for _, op, _ in aws.calls])

    def test_receipt_write_failure_still_attempts_termination(self):
        aws = FakeAws()
        with patch.object(Path, 'write_text', side_effect=OSError('disk full')):
            with self.assertRaises(OSError): self.run_launch(aws)
        self.assertEqual(aws.calls[-1], ('ec2', 'terminate-instances', {'InstanceIds': [ID]}))

    def test_unknown_launch_not_retried_and_intent_preserved(self):
        aws = FakeAws(fail='run-instances')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'receipt.json'
            with self.assertRaises(RuntimeError): launch(CONFIG, aws, path)
            self.assertEqual(json.loads(path.read_text())['status'], 'submission-intent')
            with self.assertRaisesRegex(ValueError, 'reconcile'): launch(CONFIG, aws, path)
            self.assertEqual([op for _, op, _ in aws.calls].count('run-instances'), 1)

    def test_delayed_enrollment_immediately_terminates(self):
        aws = FakeAws()
        with self.assertRaisesRegex(ValueError, 'delayed'):
            self.run_launch(aws, now=lambda: datetime(2026,9,25,12,4,tzinfo=timezone.utc))
        self.assertEqual(aws.calls[-1][1], 'terminate-instances')
        self.assertNotIn('create-schedule', [op for _, op, _ in aws.calls])
