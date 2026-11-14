"""Retained revision preflight ownership; no credentials or cloud calls."""
import copy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch
from control import Campaign
from deadline import owns_job, stop, expired_jobs
from monitor import Monitor


class RetainedTests(unittest.TestCase):
    def job(self, digest='a' * 64):
        return {'jobId': 'own', 'jobDefinition': 'permanent:12', 'jobQueue': 'shared',
            'tags': {'Project': 'qsb-gpu', 'InputSha256': digest},
            'container': {'environment': [{'name': 'QSB_INPUT_SHA256', 'value': digest}]}}

    def settings(self):
        return {'queue': 'shared', 'definition': 'permanent:12', 'inputSha256': 'a' * 64}

    def test_same_revision_foreign_input_never_owned(self):
        self.assertTrue(owns_job(self.job(), self.settings()))
        for change in ['input', 'queue', 'tag', 'duplicate']:
            job = self.job()
            if change == 'input': job = self.job('b' * 64)
            if change == 'queue': job['jobQueue'] = 'other'
            if change == 'tag': job['tags']['InputSha256'] = 'b' * 64
            if change == 'duplicate': job['container']['environment'] *= 2
            self.assertFalse(owns_job(job, self.settings()))

    def test_stop_and_age_guard_exclude_foreign_job_on_same_revision(self):
        batch = Mock(); batch.get_paginator.return_value.paginate.side_effect = lambda **kw: [{'jobSummaryList': [{'jobId': 'own'}, {'jobId': 'foreign'}]}] if kw['jobStatus'] == 'RUNNING' else []
        batch.describe_jobs.return_value = {'jobs': [self.job(), dict(self.job('b' * 64), jobId='foreign')]}
        settings = dict(self.settings(), tables=[], watchdogMaxAgeSeconds=1800)
        stop({'batch': batch}, settings)
        batch.terminate_job.assert_called_once_with(jobId='own', reason='Fixed public validation deadline reached')
        self.assertEqual(expired_jobs(batch, settings, 2000), ['own'])

    def test_monitor_yields_and_collector_does_not_read_foreign_payload(self):
        own, foreign = self.job(), dict(self.job('b' * 64), jobId='foreign')
        monitor = object.__new__(Monitor); monitor.state = dict(self.settings(), retainedDefinition={'bound': True}); monitor.read = Mock()
        with patch('monitor.active_inventory', return_value=[foreign]):
            with self.assertRaisesRegex(RuntimeError, 'Unrelated'): monitor.guard()
        c = object.__new__(Campaign); c.state = monitor.state; c.client = Mock(); batch = c.client.return_value
        batch.get_paginator.return_value.paginate.return_value = [{'jobSummaryList': [{'jobId': 'own'}, {'jobId': 'foreign'}]}]
        batch.describe_jobs.return_value = {'jobs': [own, foreign]}
        self.assertEqual(c.native_jobs(), [own])

    def test_orphan_collection_lists_only_durable_public_keys(self):
        from boto3.dynamodb.types import TypeSerializer
        c = object.__new__(Campaign); c.state = dict(self.settings(), tables=['public-table'], retainedDefinition={'bound': True})
        c.client = Mock(); s3 = Mock()
        record = dict(self.settings(), inputKey='inputs/' + '0' * 36 + '.json', jobName='public')
        job = {'parallelSlots': [{'batchSubmission': record}]}
        c.client.return_value.get_item.return_value = {'Item': {'job': TypeSerializer().serialize(job)}}
        keys = c.orphan_inputs(s3, {'rows': [{}, {'pk': 'public', 'sk': 'job'}]}, False)
        self.assertEqual(keys, [{'Key': record['inputKey']}])
        s3.get_paginator.assert_not_called(); s3.get_object.assert_not_called()
        job['parallelSlots'][0]['batchSubmission']['inputSha256'] = 'b' * 64
        c.client.return_value.get_item.return_value = {'Item': {'job': TypeSerializer().serialize(job)}}
        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
            c.orphan_inputs(s3, {'rows': [{}, {'pk': 'public', 'sk': 'job'}]}, False)
        s3.get_object.assert_not_called()

    def test_candidate_requires_active_permanent_image_only_change(self):
        descriptor = {'image': 'ghcr.io/a@sha256:new'}
        baseline = {'jobDefinitionArn': 'old', 'jobDefinitionName': 'qsb-gpu-solver', 'status': 'ACTIVE', 'revision': 2,
            'tags': {'Project': 'qsb-gpu'}, 'containerProperties': {'image': 'ecr/a@sha256:old', 'readonlyRootFilesystem': True, 'mountPoints': []}}
        candidate = copy.deepcopy(baseline); candidate.update(revision=12, jobDefinitionArn='new'); candidate['containerProperties']['image'] = 'ecr/a@sha256:new'; candidate['containerProperties'].pop('mountPoints')
        Campaign.check_retained_definition(candidate, baseline, descriptor)
        for change in ['inactive', 'temporary', 'image', 'isolation', 'extra']:
            bad = copy.deepcopy(candidate)
            if change == 'inactive': bad['status'] = 'INACTIVE'
            if change == 'temporary': bad['tags']['PqbValidation'] = 'campaign'
            if change == 'image': bad['containerProperties']['image'] = 'ecr/a@sha256:other'
            if change == 'isolation': bad['containerProperties']['readonlyRootFilesystem'] = False
            if change == 'extra': bad['newRuntimeProperty'] = True
            with self.assertRaises(RuntimeError): Campaign.check_retained_definition(bad, baseline, descriptor)

    def test_retained_mode_forbids_solve_before_any_mutation(self):
        c = object.__new__(Campaign); c.state = {'retainedDefinition': {'bound': True}}; c.before_deadline = Mock(); c.client = Mock()
        with self.assertRaisesRegex(RuntimeError, 'one preflight'): c.start('solve')
        c.before_deadline.assert_not_called(); c.client.assert_not_called()

    def test_local_and_deployed_stop_settings_share_input_scope(self):
        with TemporaryDirectory() as temp:
            c = object.__new__(Campaign); c.directory = Path(temp); c.state = dict(self.settings(), tables=['a', 'b'], retainedDefinition={'bound': True})
            (c.directory / 'public-fixture.json').write_text(json.dumps({'rows': [{}, {'pk': 'public', 'sk': 'job'}]}))
            self.assertEqual(c.stop_settings()['inputSha256'], 'a' * 64)


if __name__ == '__main__': unittest.main()
