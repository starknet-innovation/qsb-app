"""Funds-safety checks for the deadline guard; no AWS calls."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('deadline', Path(__file__).with_name('deadline.py'))
deadline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deadline)


class DeadlineTests(unittest.TestCase):
    def setUp(self):
        class ClientError(Exception):
            pass
        self.sdk = patch.dict('sys.modules', {'botocore.exceptions': SimpleNamespace(ClientError=ClientError)})
        self.sdk.start()
        self.addCleanup(self.sdk.stop)

    def test_only_the_exact_campaign_revision_is_terminated(self):
        batch, ddb = Mock(), Mock()
        batch.get_paginator.return_value.paginate.return_value = [
            {'jobSummaryList': [{'jobId': 'ours'}, {'jobId': 'unrelated'}]}]
        batch.describe_jobs.return_value = {'jobs': [
            {'jobId': 'ours', 'jobDefinition': 'campaign:3', 'tags': {'Project': 'qsb-gpu'}},
            {'jobId': 'unrelated', 'jobDefinition': 'production:2', 'tags': {'Project': 'qsb-gpu'}}]}
        settings = {'tables': ['isolated-preflight', 'isolated-solve'], 'pk': 'OWNER#public',
                    'sk': 'JOB#public', 'queue': 'shared', 'definition': 'campaign:3'}
        deadline.stop({'batch': batch, 'dynamodb': ddb}, settings)
        self.assertEqual(ddb.update_item.call_count, 2)
        self.assertTrue(all(c.kwargs['jobId'] == 'ours' for c in batch.terminate_job.call_args_list))
        self.assertEqual(batch.update_job_queue.call_count, 0)
        self.assertEqual(batch.update_compute_environment.call_count, 0)
        for call in ddb.update_item.call_args_list:
            self.assertIn('ADD #v :one', call.kwargs['UpdateExpression'])
            self.assertIn('attribute_exists(pk)', call.kwargs['ConditionExpression'])

    def test_unexpected_tag_fails_closed(self):
        batch, ddb = Mock(), Mock()
        batch.get_paginator.return_value.paginate.return_value = [{'jobSummaryList': [{'jobId': 'bad'}]}]
        batch.describe_jobs.return_value = {'jobs': [{'jobId': 'bad', 'jobDefinition': 'campaign:3', 'tags': {}}]}
        with self.assertRaisesRegex(RuntimeError, 'unexpected job tag'):
            deadline.stop({'batch': batch, 'dynamodb': ddb}, {'tables': [], 'queue': 'shared', 'definition': 'campaign:3'})
        batch.terminate_job.assert_not_called()

    def test_drain_reconciles_a_late_accepted_submission(self):
        results = [{'activeJobs': []}, {'activeJobs': ['late-paid-job']}, {'activeJobs': []}]
        with patch.object(deadline, 'stop', side_effect=results) as stop, patch.object(deadline.time, 'monotonic', side_effect=[0, 0, 5, 96]), patch.object(deadline.time, 'sleep'):
            result = deadline.drain({}, {})
        self.assertEqual(stop.call_count, 3)
        self.assertTrue(result['terminalWorkVerified'])
        self.assertEqual(result['activeJobs'], [])

    def test_drain_never_reports_completion_without_time_to_reconcile(self):
        with self.assertRaisesRegex(RuntimeError, 'Drain incomplete'):
            deadline.drain({}, {}, remaining=lambda: 0)

    def test_no_early_deadline_work(self):
        from unittest.mock import patch
        import json
        with patch.dict('os.environ', {'SETTINGS': json.dumps({'deadline': 1000})}), patch('time.time', return_value=999):
            self.assertEqual(deadline.handler({}, None), {'beforeDeadline': True})

    def test_age_watchdog_counts_only_owned_jobs_and_rejects_missing_timestamps(self):
        batch = Mock()
        batch.get_paginator.return_value.paginate.side_effect = lambda **kw: [{'jobSummaryList': [{'jobId': 'one'}]}] if kw['jobStatus'] == 'RUNNING' else []
        batch.describe_jobs.return_value = {'jobs': [
            {'jobId': 'old', 'jobDefinition': 'ours', 'createdAt': 100000},
            {'jobId': 'recent', 'jobDefinition': 'ours', 'createdAt': 1500000},
            {'jobId': 'unrelated', 'jobDefinition': 'other', 'createdAt': 100000},
            {'jobId': 'unknown-age', 'jobDefinition': 'ours'}]}
        result = deadline.expired_jobs(batch, {'queue': 'isolated', 'definition': 'ours', 'watchdogMaxAgeSeconds': 1800}, 2000)
        self.assertEqual(result, ['old', 'unknown-age'])
        batch.terminate_job.assert_not_called()

    def test_periodic_watchdog_keeps_the_fixed_deadline_unconditional(self):
        import json
        settings = {'deadline': 1000, 'watchdogMaxAgeSeconds': 1800}
        modules = {'boto3': SimpleNamespace(client=lambda *a, **kw: Mock()),
                   'botocore.config': SimpleNamespace(Config=lambda **kw: kw)}
        for now, expired, drains in [(999, [], False), (999, ['old'], True), (1000, [], True)]:
            with self.subTest(now=now, expired=expired), patch.dict('sys.modules', modules), patch.dict('os.environ', {'SETTINGS': json.dumps(settings)}), patch('time.time', return_value=now), patch.object(deadline, 'expired_jobs', return_value=expired), patch.object(deadline, 'drain', return_value={'drained': True}) as drain:
                deadline.handler({}, Mock())
                self.assertEqual(drain.called, drains)


if __name__ == '__main__':
    unittest.main()
