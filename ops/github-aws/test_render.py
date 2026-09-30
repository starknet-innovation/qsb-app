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
            account='123456789012', region='eu-west-2',
            subject='repo:example/qsb:ref:refs/heads/main',
            state_bucket='qsb-test-state', distributions=['TESTCDN'],
            apis=['testapi'], origin_access_controls=['TESTOAC'],
            response_headers_policies=['TESTHEADERS'],
        )
        self.policies = render(self.inventory)

    def statement(self, policy, sid):
        return next(s for s in self.policies[policy]['Statement'] if s['Sid'] == sid)

    def test_a_new_account_without_registered_edge_ids_renders_valid_policies(self):
        empty = render(dict(self.inventory, distributions=[], apis=[], origin_access_controls=[], response_headers_policies=[]))
        self.assertTrue(all(s['Resource'] for s in empty['deploy']['Statement']))
        cdn = next(s for s in empty['deploy']['Statement'] if s['Sid'] == 'RegisteredQsbCloudFront')
        self.assertTrue(all(r.endswith('/UNREGISTERED') for r in cdn['Resource']))
        apis = next(s for s in empty['deploy']['Statement'] if s['Sid'] == 'RegisteredQsbApis')
        self.assertTrue(all('/apis/UNREGISTERED' in r for r in apis['Resource']))
        # Registering the IDs later changes only those resources, so the policy shape is the same.
        self.assertEqual([s['Sid'] for s in empty['deploy']['Statement']], [s['Sid'] for s in self.policies['deploy']['Statement']])

    def test_removed_services_have_no_deploy_or_runtime_actions(self):
        removed = {'ec2', 'backup', 'sqs', 'events', 'ecr'}
        for kind in ('deploy', 'boundary'):
            for statement in self.policies[kind]['Statement']:
                if statement['Effect'] == 'Allow':
                    for action in statement['Action']:
                        self.assertNotIn(action.split(':')[0], removed, (kind, action))
        # The only secret any runtime role may ever read is the API's MARA Slipstream credential.
        secret = [s for s in self.policies['boundary']['Statement'] if any(a.startswith('secretsmanager:') for a in s['Action'])]
        self.assertEqual(secret, [{'Sid': 'MinerCredential', 'Effect': 'Allow', 'Action': ['secretsmanager:GetSecretValue'],
                                   'Resource': ['arn:aws:secretsmanager:eu-west-2:123456789012:secret:qsb/slipstream-??????'],
                                   'Condition': {'ArnLike': {'aws:PrincipalArn': 'arn:aws:iam::123456789012:role/qsb/runtime/qsb-*-api'}}}])
        self.assertFalse(any(a in ('*', 'kms:*', 'kms:Decrypt') for s in self.policies['boundary']['Statement'] for a in s['Action']))

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
        self.assertEqual(self.statement('boundary','BatchSubmit')['Resource'], ['arn:aws:batch:eu-west-2:123456789012:job-queue/qsb-gpu','arn:aws:batch:eu-west-2:123456789012:job-definition/qsb-gpu-solver:*'])
        self.assertEqual(self.statement('boundary','GpuInputs')['Action'], ['s3:PutObject'])
        self.assertEqual(self.statement('boundary','GpuOutputs')['Action'], ['s3:GetObject'])
        self.assertEqual(self.statement('boundary','BatchCancel')['Condition'], {'StringEquals':{'aws:ResourceTag/Project':'qsb-gpu'}})

    def test_batch_read_tag_and_artifact_resources_are_exact(self):
        expected = {
            'BatchRead': (['batch:DescribeJobs','batch:DescribeJobDefinitions','batch:DescribeJobQueues','batch:DescribeComputeEnvironments','batch:ListJobs'], ['*'], {'StringEquals':{'aws:RequestedRegion':'eu-west-2'}}),
            'BatchTag': (['batch:TagResource'], ['arn:aws:batch:eu-west-2:123456789012:job/*', 'arn:aws:batch:eu-west-2:123456789012:job-queue/qsb-gpu', 'arn:aws:batch:eu-west-2:123456789012:job-definition/qsb-gpu-solver:*'], {'StringEquals':{'aws:RequestTag/Project':'qsb-gpu'},'ForAllValues:StringEquals':{'aws:TagKeys':['Project','QsbRequest','InputSha256']}}),
            'GpuInputs': (['s3:PutObject'], ['arn:aws:s3:::qsb-gpu-123456789012-eu-west-2-jobs/inputs/*'], None),
            'GpuOutputs': (['s3:GetObject'], ['arn:aws:s3:::qsb-gpu-123456789012-eu-west-2-jobs/outputs/*'], None),
        }
        for sid, (actions, resources, condition) in expected.items():
            statement = {'Sid':sid, 'Effect':'Allow', 'Action':actions, 'Resource':resources}
            if condition is not None: statement['Condition'] = condition
            self.assertEqual(self.statement('boundary',sid), statement)

    def test_role_passing_only_to_retained_execution_services(self):
        passing = self.statement('deploy', 'PassRuntimeRoles')
        self.assertEqual(passing['Resource'], ['arn:aws:iam::123456789012:role/qsb/runtime/qsb-*'])
        # Scheduler runs the webhook dispatcher's schedule (terraform/webhooks.tf) with a runtime role.
        self.assertEqual(passing['Condition'], {'StringEquals': {
            'iam:PassedToService': ['lambda.amazonaws.com', 'states.amazonaws.com', 'scheduler.amazonaws.com']}})
        passes = [s for s in self.policies['deploy']['Statement'] if 'iam:PassRole' in s['Action']]
        self.assertEqual(passes, [passing])

    def test_schedules_are_qsb_named_in_the_default_group_only(self):
        self.assertEqual(self.statement('deploy', 'QsbSchedules'), {
            'Sid': 'QsbSchedules', 'Effect': 'Allow',
            'Action': ['scheduler:CreateSchedule', 'scheduler:GetSchedule', 'scheduler:UpdateSchedule', 'scheduler:DeleteSchedule'],
            'Resource': ['arn:aws:scheduler:eu-west-2:123456789012:schedule/default/qsb-*']})
        # No schedule groups, tags or other Scheduler actions for the deployer, and none at all for runtime roles.
        for kind, sids in (('deploy', {'QsbSchedules'}), ('boundary', set())):
            with self.subTest(kind=kind):
                self.assertEqual({s['Sid'] for s in self.policies[kind]['Statement']
                                  if any(a.startswith('scheduler:') for a in s['Action'])}, sids)

    def test_deployer_can_tag_what_default_tags_tag_and_schedules_need_no_tag_grant(self):
        # terraform/versions.tf default_tags reach every taggable resource. The dispatcher's Lambda, log group, alarm
        # and two roles are tagged through the same statements as the existing ones. EventBridge Scheduler can tag only
        # schedule groups: aws_scheduler_schedule has no tags (provider v6.66.0 registers it without @Tags), so
        # schedules need no scheduler:TagResource, UntagResource or ListTagsForResource.
        unconditioned = [s for s in self.policies['deploy']['Statement'] if s['Effect'] == 'Allow' and 'Condition' not in s]
        grants = lambda action, resource: any(
            any(fnmatch.fnmatchcase(action, a) for a in s['Action']) and any(fnmatch.fnmatchcase(resource, r) for r in s['Resource'])
            for s in unconditioned)
        arn = 'arn:aws:{}:eu-west-2:123456789012:{}'.format
        role = 'arn:aws:iam::123456789012:role/qsb/runtime/{}'.format
        for action, resource in (('lambda:TagResource', arn('lambda', 'function:qsb-app-webhooks')),
                                 ('lambda:UntagResource', arn('lambda', 'function:qsb-app-webhooks')),
                                 ('lambda:ListTags', arn('lambda', 'function:qsb-app-webhooks')),
                                 ('iam:TagRole', role('qsb-app-webhooks')), ('iam:UntagRole', role('qsb-app-webhooks')),
                                 ('iam:ListRoleTags', role('qsb-app-webhooks')), ('iam:TagRole', role('qsb-app-webhook-schedule')),
                                 ('iam:UntagRole', role('qsb-app-webhook-schedule')), ('iam:ListRoleTags', role('qsb-app-webhook-schedule')),
                                 ('logs:TagResource', arn('logs', 'log-group:/aws/lambda/qsb-app-webhooks')),
                                 ('logs:ListTagsForResource', arn('logs', 'log-group:/aws/lambda/qsb-app-webhooks')),
                                 ('cloudwatch:TagResource', arn('cloudwatch', 'alarm:qsb-app-webhooks-errors')),
                                 ('cloudwatch:ListTagsForResource', arn('cloudwatch', 'alarm:qsb-app-webhooks-errors'))):
            with self.subTest(action=action, resource=resource):
                self.assertTrue(grants(action, resource))
        for action in ('scheduler:TagResource', 'scheduler:UntagResource', 'scheduler:ListTagsForResource'):
            with self.subTest(action=action):
                self.assertFalse(grants(action, arn('scheduler', 'schedule/default/qsb-app-webhooks')))

    def test_deployer_can_manage_the_dispatchers_async_invoke_settings(self):
        # terraform/webhooks.tf turns Lambda's async retries off for the dispatcher (aws_lambda_function_event_invoke_config).
        function = 'arn:aws:lambda:eu-west-2:123456789012:function:qsb-app-webhooks'
        lambdas = self.statement('deploy', 'LambdaQsb')
        for action in ('lambda:PutFunctionEventInvokeConfig', 'lambda:GetFunctionEventInvokeConfig',
                       'lambda:UpdateFunctionEventInvokeConfig', 'lambda:DeleteFunctionEventInvokeConfig'):
            with self.subTest(action=action):
                self.assertTrue(any(fnmatch.fnmatchcase(action, a) for a in lambdas['Action']))
                self.assertTrue(any(fnmatch.fnmatchcase(function, r) for r in lambdas['Resource']))
        self.assertNotIn('Condition', lambdas)

    def test_boundary_already_covers_the_webhook_dispatcher_and_its_schedule(self):
        # The dispatcher's Query reaches the due-delivery index, a sub-resource of the table; the schedule's role
        # invokes the dispatcher; both write their Lambda logs. The boundary needs no new statement for any of them.
        allowed = [s for s in self.policies['boundary']['Statement'] if s['Effect'] == 'Allow']
        covers = lambda action, resource: any(
            any(fnmatch.fnmatchcase(action, a) for a in s['Action']) and any(fnmatch.fnmatchcase(resource, r) for r in s['Resource'])
            and 'Condition' not in s for s in allowed)
        arn = 'arn:aws:{}:eu-west-2:123456789012:{}'.format
        # The dispatcher's item grant is limited to WEBHOOK# keys by its own policy; the boundary is table-wide.
        for action, resource in (('dynamodb:Query', arn('dynamodb', 'table/qsb-app-records/index/webhook-due')),
                                 ('dynamodb:GetItem', arn('dynamodb', 'table/qsb-app-records')),
                                 ('dynamodb:PutItem', arn('dynamodb', 'table/qsb-app-records')),
                                 ('lambda:InvokeFunction', arn('lambda', 'function:qsb-app-webhooks')),
                                 ('logs:PutLogEvents', arn('logs', 'log-group:/aws/lambda/qsb-app-webhooks:log-stream:x'))):
            with self.subTest(action=action):
                self.assertTrue(covers(action, resource), (action, resource))

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

    def test_boundary_covers_every_action_the_runtime_policies_allow(self):
        # A boundary gap is an implicit deny the role policy can't override; this caught ConditionCheckItem.
        # All four files attach to /qsb/runtime/ roles under the boundary (compute.tf, operator.tf, webhooks.tf).
        root = Path(__file__).resolve().parents[2]
        policies = sorted((root / 'terraform/policies').glob('*.json'))
        self.assertEqual({p.name for p in policies},
                         {'app-records.json', 'coordinator-records.json', 'operator-reconcile-records.json',
                          'webhook-dispatcher-records.json'})
        allowed = [a.lower() for s in self.policies['boundary']['Statement'] if s['Effect'] == 'Allow'
                   for a in s['Action']]
        for policy in policies:
            for statement in json.loads(policy.read_text()):
                if statement['Effect'] != 'Allow':
                    continue
                actions = statement['Action']
                for action in [actions] if isinstance(actions, str) else actions:
                    self.assertTrue(any(fnmatch.fnmatchcase(action.lower(), a) for a in allowed),
                                    f'{policy.name}: {action} is outside qsb-runtime-boundary')

    def test_cloudfront_discovery_covers_the_managed_policy_lookups(self):
        # terraform/web.tf resolves the managed policies at plan time; without these grants every plan fails.
        discovery = self.statement('deploy', 'CloudFrontDiscovery')
        for action in ('cloudfront:ListCachePolicies', 'cloudfront:GetCachePolicy', 'cloudfront:GetOriginRequestPolicy'):
            self.assertIn(action, discovery['Action'])
        self.assertEqual(discovery['Resource'], ['*'])

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
