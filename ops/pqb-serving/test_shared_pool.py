"""Maintenance guard/rollback tests. No AWS calls or credentials."""
import copy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from shared_pool import SharedPool, creation, queue_creation, validate_plan, ready, PROFILE
from control import Campaign


CONFIG = {'profile': 'qsb-operator-euw2', 'account': '237145860001', 'region': 'eu-west-2'}
ARN = 'arn:aws:batch:eu-west-2:237145860001:'


def plan():
    pool = {'computeEnvironmentName': 'qsb-gpu', 'computeEnvironmentArn': ARN + 'compute-environment/qsb-gpu',
            'type': 'MANAGED', 'state': 'ENABLED', 'status': 'VALID', 'containerOrchestrationType': 'ECS',
            'serviceRole': 'arn:aws:iam::237145860001:role/aws-service-role/batch.amazonaws.com/AWSServiceRoleForBatch',
            'tags': {'Project': 'qsb-gpu'}, 'computeResources': {'type': 'EC2', 'allocationStrategy': 'BEST_FIT',
            'instanceTypes': ['g5.xlarge'], 'minvCpus': 0, 'desiredvCpus': 0, 'maxvCpus': 64,
            'subnets': ['subnet-0b9dbd06af28524de', 'subnet-0a4b5fdacb09d88ab'], 'securityGroupIds': ['existing'],
            'launchTemplate': {'launchTemplateId': 'original', 'version': '1'}, 'instanceRole': 'original-role'}}
    queue = {'jobQueueArn': ARN + 'job-queue/qsb-gpu', 'jobQueueName': 'qsb-gpu', 'priority': 1, 'state': 'ENABLED', 'status': 'VALID',
             'tags': {'Project': 'qsb-gpu'}, 'computeEnvironmentOrder': [{'order': 1, 'computeEnvironment': pool['computeEnvironmentArn']}]}
    candidate = creation(pool)
    candidate['computeResources'].update(allocationStrategy=PROFILE['allocationStrategy'], instanceTypes=[PROFILE['instanceType']])
    return {'baselinePool': pool, 'baselineQueue': queue, 'queueRestore': queue_creation(queue), 'restore': creation(pool), 'candidate': candidate, 'sourceCommit': 'source', 'createdAt': 1}


