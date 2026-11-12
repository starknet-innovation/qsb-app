"""Isolated capacity safeguards: no credentials, cloud calls or paid work."""
import copy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import capacity


class CapacityTests(unittest.TestCase):
    def fixture(self):
        c = Mock(); c.account = '123456789012'; c.region = 'eu-west-2'
        c.arn.side_effect = lambda service, resource: f'arn:aws:{service}:eu-west-2:{c.account}:{resource}'
        c.state = {'name': 'qsb-pqb-v-012345abcdef', 'capacity': {'status': 'ready'}, 'knownJobIds': []}
        condition = {'StringEquals': {'aws:RequestedRegion': c.region}, 'DateLessThan': {'aws:CurrentTime': '2030-01-01T12:00:00Z'}}
        policy = {'Version': '2012-10-17', 'Statement': [
            {'Effect': 'Allow', 'Action': sorted(actions), 'Resource': c.arn('batch', resource), 'Condition': copy.deepcopy(condition)}
            for resource, actions in [('compute-environment/' + capacity.COMPUTE_NAME, capacity.COMPUTE_ACTIONS),
                                      ('job-queue/' + capacity.QUEUE_NAME, capacity.QUEUE_ACTIONS)]]}
        resources = {'type': 'EC2', 'allocationStrategy': 'BEST_FIT', 'instanceTypes': ['g5.xlarge'],
            'minvCpus': 0, 'desiredvCpus': 0, 'maxvCpus': 64, 'subnets': ['subnet-public'], 'securityGroupIds': ['sg-public'],
            'instanceRole': 'existing-reviewed-profile', 'launchTemplate': {'launchTemplateId': 'lt-public', 'version': '1'},
            'ec2Configuration': [{'imageType': 'ECS_AL2023_NVIDIA', 'imageIdOverride': 'ami-reviewed'}]}
        updated = copy.deepcopy(resources)
        updated.update(allocationStrategy='BEST_FIT_PROGRESSIVE', instanceTypes=['g5.2xlarge'])
        expiry = capacity.validate_operator_policy(policy, c)
        original = {'computeEnvironmentArn': c.arn('batch', 'compute-environment/qsb-gpu'), 'type': 'MANAGED',
                    'state': 'ENABLED', 'status': 'VALID', 'computeResources': resources}
        boundary = {'Version': '2012-10-17', 'Statement': [{'Sid': 'Existing', 'Effect': 'Allow', 'Action': ['s3:GetObject'], 'Resource': 'original-resource'}]}
        plan = {'format': 'pqb-validation-capacity-v2', 'sourceCommit': 'source',
            'computeArn': c.arn('batch', 'compute-environment/' + capacity.COMPUTE_NAME), 'queueArn': c.arn('batch', 'job-queue/' + capacity.QUEUE_NAME),
            'createdAt': expiry - 8 * 3600, 'expiresAt': expiry, 'operatorPolicy': policy, 'boundaryBaseline': boundary,
            'runtimeBoundary': capacity.requested_boundary(boundary, c, expiry), 'computeBaseline': original, 'computeResources': updated,
            'productionQueue': {'jobQueueArn': c.arn('batch', 'job-queue/qsb-gpu'), 'computeEnvironmentOrder': [
                {'order': 1, 'computeEnvironment': original['computeEnvironmentArn']}]}}
        return c, plan

    def object(self):
        c, plan = self.fixture(); result = object.__new__(capacity.Capacity)
        result.c = c; result.plan = plan; result.batch = Mock(); c.state['queue'] = plan['queueArn']
        return result

    def test_operator_grant_cannot_broaden_resources_actions_or_conditions(self):
        c, plan = self.fixture(); policy = plan['operatorPolicy']
        mutations = [lambda p: p['Statement'][0].update(Resource='*'),
            lambda p: p['Statement'][0].update(Action=['batch:*']),
            lambda p: p['Statement'][0].update(NotAction='iam:*'),
            lambda p: p['Statement'][0]['Condition'].pop('DateLessThan'),
            lambda p: p['Statement'][0]['Condition']['StringEquals'].update({'aws:RequestedRegion': 'us-east-1'}),
            lambda p: p['Statement'].pop()]
        for mutate in mutations:
            changed = copy.deepcopy(policy); mutate(changed)
            with self.assertRaises(RuntimeError): capacity.validate_operator_policy(changed, c)

    def test_plan_preserves_baseline_and_rejects_changed_hardware_or_expiry(self):
        c, plan = self.fixture(); capacity.validate_plan(plan, c)
        mutations = [lambda p: p['computeResources'].update(maxvCpus=128),
            lambda p: p['computeResources'].update(instanceTypes=['p4d.24xlarge']),
            lambda p: p['computeResources']['launchTemplate'].update(version='$Latest'),
            lambda p: p['computeResources']['ec2Configuration'][0].update(imageIdOverride='ami-other'),
            lambda p: p.update(expiresAt=p['expiresAt'] + 1),
            lambda p: p.update(createdAt=p['expiresAt'] - 25 * 3600),
            lambda p: p['runtimeBoundary']['Statement'][0].update(Resource='*')]
        for mutate in mutations:
            changed = copy.deepcopy(plan); mutate(changed)
            with self.assertRaises(RuntimeError): capacity.validate_plan(changed, c)

    def test_boundary_supplement_keeps_existing_statements_and_limits_runtime_identity(self):
        c, plan = self.fixture(); boundary = plan['runtimeBoundary']
        self.assertEqual(boundary['Statement'][:-2], plan['boundaryBaseline']['Statement'])
        for statement in boundary['Statement'][-2:]:
            self.assertEqual(statement['Resource'], [plan['queueArn']])
            self.assertTrue(statement['Condition']['ArnLike']['aws:PrincipalArn'].endswith('qsb-pqb-v-????????????-coordinator'))
            self.assertIn('DateLessThan', statement['Condition'])
        self.assertEqual(boundary['Statement'][-1]['Condition']['Null'], {'aws:TagKeys': 'false'})

    def test_grant_readback_detects_unrelated_boundary_changes_and_expiry(self):
        pool = self.object(); iam = Mock(); pool.metadata_session = Mock(return_value=Mock(client=Mock(return_value=iam)))
        iam.get_role_policy.return_value = {'PolicyDocument': pool.plan['operatorPolicy']}
        iam.get_policy.return_value = {'Policy': {'DefaultVersionId': 'v3'}}
        iam.get_policy_version.return_value = {'PolicyVersion': {'Document': pool.plan['runtimeBoundary']}}
        pool.check_grant()
        iam.get_policy_version.return_value = {'PolicyVersion': {'Document': pool.plan['boundaryBaseline']}}
        with self.assertRaisesRegex(RuntimeError, 'Runtime boundary'): pool.check_grant()
        with patch('capacity.time.time', return_value=pool.plan['expiresAt']):
            with self.assertRaisesRegex(RuntimeError, 'expired'): pool.check_grant()

    def test_ready_requires_owned_hardware_and_one_isolated_pool(self):
        pool = self.object(); pool.production_unchanged = Mock(); pool.check_grant = Mock()
        resources = copy.deepcopy(pool.plan['computeResources']); resources['tags'] = {'Project': 'qsb-gpu', 'PqbValidation': pool.c.state['name']}
        config = {'state': 'ENABLED', 'status': 'VALID', 'tags': {'SourceCommit': 'source'}, 'computeResources': resources}
        queue = {'state': 'ENABLED', 'status': 'VALID', 'tags': {'SourceCommit': 'source'}, 'priority': 0,
                 'computeEnvironmentOrder': [{'order': 1, 'computeEnvironment': pool.plan['computeArn']}]}
        pool.pool = Mock(return_value=config); pool.queue = Mock(return_value=queue)
        pool.check_ready()
        queue['computeEnvironmentOrder'].append({'order': 2, 'computeEnvironment': 'production'})
        with self.assertRaisesRegex(RuntimeError, 'queue binding changed'): pool.check_ready()
        pool.c.mutate.assert_not_called()

    def test_unowned_capacity_is_never_used_or_deleted(self):
        pool = self.object()
        with self.assertRaisesRegex(RuntimeError, 'unowned'):
            pool.owned({'tags': {'Project': 'qsb-gpu', 'PqbValidation': 'another-campaign'}})
        pool.c.mutate.assert_not_called()

    def test_cleanup_requires_sealed_collection_and_reconciled_queue_inventory(self):
        pool = self.object(); pool.c.checked_final_collection.side_effect = RuntimeError('missing archive')
        with self.assertRaisesRegex(RuntimeError, 'missing archive'): pool.remove()
        pool.c.mutate.assert_not_called()
        pool.c.checked_final_collection.side_effect = None; pool.production_unchanged = Mock(); pool.queue = Mock(return_value={'owned': True})
        with TemporaryDirectory() as directory:
            pool.c.directory = Path(directory)
            for status in ['RUNNING', 'SUCCEEDED']:
                pool.queue_jobs = Mock(return_value=[{'jobId': 'unrecorded', 'status': status}])
                with patch('capacity.clean_source', return_value='source'):
                    with self.assertRaisesRegex(RuntimeError, 'work changed or remains active'): pool.remove()
        pool.c.mutate.assert_not_called()

    def test_partial_invalid_pool_cleanup_never_changes_production_queue(self):
        pool = self.object(); pool.production_unchanged = Mock(); pool.queue = Mock(return_value=None)
        pool.pool = Mock(side_effect=[{'state': 'DISABLED', 'status': 'INVALID'}, {'state': 'DISABLED', 'status': 'INVALID'}, None])
        pool.wait = Mock(side_effect=lambda read, predicate, message: read()); pool.verify_removed = Mock()
        with TemporaryDirectory() as directory:
            pool.c.directory = Path(directory); (pool.c.directory / 'capacity').mkdir()
            snapshot = pool.c.directory / 'capacity/fresh.json'; snapshot.write_text('{}')
            pool.collect = Mock(return_value=snapshot); pool.c.state['finalCollection'] = {'file': 'final-collection-1.json', 'sha256': 'sealed'}
            with patch('capacity.clean_source', return_value='source'): pool.remove()
            self.assertEqual([call.args[0] for call in pool.c.mutate.call_args_list], ['capacity-disable', 'capacity-delete'])
            self.assertEqual(len(list((pool.c.directory / 'capacity').glob('pool-removal-seal-*.json'))), 1)
        pool.batch.update_job_queue.assert_not_called()

    def test_known_asynchronous_deletions_are_reconciled_without_recreating_resources(self):
        pool = self.object(); pool.production_unchanged = Mock(); pool.queue = Mock(return_value=None)
        pool.pool = Mock(return_value=None); pool.wait = Mock(); pool.verify_removed = Mock()
        pool.c.state['preflightExecution'] = 'completed-execution'
        with TemporaryDirectory() as directory:
            pool.c.directory = Path(directory); requests = pool.c.directory / 'requests'; requests.mkdir()
            for name in ['capacity-delete-queue', 'capacity-delete']:
                (requests / (name + '.intent.json')).write_text('{}')
            with patch('capacity.clean_source', return_value='source'): pool.remove()
        self.assertEqual([c.args[0] for c in pool.c.mutate.call_args_list], ['capacity-delete-queue', 'capacity-delete'])
        pool.queue_jobs = Mock()
        pool.batch.create_job_queue.assert_not_called()

    def test_remaining_scaling_group_hosts_or_volumes_block_cleanup_credit(self):
        pool = self.object(); pool.production_unchanged = Mock(); pool.pool = Mock(return_value=None); pool.queue = Mock(return_value=None)
        pool.scaling_groups = Mock(return_value=[{'present': True}])
        exceptions = SimpleNamespace(ClientError=type('ClientError', (Exception,), {}))
        with patch.dict('sys.modules', {'botocore.exceptions': exceptions}):
            with self.assertRaisesRegex(RuntimeError, 'capacity remains'): pool.verify_removed()
            pool.scaling_groups.return_value = []; pool.c.state['capacity']['instanceIds'] = ['i-owned']
            pool.c.client.return_value.describe_instances.return_value = {'Reservations': []}
            with self.assertRaisesRegex(RuntimeError, 'inventory incomplete'): pool.verify_removed()
            pool.c.client.return_value.describe_instances.return_value = {'Reservations': [{'Instances': [{'InstanceId': 'i-owned', 'State': {'Name': 'running'}}]}]}
            with self.assertRaisesRegex(RuntimeError, 'not terminated'): pool.verify_removed()
            pool.c.client.return_value.describe_instances.return_value = {'Reservations': [{'Instances': [{'InstanceId': 'i-owned', 'State': {'Name': 'terminated'}}]}]}
            pool.c.state['capacity']['volumeIds'] = ['vol-retained']
            with self.assertRaisesRegex(RuntimeError, 'volume remains'): pool.verify_removed()


if __name__ == '__main__': unittest.main()
