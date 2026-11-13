"""Isolated capacity safeguards: no credentials, cloud calls or paid work."""
import copy
import hashlib
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
        updated.update(allocationStrategy='BEST_FIT_PROGRESSIVE', instanceTypes=[capacity.PROFILE['instanceType']])
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

    def test_queue_creation_requires_permission_on_both_related_resources(self):
        c, plan = self.fixture(); policy = plan['operatorPolicy']
        for statement in policy['Statement']:
            self.assertIn('batch:CreateJobQueue', statement['Action'])
        for index in [0, 1]:
            changed = copy.deepcopy(policy)
            changed['Statement'][index]['Action'].remove('batch:CreateJobQueue')
            with self.assertRaisesRegex(RuntimeError, 'broader or differently scoped'):
                capacity.validate_operator_policy(changed, c)

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

    def test_validation_subnet_only_changes_the_isolated_subnet_list(self):
        from test_validation_network import fixture, read
        c, plan = self.fixture(); ec2, *_ = fixture()
        plan['computeBaseline']['computeResources']['subnets'] = ['subnet-base']
        plan['validationNetwork'] = read(ec2)
        plan['computeResources']['subnets'] = ['subnet-test']
        capacity.validate_plan(plan, c)
        for subnets in [['subnet-base'], ['subnet-test', 'subnet-base'], ['subnet-foreign']]:
            changed = copy.deepcopy(plan); changed['computeResources']['subnets'] = subnets
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

    def test_retained_history_is_separate_from_current_native_inventory(self):
        pool = self.object(); pool.c.state.update(sourceCommit='source', definition='current:1', knownJobIds=['new'])
        old = {'jobId': 'old', 'status': 'FAILED', 'jobDefinition': 'previous:1', 'jobQueue': pool.c.state['queue']}
        new = {'jobId': 'new', 'status': 'SUCCEEDED', 'jobDefinition': 'current:1', 'jobQueue': pool.c.state['queue']}
        pool.c.checked_final_collection.return_value = ({'files': {'capacity/prior-terminal-history.json': 'sealed'}}, {})
        with TemporaryDirectory() as directory:
            pool.c.directory = Path(directory); (pool.c.directory / 'capacity').mkdir()
            history = {'format': 'pqb-prior-terminal-history-v2', 'campaign': pool.c.state['name'],
                'sourceCommit': 'source', 'jobSha256': {'old': hashlib.sha256(capacity.dump(old).encode()).hexdigest()}}
            path = pool.c.directory / 'capacity/prior-terminal-history.json'; path.write_text(json.dumps(history))
            pool.verify_queue_inventory([old, new], terminal=True)
            self.assertEqual(pool.c.state['knownJobIds'], ['new'])
            for jobs in [[new], [old, old, new], [dict(old, status='RUNNING'), new],
                [dict(old, jobDefinition='changed:1'), new], [old, dict(new, jobId='unknown')],
                [old, dict(new, status='RUNNING')], [old, dict(new, jobDefinition='foreign:1')],
                [old, dict(new, jobQueue='foreign-queue')]]:
                with self.assertRaises(RuntimeError): pool.verify_queue_inventory(jobs, terminal=True)
            pool.verify_queue_inventory([old, dict(new, status='RUNNING')])
            pool.c.checked_final_collection.return_value = ({'files': {}}, {})
            with self.assertRaisesRegex(RuntimeError, 'not sealed'): pool.verify_queue_inventory([old, new], terminal=True)
            history['campaign'] = 'other'; path.write_text(json.dumps(history))
            with self.assertRaisesRegex(RuntimeError, 'binding changed'): pool.verify_queue_inventory([old, new])
        pool.c.mutate.assert_not_called()

    def test_unrecognized_history_blocks_deployment_and_cleanup(self):
        pool = self.object()
        with TemporaryDirectory() as directory:
            pool.c.directory = Path(directory)
            for terminal in [False, True]:
                with self.assertRaisesRegex(RuntimeError, 'work changed or remains active'):
                    pool.verify_queue_inventory([{'jobId': 'unknown', 'status': 'FAILED', 'jobDefinition': 'old:1'}], terminal)
            pool.verify_queue_inventory([])
        pool.c.mutate.assert_not_called()

    def test_history_reconciliation_requires_verified_prior_cleanup(self):
        pool = self.object(); pool.c.before_deadline = Mock(); pool.check_ready = Mock()
        pool.c.state.update(phase='prepared', createdAt=1000)
        previous = Mock(); previous.config = pool.c.config
        previous.state = {'name': 'qsb-pqb-v-fedcba543210', 'queue': pool.c.state['queue'],
            'reservationStatus': 'reserved', 'phase': 'removal-requested'}
        with patch('capacity.Campaign', return_value=previous):
            with self.assertRaisesRegex(RuntimeError, 'completed and cleaned'):
                pool.reconcile_history([Path('/previous')])
        previous.checked_final_collection.assert_not_called(); pool.c.mutate.assert_not_called()

    def test_history_reconciliation_binds_sealed_prior_jobs_to_fresh_provider_rows(self):
        pool = self.object(); pool.c.before_deadline = Mock(); pool.check_ready = Mock()
        pool.c.state.update(phase='prepared', createdAt=1000)
        with TemporaryDirectory() as directory:
            pool.c.directory = Path(directory) / 'current'; (pool.c.directory / 'capacity').mkdir(parents=True)
            previous = Mock(); previous.config = pool.c.config; previous.directory = Path(directory) / 'previous'; previous.directory.mkdir()
            job = {'jobId': 'prior', 'status': 'FAILED', 'jobDefinition': 'prior:1',
                'jobQueue': pool.c.state['queue'], 'createdAt': 900000}
            (previous.directory / 'native-index-1.json').write_text(json.dumps({'jobs': [job]}))
            cleanup = {'verified': True, 'campaign': 'qsb-pqb-v-fedcba543210', 'sourceCommit': 'previous-source',
                'checks': [{'passed': True}]}
            cleanup_path = previous.directory / 'independent-cleanup-1.json'; cleanup_path.write_text(json.dumps(cleanup))
            previous.state = {'name': cleanup['campaign'], 'sourceCommit': cleanup['sourceCommit'],
                'queue': pool.c.state['queue'], 'definition': 'prior:1', 'knownJobIds': ['prior'],
                'reservationStatus': 'released', 'phase': 'capacity-blocked-cleanup-verified',
                'finalCollection': {'file': 'sealed'}, 'independentCleanup': {'file': cleanup_path.name,
                    'sha256': hashlib.sha256(cleanup_path.read_bytes()).hexdigest()}}
            previous.checked_final_collection.return_value = ({'files': {'native-index-1.json': 'sealed'}, 'nativeJobIds': ['prior']}, {})
            pool.queue_jobs = Mock(return_value=[dict(job, status='RUNNING')])
            with patch('capacity.Campaign', return_value=previous):
                with self.assertRaisesRegex(RuntimeError, 'Live queue history differs'): pool.reconcile_history([previous.directory])
                pool.queue_jobs.return_value = [job]; pool.reconcile_history([previous.directory])
            history = json.loads((pool.c.directory / 'capacity/prior-terminal-history.json').read_text())
            self.assertEqual(history['jobSha256'], {'prior': hashlib.sha256(capacity.dump(job).encode()).hexdigest()})
            self.assertEqual(pool.c.state['knownJobIds'], [])
        pool.c.mutate.assert_not_called()


if __name__ == '__main__': unittest.main()
