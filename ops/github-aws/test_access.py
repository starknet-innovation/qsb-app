"""Offline regression checks for the QSB human access identities (access.py).

These inspect policy structure; use verify_access.py for IAM simulation.
"""
import fnmatch
import unittest

from access import MANAGED_POLICY_LIMIT, access, size

ACCOUNT = '123456789012'


def actions(statement):
    value = statement.get('Action', [])
    return value if isinstance(value, list) else [value]


def matches(action, patterns):
    return any(fnmatch.fnmatchcase(action.lower(), p.lower()) for p in patterns)


class HumanAccess(unittest.TestCase):
    def setUp(self):
        self.out = access(dict(
            account=ACCOUNT, region='eu-west-1', subject='repo:example/qsb:ref:refs/heads/main',
            state_bucket='qsb-test-state', distributions=['TESTCDN'], apis=['testapi'],
            origin_access_controls=['TESTOAC'], response_headers_policies=['TESTHEADERS'],
            operator_user='qsb-operator-user', gpu_vpc='vpc-0test'))
        self.operator = [s for d in self.out['operator']['policies'] for s in d['Statement']]
        self.viewonly = [s for d in self.out['viewonly']['policies'] for s in d['Statement']]

    def allowed(self, statements):
        return [(a, s) for s in statements if s['Effect'] == 'Allow' for a in actions(s)]

    def denied(self, statements):
        return [a for s in statements if s['Effect'] == 'Deny' for a in actions(s)]

    def sid(self, statements, sid):
        return next(s for s in statements if s.get('Sid') == sid)

    def test_roles_trust_only_the_named_user_with_mfa(self):
        for role in ('viewonly', 'operator'):
            [statement] = self.out[role]['trust']['Statement']
            self.assertEqual(statement['Principal'], {'AWS': f'arn:aws:iam::{ACCOUNT}:user/qsb/operators/qsb-operator-user'})
            self.assertEqual(statement['Action'], 'sts:AssumeRole')
            self.assertEqual(statement['Condition'], {'Bool': {'aws:MultiFactorAuthPresent': 'true'},
                                                      'NumericLessThanIfExists': {'aws:MultiFactorAuthAge': '3600'}})
        self.assertEqual(self.out['operator']['max_session'], 3600)

    def test_user_can_only_sign_in_and_assume_the_two_roles(self):
        user = self.out['user']
        self.assertEqual(user['managed'], ['arn:aws:iam::aws:policy/SignInLocalDevelopmentAccess'])
        guard = self.sid(user['inline']['Statement'], 'OnlyTheseRoles')
        self.assertEqual(guard['Effect'], 'Deny')
        self.assertEqual(guard['Action'], ['sts:AssumeRole'])
        self.assertEqual(guard['NotResource'], [f'arn:aws:iam::{ACCOUNT}:role/qsb/bootstrap/qsb-viewonly',
                                                f'arn:aws:iam::{ACCOUNT}:role/qsb/bootstrap/qsb-operator'])
        # Resource policies or trust written by the operator can't grant the user anything else.
        rest = self.sid(user['inline']['Statement'], 'NothingElse')
        self.assertEqual((rest['Effect'], rest['Resource']), ('Deny', ['*']))
        self.assertEqual(set(rest['NotAction']), {'sts:AssumeRole', 'iam:ChangePassword', 'iam:GetUser',
                                                  'iam:GetAccountPasswordPolicy', 'signin:Authenticate', 'signin:AuthorizeOAuth2Access',
                                                  'signin:CreateOAuth2Token'})
        grants = {a for a, _ in self.allowed(user['inline']['Statement'])}
        self.assertEqual(grants, {'sts:AssumeRole', 'iam:ChangePassword', 'iam:GetUser', 'iam:GetAccountPasswordPolicy'})
        assume = self.sid(user['inline']['Statement'], 'AssumeQsbRoles')
        self.assertEqual(assume['Resource'], guard['NotResource'])

    def test_viewonly_adds_only_reads_and_denies_data(self):
        self.assertEqual(self.out['viewonly']['managed'], ['arn:aws:iam::aws:policy/job-function/ViewOnlyAccess'])
        for action, _ in self.allowed(self.viewonly):
            verb = action.split(':')[1]
            self.assertTrue(verb.startswith(('Describe', 'List', 'Get', 'Simulate')), action)
            self.assertFalse(verb in ('GetObject', 'GetItem', 'GetSecretValue'), action)
        denied = self.denied(self.viewonly)
        for action in ('s3:GetObject', 's3:GetObjectVersion', 's3:GetObjectTorrent', 'dynamodb:GetItem',
                       'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:GetRecords', 'secretsmanager:GetSecretValue',
                       'secretsmanager:BatchGetSecretValue', 'ssm:GetParameterHistory', 'kms:Decrypt',
                       'logs:GetLogEvents', 'logs:GetLogRecord', 'logs:StartLiveTail', 'lambda:GetFunction',
                       'lambda:GetLayerVersion', 'athena:GetQueryResults', 'cloudformation:GetTemplate',
                       'ec2:GetConsoleOutput', 'sts:AssumeRole'):
            self.assertTrue(matches(action, denied), action)

    def test_operator_never_grants_ingress_instances_users_or_keys(self):
        forbidden = ['ec2:AuthorizeSecurityGroupIngress', 'ec2:RunInstances', 'ec2:CreateVpc', 'iam:CreateUser',
                     'iam:CreateAccessKey', 'iam:CreateLoginProfile', 'iam:AttachUserPolicy', 'iam:CreatePolicyVersion']
        for action, statement in self.allowed(self.operator):
            for bad in forbidden:
                self.assertFalse(fnmatch.fnmatchcase(bad.lower(), action.lower()), (bad, statement['Sid']))
        denied = self.denied(self.operator)
        for bad in forbidden:
            self.assertTrue(matches(bad, denied), bad)

    def test_bootstrap_identities_and_boundaries_are_protected(self):
        guard = self.sid(self.operator, 'ProtectBootstrapIdentities')
        self.assertEqual(guard['Effect'], 'Deny')
        self.assertEqual(guard['Action'], ['iam:*'])
        self.assertEqual(guard['Resource'], [f'arn:aws:iam::{ACCOUNT}:role/qsb/bootstrap/*',
                                             f'arn:aws:iam::{ACCOUNT}:policy/qsb/bootstrap/*',
                                             f'arn:aws:iam::{ACCOUNT}:user/qsb/*'])
        self.assertEqual(self.sid(self.operator, 'NeverRemoveBoundaries')['Resource'],
                         [f'arn:aws:iam::{ACCOUNT}:role/qsb/runtime/*'])

    def test_gpu_roles_require_the_gpu_boundary_and_limited_pass_role(self):
        create = self.sid(self.operator, 'CreateBoundedGpuRoles')
        self.assertEqual(create['Resource'], [f'arn:aws:iam::{ACCOUNT}:role/qsb/runtime/qsb-gpu-*'])
        self.assertEqual(create['Condition'], {'StringEquals': {
            'iam:PermissionsBoundary': f'arn:aws:iam::{ACCOUNT}:policy/qsb/bootstrap/qsb-gpu-boundary'}})
        passing = self.sid(self.operator, 'PassGpuRoles')
        self.assertEqual(passing['Condition'], {'StringEquals': {
            'iam:PassedToService': ['ec2.amazonaws.com', 'ecs-tasks.amazonaws.com']}})
        for action, statement in self.allowed(self.operator):
            if action in ('iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy'):
                self.assertIn('iam:PermissionsBoundary', statement['Condition']['StringEquals'], statement['Sid'])

    def test_gpu_roles_can_only_carry_the_gpu_boundary(self):
        # The inherited deploy grant (qsb-* with the runtime boundary) also matches qsb-gpu-*.
        guard = self.sid(self.operator, 'GpuRolesOnlyWithGpuBoundary')
        self.assertEqual(guard['Effect'], 'Deny')
        self.assertEqual(guard['Resource'], [f'arn:aws:iam::{ACCOUNT}:role/qsb/runtime/qsb-gpu-*'])
        self.assertEqual(set(guard['Action']), {'iam:CreateRole', 'iam:PutRolePermissionsBoundary', 'iam:PutRolePolicy',
                                                'iam:AttachRolePolicy', 'iam:UpdateAssumeRolePolicy'})
        self.assertEqual(guard['Condition'], {'StringNotEquals': {
            'iam:PermissionsBoundary': f'arn:aws:iam::{ACCOUNT}:policy/qsb/bootstrap/qsb-gpu-boundary'}})

    def test_operator_cannot_chain_into_other_roles(self):
        guard = self.sid(self.operator, 'NoRoleChaining')
        self.assertEqual((guard['Effect'], guard['Action'], guard['Resource']), ('Deny', ['sts:AssumeRole'], ['*']))

    def test_smoke_jobs_and_role_passing_stay_exact(self):
        smoke = self.sid(self.operator, 'GpuSmokeJobs')
        self.assertEqual(smoke['Resource'], [f'arn:aws:batch:eu-west-1:{ACCOUNT}:job/*'])
        self.assertEqual(smoke['Condition'], {'StringEquals': {'aws:ResourceTag/Project': 'qsb-gpu'}})
        tags = self.sid(self.operator, 'GpuSmokeJobTags')
        self.assertEqual(tags['Condition'], {'StringEquals': {'aws:RequestTag/Project': 'qsb-gpu'}})
        passing = self.sid(self.operator, 'PassGpuRoles')
        self.assertEqual((passing['Action'], passing['Resource']),
                         (['iam:PassRole'], [f'arn:aws:iam::{ACCOUNT}:role/qsb/runtime/qsb-gpu-*']))
        for action, statement in self.allowed(self.operator):
            if action == 'iam:PassRole':
                self.assertIn('iam:PassedToService', statement['Condition']['StringEquals'], statement['Sid'])
                self.assertNotIn('*', statement['Resource'], statement['Sid'])

    def test_network_objects_need_the_gpu_tag(self):
        self.assertEqual(self.sid(self.operator, 'CreateTaggedSecurityGroup')['Condition'],
                         {'StringEquals': {'aws:RequestTag/Project': 'qsb-gpu'}})
        self.assertEqual(self.sid(self.operator, 'CreateTaggedLaunchTemplate')['Condition'],
                         {'StringEquals': {'aws:RequestTag/Project': 'qsb-gpu'}})
        manage = self.sid(self.operator, 'ManageGpuNetworkObjects')
        self.assertEqual(manage['Condition'], {'StringEquals': {'aws:ResourceTag/Project': 'qsb-gpu'}})
        self.assertFalse(any('Ingress' in a for a in manage['Action']))
        for action, statement in self.allowed(self.operator):
            if statement['Sid'] == 'SecurityGroupInGpuVpc':
                self.assertEqual(statement['Resource'], [f'arn:aws:ec2:eu-west-1:{ACCOUNT}:vpc/vpc-0test'])
            elif action.startswith('ec2:') and not action.startswith(('ec2:Describe', 'ec2:GetLaunchTemplateData')):
                self.assertIn('Condition', statement, (action, statement['Sid']))
            if action.startswith('ec2:Describe'):
                self.assertEqual(statement['Condition'], {'StringEquals': {'aws:RequestedRegion': 'eu-west-1'}})

    def test_paid_work_is_limited_to_the_qsb_queue(self):
        batch = self.sid(self.operator, 'GpuBatch')
        self.assertEqual(batch['Resource'], [
            f'arn:aws:batch:eu-west-1:{ACCOUNT}:compute-environment/qsb-gpu',
            f'arn:aws:batch:eu-west-1:{ACCOUNT}:job-queue/qsb-gpu',
            f'arn:aws:batch:eu-west-1:{ACCOUNT}:job-definition/qsb-gpu-solver',
            f'arn:aws:batch:eu-west-1:{ACCOUNT}:job-definition/qsb-gpu-solver:*'])
        for action, statement in self.allowed(self.operator):
            if action in ('batch:*', 'batch:SubmitJob'):
                self.assertTrue(all('qsb-gpu' in r for r in statement['Resource']), statement['Sid'])

    def test_gpu_boundary_covers_the_gpu_stack_and_nothing_paid(self):
        boundary = self.out['gpu_boundary']['document']['Statement']
        granted = [a for s in boundary for a in actions(s)]
        # AmazonEC2ContainerServiceforEC2Role and the terraform/gpu job, execution and watchdog policies.
        needed = ['ec2:DescribeTags', 'ecs:CreateCluster', 'ecs:DeregisterContainerInstance', 'ecs:DiscoverPollEndpoint',
                  'ecs:Poll', 'ecs:RegisterContainerInstance', 'ecs:StartTelemetrySession',
                  'ecs:UpdateContainerInstancesState', 'ecs:SubmitTaskStateChange', 'ecs:TagResource',
                  'ecr:GetAuthorizationToken', 'ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer',
                  'ecr:BatchGetImage', 'logs:CreateLogStream', 'logs:PutLogEvents', 's3:GetObject', 's3:PutObject',
                  'batch:ListJobs', 'batch:DescribeJobs', 'batch:TerminateJob']
        for action in needed:
            self.assertTrue(matches(action, granted), action)
        for action in ('batch:SubmitJob', 'ec2:RunInstances', 'iam:PassRole', 'secretsmanager:GetSecretValue', 's3:*'):
            self.assertFalse(matches(action, granted), action)
        inputs = self.sid(boundary, 'JobInputs')
        self.assertEqual(inputs['Resource'], [f'arn:aws:s3:::qsb-gpu-{ACCOUNT}-eu-west-1-jobs/inputs/*'])

    def test_operator_cannot_add_external_resource_grants(self):
        guard = self.sid(self.operator, 'OnlyRequiredLambdaPrincipals')
        self.assertEqual((guard['Effect'], guard['Action'], guard['Resource']),
                         ('Deny', ['lambda:AddPermission'], ['*']))
        self.assertEqual(guard['Condition'], {'StringNotEquals': {
            'lambda:Principal': ['apigateway.amazonaws.com', 'events.amazonaws.com']}})
        guard = self.sid(self.operator, 'NoFunctionUrlsOrExternalResourcePolicies')
        self.assertEqual((guard['Effect'], guard['Resource']), ('Deny', ['*']))
        self.assertEqual(set(guard['Action']), {'lambda:CreateFunctionUrlConfig',
            'lambda:UpdateFunctionUrlConfig', 'dynamodb:PutResourcePolicy', 'ecr:SetRepositoryPolicy'})

    def test_access_analyzer_is_readable_but_out_of_operator_reach(self):
        guard = self.sid(self.operator, 'ProtectAccessAnalyzer')
        self.assertEqual((guard['Effect'], guard['Action'], guard['Resource']), ('Deny', ['access-analyzer:*'], ['*']))
        granted = {a for a, _ in self.allowed(self.viewonly)}
        self.assertLessEqual({'access-analyzer:ListAnalyzers', 'access-analyzer:ListFindingsV2'}, granted)

    def test_policies_fit_iam_limits(self):
        for role in ('viewonly', 'operator'):
            docs = self.out[role]['policies']
            self.assertLessEqual(len(docs) + len(self.out[role]['managed']), 10)
            for doc in docs:
                self.assertLessEqual(size(doc), MANAGED_POLICY_LIMIT)
        self.assertLessEqual(size(self.out['gpu_boundary']['document']), MANAGED_POLICY_LIMIT)
        self.assertLessEqual(size(self.out['user']['inline']), 2048)
        sids = [s['Sid'] for s in self.operator]
        self.assertEqual(len(sids), len(set(sids)))


if __name__ == '__main__':
    unittest.main()