class MaintenanceTests(unittest.TestCase):
    def test_only_reviewed_type_strategy_change_and_exact_rollback(self):
        p = plan(); validate_plan(p, CONFIG)
        for section, field, changed in [('candidate', 'subnets', ['new-subnet']), ('candidate', 'maxvCpus', 128),
                                        ('restore', 'instanceTypes', ['g5.2xlarge']), ('candidate', 'instanceRole', 'new-role'),
                                        ('candidate', 'desiredvCpus', 1)]:
            bad = copy.deepcopy(p); bad[section]['computeResources'][field] = changed
            with self.assertRaises(RuntimeError): validate_plan(bad, CONFIG)
        with self.assertRaises(RuntimeError): validate_plan(p, dict(CONFIG, account='other'))

    def test_running_work_or_hosts_prevent_maintenance(self):
        with TemporaryDirectory() as directory:
            s = object.__new__(SharedPool); s.plan = plan()
            s.queue = Mock(return_value=s.plan['baselineQueue'])
            s.c = Mock(directory=Path(directory)); s.batch = Mock(); s.asg = Mock()
            s.batch.get_paginator.return_value.paginate.return_value = [{'jobSummaryList': []}]
            s.asg.get_paginator.return_value.paginate.return_value = [{'AutoScalingGroups': []}]
            api, sfn, ec2 = Mock(), Mock(), Mock()
            api.get_function_configuration.return_value = {'Environment': {'Variables': {'WORKFLOW_ARN': 'production'}}}
            sfn.get_paginator.return_value.paginate.return_value = [{'executions': []}]
            ec2.describe_instances.return_value = {'Reservations': []}
            s.c.client.side_effect = lambda name: {'lambda': api, 'stepfunctions': sfn, 'ec2': ec2}[name]
            s.idle()
            s.batch.get_paginator.return_value.paginate.return_value = [{'jobSummaryList': [{'jobId': 'real-work'}]}]
            with self.assertRaisesRegex(RuntimeError, 'not idle'): s.idle()
            s.batch.get_paginator.return_value.paginate.return_value = [{'jobSummaryList': []}]
            ec2.describe_instances.return_value = {'Reservations': [{'Instances': [{'InstanceId': 'shared-host'}]}]}
            with self.assertRaisesRegex(RuntimeError, 'not idle'): s.idle()
            ec2.describe_instances.return_value = {'Reservations': []}
            s.asg.get_paginator.return_value.paginate.return_value = [{'AutoScalingGroups': [{
                'AutoScalingGroupName': 'AWSBatch-qsb-gpu-asg-original', 'DesiredCapacity': 1, 'MinSize': 0, 'Instances': []}]}]
            with self.assertRaisesRegex(RuntimeError, 'not idle'): s.idle()
            s.c.mutate.assert_not_called()

    def test_candidate_and_restore_use_ordered_journaled_transitions(self):
        for initial in ['original', 'candidate', 'missing', 'disabled-original', 'invalid-candidate']:
            restoring = initial != 'original'
            with self.subTest(initial=initial), TemporaryDirectory() as directory:
                s = object.__new__(SharedPool); s.plan = plan(); s.path = Path(directory) / 'plan.json'
                s.path.write_text(json.dumps(s.plan)); s.c = Mock(directory=Path(directory)); s.status = Mock(); s.idle = Mock()
                q = copy.deepcopy(s.plan['baselineQueue'])
                state = {'pool': copy.deepcopy(s.plan['baselinePool']), 'queue': q}
                if restoring:
                    state['pool']['computeResources'] = copy.deepcopy(s.plan['candidate']['computeResources'])
                    journal = Path(directory) / 'requests'; journal.mkdir()
                    (journal / 'candidate-queue-disable.intent.json').write_text('{}')
                    (journal / 'candidate-queue-disable.response.json').write_text('{"result":{}}')
                if initial == 'missing': state['pool'] = None; state['queue'] = None
                if initial == 'disabled-original': state['pool'] = copy.deepcopy(s.plan['baselinePool']); state['pool']['state'] = 'DISABLED'; q['state'] = 'DISABLED'
                if initial == 'invalid-candidate': state['pool']['status'] = 'INVALID'; state['pool']['state'] = 'DISABLED'; q['state'] = 'DISABLED'
                s.pool = lambda: state['pool']; s.queue = lambda: state['queue']
                operations = []
                def mutate(key, service, operation, **args):
                    operations.append(operation)
                    if operation == 'update_job_queue':
                        state['queue'].update({k: v for k, v in args.items() if k != 'jobQueue'})
                    elif operation == 'delete_job_queue': state['queue'] = None
                    elif operation == 'create_job_queue':
                        state['queue'] = dict(copy.deepcopy(s.plan['baselineQueue']), **args)
                    elif operation == 'update_compute_environment': state['pool']['state'] = args['state']
                    elif operation == 'delete_compute_environment': state['pool'] = None
                    elif operation == 'create_compute_environment':
                        state['pool'] = copy.deepcopy(args); state['pool']['status'] = 'VALID'
                    else: raise AssertionError(operation)
                    return {}
                s.c.mutate.side_effect = mutate
                with patch('shared_pool.clean_source', return_value='source'), patch('shared_pool.time.time', return_value=2):
                    if initial == 'candidate':
                        s.idle.side_effect = RuntimeError('still draining')
                        with self.assertRaisesRegex(RuntimeError, 'still draining'): s.replace(restore=True)
                        self.assertFalse((Path(directory) / 'restore-from.json').exists())
                        s.c.mutate.assert_not_called()
                        s.idle.side_effect = None
                    s.replace(restore=restoring)
                middle = [] if initial == 'disabled-original' else ['create_compute_environment'] if initial == 'missing' else [
                    'update_compute_environment', 'delete_compute_environment', 'create_compute_environment']
                prefix = [] if initial == 'missing' else ['update_job_queue', 'delete_job_queue']
                self.assertEqual(operations, [*prefix, *middle,
                    'create_job_queue', 'update_compute_environment', 'update_job_queue'])
                self.assertEqual(creation(state['pool']), s.plan['restore' if restoring else 'candidate'])
                self.assertEqual(state['queue'], s.plan['baselineQueue'])

    def test_final_readiness_requires_live_enabled_valid_attached_topology(self):
        p = plan(); pool, queue = p['baselinePool'], p['baselineQueue']
        self.assertTrue(ready(pool, queue, p['restore'], queue))
        for field, value in [('state', 'DISABLED'), ('status', 'INVALID')]:
            bad = copy.deepcopy(pool); bad[field] = value
            self.assertFalse(ready(bad, queue, p['restore'], queue))
            badq = copy.deepcopy(queue); badq[field] = value
            self.assertFalse(ready(pool, badq, p['restore'], queue))
        badq = copy.deepcopy(queue); badq['computeEnvironmentOrder'] = []
        self.assertFalse(ready(pool, badq, p['restore'], queue))

    def test_lost_delete_response_never_replays(self):
        with TemporaryDirectory() as directory:
            c = object.__new__(Campaign); c.directory = Path(directory); c.client = Mock()
            c.client.return_value.delete_compute_environment.side_effect = TimeoutError('unknown outcome')
            with self.assertRaises(TimeoutError): c.mutate('delete', 'batch', 'delete_compute_environment', computeEnvironment='qsb-gpu')
            with self.assertRaisesRegex(RuntimeError, 'Prior failure'): c.mutate('delete', 'batch', 'delete_compute_environment', computeEnvironment='qsb-gpu')
            c.client.return_value.delete_compute_environment.assert_called_once()


if __name__ == '__main__':
    unittest.main()
