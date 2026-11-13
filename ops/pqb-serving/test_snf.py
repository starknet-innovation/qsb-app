"""Isolated-account authority and public-data boundaries; no AWS calls."""
import copy
import json
from pathlib import Path
from unittest.mock import Mock
import unittest
import snf


def campaign():
    c = Mock(); c.account = '123456789012'; c.region = 'eu-west-2'; c.config = {'snfIsolation': True}
    c.arn.side_effect = lambda service, resource: f'arn:aws:{service}:{c.region}:{c.account}:{resource}'
    c.iam.side_effect = lambda name: f'arn:aws:iam::{c.account}:role/qsb/runtime/{name}'
    name = 'qsb-pqb-v-012345abcdef'
    c.state = {'name': name, 'sourceCommit': 'a' * 40, 'deadline': 2000000000,
        'queue': c.arn('batch', 'job-queue/qsb-gpu-validation'), 'bucket': name + '-artifacts',
        'tables': [name + '-preflight', name + '-solve'], 'function': name + '-coordinator',
        'cleanupFunction': name + '-deadline', 'workflow': name,
        'snfBootstrap': {'securityGroup': 'sg-owned', 'launchTemplate': 'lt-owned', 'instanceProfileArn': c.iam(name + '-host')}}
    return c


class SnfTests(unittest.TestCase):
    def test_isolation_mode_requires_the_explicit_selected_root_account(self):
        c = campaign(); c.client.return_value.get_caller_identity.return_value = {'Arn': f'arn:aws:iam::{c.account}:root'}
        snf.require_mode(c)
        for identity in ['arn:aws:iam::999999999999:root', f'arn:aws:sts::{c.account}:assumed-role/operator/session']:
            c.client.return_value.get_caller_identity.return_value = {'Arn': identity}
            with self.assertRaises(RuntimeError): snf.require_mode(c)
        c.config = {}; c.client.return_value.get_caller_identity.return_value = {'Arn': f'arn:aws:iam::{c.account}:root'}
        with self.assertRaises(RuntimeError): snf.require_mode(c)
        c.mutate.assert_not_called()

    def test_runtime_boundary_scopes_data_and_preserves_cleanup_authority_after_deadline(self):
        c = campaign(); value = snf.boundary(c)
        for statement in value['Statement']:
            self.assertEqual(statement['Condition']['StringEquals']['aws:RequestedRegion'], c.region)
            self.assertIn('DateLessThan', statement['Condition'])
            self.assertNotIn('iam:', json.dumps(statement))
        submitted = next(s for s in value['Statement'] if s['Action'] == ['batch:SubmitJob'])
        self.assertEqual(submitted['Resource'], [c.state['queue'], c.arn('batch', 'job-definition/qsb-gpu-solver:*')])
        objects = [s['Resource'] for s in value['Statement'] if s['Action'] in (['s3:GetObject'], ['s3:PutObject'])]
        self.assertEqual(objects, [f"arn:aws:s3:::{c.state['bucket']}/inputs/*", f"arn:aws:s3:::{c.state['bucket']}/outputs/*"])
        self.assertNotIn('secretsmanager', json.dumps(value)); self.assertNotIn('kms:', json.dumps(value))

    def test_worker_roles_have_only_public_prefixes_and_immutable_registry_reads(self):
        c = campaign(); value = snf.worker_policies(c)
        self.assertEqual({a for s in value['task']['Statement'] for a in s['Action']}, {'s3:GetObject', 's3:PutObject'})
        self.assertTrue(all(c.state['bucket'] in s['Resource'] for s in value['task']['Statement']))
        actions = {a for s in value['execute']['Statement'] for a in s['Action']}
        self.assertNotIn('ecr:PutImage', actions); self.assertNotIn('s3:GetObject', actions)
        self.assertNotIn('iam:', json.dumps(value))

    def test_compute_plan_keeps_zero_minimum_encrypted_host_template_and_public_profile(self):
        c = campaign(); snapshot = {'subnets': [{'SubnetId': 'subnet-b'}, {'SubnetId': 'subnet-a'}], 'image': {'ImageId': 'ami-owned'}}
        resources = snf.compute_resources(c, snapshot)
        self.assertEqual(resources['minvCpus'], 0); self.assertEqual(resources['desiredvCpus'], 0)
        self.assertEqual(resources['maxvCpus'], 64); self.assertEqual(resources['instanceTypes'], ['g5.2xlarge'])
        self.assertEqual(resources['subnets'], ['subnet-a', 'subnet-b'])
        self.assertEqual(resources['launchTemplate'], {'launchTemplateId': 'lt-owned', 'version': '1', 'overrides': []})
        self.assertEqual(resources['securityGroupIds'], ['sg-owned'])

    def test_other_gpu_work_is_never_used_or_terminated(self):
        c = campaign(); paginator = c.client.return_value.get_paginator.return_value
        paginator.paginate.return_value = [{'Reservations': [{'Instances': [{'InstanceId': 'other', 'Tags': []}]}]}]
        with self.assertRaisesRegex(RuntimeError, 'Other GPU'): snf.check_baseline(c, True)
        c.mutate.assert_not_called()

    def test_ownership_requires_project_campaign_and_source(self):
        c = campaign(); expected = snf.tags(c); snf.check_owned(expected, c)
        for key in expected:
            changed = copy.deepcopy(expected); changed[key] = 'other'
            with self.assertRaises(RuntimeError): snf.check_owned(changed, c)

    def test_initial_definition_binds_the_campaign_bucket_and_real_worker_command(self):
        c = campaign(); c.state['descriptor'] = {'image': 'ghcr.io/worker@sha256:' + 'b' * 64}
        properties = snf.initial_container(c, '/aws/batch/' + c.state['name'])
        self.assertEqual(properties['environment'], [{'name': 'QSB_JOB_BUCKET', 'value': c.state['bucket']}])
        self.assertEqual(properties['command'], json.loads((snf.ROOT / 'server/aws-batch-command.json').read_text()))
        self.assertTrue(properties['readonlyRootFilesystem']); self.assertFalse(properties['privileged'])
        self.assertTrue(properties['image'].endswith('@sha256:' + 'b' * 64))

    def test_bootstrap_removal_requires_completed_runtime_and_capacity_cleanup(self):
        c = campaign(); c.state.update(phase='preflight-running', capacity={'status': 'ready'})
        with self.assertRaisesRegex(RuntimeError, 'runtime and fleet'): snf.remove(c)
        c.mutate.assert_not_called()


if __name__ == '__main__': unittest.main()
