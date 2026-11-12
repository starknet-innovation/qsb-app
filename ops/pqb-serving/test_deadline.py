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


if __name__ == '__main__':
    unittest.main()
