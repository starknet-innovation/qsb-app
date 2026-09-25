"""Offline regression checks for the single-pipeline deployment policy renderer.

These inspect policy structure; use verify.py for AWS IAM simulation.
"""
import json
import unittest
import fnmatch
import re
from pathlib import Path

from render import render


class SinglePipelinePolicies(unittest.TestCase):
    def setUp(self):
        self.inventory = dict(
            account='123456789012', region='eu-west-1',
            subject='repo:example/qsb:ref:refs/heads/main',
            state_bucket='qsb-test-state', distributions=['TESTCDN'],
            apis=['testapi'], origin_access_controls=['TESTOAC'],
            response_headers_policies=['TESTHEADERS'],
        )
        self.policies = render(self.inventory)

    def statement(self, policy, sid):
        return next(s for s in self.policies[policy]['Statement'] if s['Sid'] == sid)

    def test_removed_services_have_no_deploy_or_runtime_actions(self):
        removed = {'ec2', 'backup', 'sqs', 'events', 'ecr'}
        for kind in ('deploy', 'boundary'):
            for statement in self.policies[kind]['Statement']:
                if statement['Effect'] == 'Allow':
                    for action in statement['Action']:
                        self.assertNotIn(action.split(':')[0], removed, (kind, action))
        runtime_actions = [a for s in self.policies['boundary']['Statement'] for a in s['Action']]
        self.assertFalse(any(a.startswith('secretsmanager:') for a in runtime_actions))

    def test_role_deletion_lookup_is_scoped_without_instance_profile_management(self):
        statement = self.statement('deploy', 'ManageRuntimeRoles')
        self.assertIn('iam:ListInstanceProfilesForRole', statement['Action'])
        self.assertEqual(statement['Resource'], ['arn:aws:iam::123456789012:role/qsb/runtime/qsb-*'])
        for s in self.policies['deploy']['Statement']:
            if s['Effect'] == 'Allow':
                for action in s['Action']:
                    if 'InstanceProfile' in action:
                        self.assertEqual(action, 'iam:ListInstanceProfilesForRole')

    def test_batch_boundary_limits_paid_jobs_and_s3_prefixes(self):
        self.assertEqual(self.statement('boundary','BatchSubmit')['Resource'], ['arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu','arn:aws:batch:eu-west-1:123456789012:job-definition/qsb-gpu-solver:*'])
        self.assertEqual(self.statement('boundary','GpuInputs')['Action'], ['s3:PutObject'])
        self.assertEqual(self.statement('boundary','GpuOutputs')['Action'], ['s3:GetObject'])
        self.assertEqual(self.statement('boundary','BatchCancel')['Condition'], {'StringEquals':{'aws:ResourceTag/Project':'qsb-gpu'}})

    def test_batch_read_tag_and_artifact_resources_are_exact(self):
        expected = {
            'BatchRead': (['batch:DescribeJobs','batch:DescribeJobDefinitions','batch:DescribeJobQueues','batch:DescribeComputeEnvironments','batch:ListJobs'], ['*'], {'StringEquals':{'aws:RequestedRegion':'eu-west-1'}}),
            'BatchTag': (['batch:TagResource'], ['arn:aws:batch:eu-west-1:123456789012:job/*'], {'StringEquals':{'aws:RequestTag/Project':'qsb-gpu'},'ForAllValues:StringEquals':{'aws:TagKeys':['Project','QsbRequest','InputSha256']}}),
            'GpuInputs': (['s3:PutObject'], ['arn:aws:s3:::qsb-gpu-123456789012-eu-west-1-jobs/inputs/*'], None),
            'GpuOutputs': (['s3:GetObject'], ['arn:aws:s3:::qsb-gpu-123456789012-eu-west-1-jobs/outputs/*'], None),
        }
        for sid, (actions, resources, condition) in expected.items():
            statement = {'Sid':sid, 'Effect':'Allow', 'Action':actions, 'Resource':resources}
            if condition is not None: statement['Condition'] = condition
            self.assertEqual(self.statement('boundary',sid), statement)

    def test_role_passing_only_to_retained_execution_services(self):
        passing = self.statement('deploy', 'PassRuntimeRoles')
        self.assertEqual(passing['Resource'], ['arn:aws:iam::123456789012:role/qsb/runtime/qsb-*'])
        self.assertEqual(passing['Condition'], {'StringEquals': {
            'iam:PassedToService': ['lambda.amazonaws.com', 'states.amazonaws.com']}})

    def test_oidc_trust_is_exact_and_unchanged(self):
        self.assertEqual(self.policies['trust'], {'Version': '2012-10-17', 'Statement': [{
            'Effect': 'Allow', 'Principal': {'Federated':
                'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com'},
            'Action': 'sts:AssumeRoleWithWebIdentity', 'Condition': {'StringEquals': {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': self.inventory['subject']}}}]})

    def test_state_write_and_lock_delete_are_separate_from_snapshot_deletion(self):
        self.assertEqual(self.statement('deploy', 'StateObjects')['Action'], ['s3:GetObject', 's3:PutObject'])
        lock = self.statement('deploy', 'StateLocks')
        self.assertEqual(lock['Action'], ['s3:DeleteObject'])
        self.assertEqual(lock['Resource'], ['arn:aws:s3:::qsb-test-state/qsb/*.tflock'])

    def test_boundary_covers_every_dynamodb_action_the_runtime_policies_allow(self):
        # A boundary gap is an implicit deny the role policy can't override; this caught ConditionCheckItem.
        root = Path(__file__).resolve().parents[2]
        records = self.statement('boundary', 'Records')['Action']
        for policy in sorted((root / 'terraform/policies').glob('*.json')):
            for statement in json.loads(policy.read_text()):
                if statement['Effect'] != 'Allow':
                    continue
                for action in statement['Action']:
                    if action.startswith('dynamodb:'):
                        self.assertIn(action, records, f'{policy.name}: {action} is outside qsb-runtime-boundary')

    def test_retained_pipeline_and_boundary_grants(self):
        for service in ('Lambda', 'Dynamodb', 'States', 'Cloudwatch'):
            self.assertEqual(self.statement('deploy', service + 'Qsb')['Effect'], 'Allow')
        for sid in ('QsbBuckets', 'QsbLogs', 'RegisteredQsbCloudFront', 'RegisteredQsbApis'):
            self.assertEqual(self.statement('deploy', sid)['Effect'], 'Allow')
        self.assertEqual(self.statement('boundary', 'Functions')['Action'], ['lambda:InvokeFunction'])
        self.assertIn('states:StartExecution', self.statement('boundary', 'Workflow')['Action'])
        self.assertIn('dynamodb:PutItem', self.statement('boundary', 'Records')['Action'])
        self.assertEqual(self.statement('deploy', 'CreateBoundedRuntimeRoles')['Condition'], {
            'StringEquals': {'iam:PermissionsBoundary':
                'arn:aws:iam::123456789012:policy/qsb/bootstrap/qsb-runtime-boundary'}})
        self.assertEqual(self.statement('deploy', 'NeverRemoveRuntimeBoundary')['Effect'], 'Deny')
        self.assertEqual(self.statement('deploy', 'ProtectBootstrapAndBoundaries')['Effect'], 'Deny')


if __name__ == '__main__':
    unittest.main()
