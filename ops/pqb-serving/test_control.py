"""One-shot request journal checks; no credentials or AWS calls."""
import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('control', Path(__file__).with_name('control.py'))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class JournalTests(unittest.TestCase):
    def campaign(self, directory, client):
        c = object.__new__(control.Campaign)
        c.directory = Path(directory).resolve()
        c.client = Mock(return_value=client)
        return c

    def test_full_function_configuration_is_bound(self):
        import copy
        expected = {'FunctionName': 'public-validation', 'CodeSha256': 'sha', 'Role': 'scoped', 'Runtime': 'nodejs22.x',
            'Architectures': ['arm64'], 'Handler': 'index.handler', 'Timeout': 90, 'MemorySize': 512,
            'Environment': {'Variables': {'SETTINGS': '{"deadline":100,"tables":["ours"]}'}}}
        control.Campaign.check_function(copy.deepcopy(expected), expected)
        changed = copy.deepcopy(expected)
        changed['Environment']['Variables']['SETTINGS'] = '{"deadline":100,"tables":["wrong"]}'
        with self.assertRaisesRegex(RuntimeError, 'environment changed'):
            control.Campaign.check_function(changed, expected)
        for field in ['Layers', 'VpcConfig', 'FileSystemConfigs']:
            changed = copy.deepcopy(expected); changed[field] = [{'Arn': 'unexpected'}] if field != 'VpcConfig' else {'SubnetIds': ['unexpected']}
            with self.assertRaisesRegex(RuntimeError, 'runtime configuration changed'):
                control.Campaign.check_function(changed, expected)
        for field in ['Role', 'Runtime', 'Architectures', 'Handler', 'Timeout', 'MemorySize']:
            changed = copy.deepcopy(expected); changed[field] = 'wrong'
            with self.assertRaisesRegex(RuntimeError, 'identity changed'):
                control.Campaign.check_function(changed, expected)

    def test_workflow_definition_role_and_logging_are_bound(self):
        import copy
        expected = {'type': 'STANDARD', 'roleArn': 'scoped', 'definition': '{"StartAt":"Expected"}',
            'loggingConfiguration': {'level': 'ALL', 'includeExecutionData': True}}
        actual = dict(expected, status='ACTIVE')
        control.Campaign.check_workflow(actual, expected)
        for field, value in [('definition', '{"StartAt":"Wrong"}'), ('roleArn', 'wrong'),
                             ('type', 'EXPRESS'), ('loggingConfiguration', {'level': 'OFF'})]:
            changed = copy.deepcopy(actual); changed[field] = value
            with self.assertRaises(RuntimeError):
                control.Campaign.check_workflow(changed, expected)

    def test_removal_refuses_missing_or_modified_collection(self):
        import hashlib
        with TemporaryDirectory() as directory:
            c = object.__new__(control.Campaign); c.directory = Path(directory).resolve()
            c.state = {'name': 'test', 'sourceCommit': 'source'}
            c.client = Mock()
            with self.assertRaisesRegex(RuntimeError, 'Require final_collect'):
                c.remove()
            c.client.assert_not_called()
            original = c.directory / 'original.json'; original.write_text('original')
            resources = c.directory / 'resources.json'; resources.write_text('{}')
            receipt = {'name': 'test', 'sourceCommit': 'source', 'resources': 'resources.json',
                'files': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [original, resources]}}
            path = c.directory / 'final-collection-1.json'; control.persist(path, receipt, exclusive=True)
            c.state['finalCollection'] = {'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            c.checked_final_collection()
            original.write_text('changed')
            with self.assertRaisesRegex(RuntimeError, 'collection bytes changed'):
                c.checked_final_collection()

    def test_observed_unexpected_failure_pauses_before_continuing(self):
        import json
        from types import SimpleNamespace
        from unittest.mock import patch
        with TemporaryDirectory() as directory:
            c = object.__new__(control.Campaign); c.directory = Path(directory).resolve()
            c.state = {'phase': 'solve-running', 'tables': ['one', 'two']}
            c.save = Mock(); c.stop = Mock(); c.collect_artifacts = Mock()
            c.native_jobs = Mock(return_value=[{'jobId': 'failed', 'status': 'FAILED', 'statusReason': 'Essential container in task exited'}])
            ddb = Mock(); ddb.get_item.return_value = {'Item': {'job': {'status': 'searching', 'stage': 'pinning', 'gpuSubmissions': 1}}}
            c.client = Mock(return_value=ddb)
            (c.directory / 'public-fixture.json').write_text(json.dumps({'rows': [{}, {'pk': 'OWNER#public', 'sk': 'JOB#public'}]}))
            decoder = Mock(); decoder.deserialize.side_effect = lambda v: v
            with patch.dict('sys.modules', {'boto3.dynamodb.types': SimpleNamespace(TypeDeserializer=lambda: decoder)}):
                with self.assertRaisesRegex(RuntimeError, 'Unexpected native failure observed'):
                    c.collect()
            c.stop.assert_called_once()
            c.collect_artifacts.assert_called_once()

    def test_workflow_failure_stops_even_when_native_jobs_look_healthy(self):
        import json
        from types import SimpleNamespace
        from unittest.mock import patch
        with TemporaryDirectory() as directory:
            c = object.__new__(control.Campaign); c.directory = Path(directory).resolve()
            c.state = {'phase': 'solve-running', 'tables': ['one', 'two'], 'workflow': 'test'}
            c.save = Mock(); c.stop = Mock(); c.collect_artifacts = Mock(); c.arn = Mock(return_value='workflow')
            c.native_jobs = Mock(return_value=[{'jobId': 'active', 'status': 'RUNNING'}])
            ddb = Mock(); ddb.get_item.return_value = {'Item': {'job': {'status': 'searching', 'stage': 'pinning', 'gpuSubmissions': 1}}}
            sfn = Mock(); sfn.get_paginator.return_value.paginate.return_value = [{'executions': [{'status': 'FAILED'}]}]
            c.client = Mock(side_effect=lambda name: ddb if name == 'dynamodb' else sfn)
            (c.directory / 'public-fixture.json').write_text(json.dumps({'rows': [{}, {'pk': 'OWNER#public', 'sk': 'JOB#public'}]}))
            decoder = Mock(); decoder.deserialize.side_effect = lambda v: v
            with patch.dict('sys.modules', {'boto3.dynamodb.types': SimpleNamespace(TypeDeserializer=lambda: decoder)}):
                with self.assertRaisesRegex(RuntimeError, 'Coordinator halted unexpectedly'):
                    c.collect()
            c.stop.assert_called_once()

    def test_unknown_response_is_never_replayed(self):
        with TemporaryDirectory() as d:
            client = Mock()
            client.create.side_effect = TimeoutError('response lost')
            c = self.campaign(d, client)
            with self.assertRaises(TimeoutError):
                c.mutate('one', 'service', 'create', Name='public')
            with self.assertRaisesRegex(RuntimeError, 'Prior failure'):
                c.mutate('one', 'service', 'create', Name='public')
            client.create.assert_called_once()

    def test_crash_after_intent_prevents_dispatch(self):
        with TemporaryDirectory() as d:
            client = Mock(); c = self.campaign(d, client)
            (Path(d) / 'requests').mkdir()
            control.persist(Path(d) / 'requests/one.intent.json', {'service': 'service', 'operation': 'create', 'params': {'Name': 'public'}}, exclusive=True)
            with self.assertRaisesRegex(RuntimeError, 'Uncertain'):
                c.mutate('one', 'service', 'create', Name='public')
            client.create.assert_not_called()

    def test_cached_response_is_bound_to_unchanged_request(self):
        with TemporaryDirectory() as d:
            client = Mock(); client.create.return_value = {'identity': 'one'}
            c = self.campaign(d, client)
            self.assertEqual(c.mutate('one', 'service', 'create', Code=b'public'), {'identity': 'one'})
            self.assertEqual(c.mutate('one', 'service', 'create', Code=b'public'), {'identity': 'one'})
            with self.assertRaisesRegex(RuntimeError, 'changed request'):
                c.mutate('one', 'service', 'create', Code=b'changed')
            client.create.assert_called_once()

    def test_explicit_sdk_callback_retains_no_replay_guarantee(self):
        with TemporaryDirectory() as directory:
            client = Mock(); c = self.campaign(directory, client)
            sdk = Mock(return_value={'created': 'owned'})
            self.assertEqual(c.mutate('pool', 'batch', 'create_compute_environment', invoke=sdk, Name='owned'), {'created': 'owned'})
            c.mutate('pool', 'batch', 'create_compute_environment', invoke=sdk, Name='owned')
            sdk.assert_called_once()
            with self.assertRaisesRegex(RuntimeError, 'changed request'):
                c.mutate('pool', 'batch', 'create_compute_environment', invoke=sdk, Name='another')
            client.create_compute_environment.assert_not_called()

    def test_deleted_queue_inventory_uses_retained_job_ids(self):
        c = object.__new__(control.Campaign)
        c.state = {'definition': 'owned:3', 'queue': 'isolated', 'knownJobIds': ['job'], 'capacity': {'queueRemoved': True}}
        batch = Mock(); c.client = Mock(return_value=batch)
        batch.describe_jobs.return_value = {'jobs': [{'jobId': 'job', 'jobDefinition': 'owned:3', 'jobQueue': 'isolated', 'status': 'SUCCEEDED'}]}
        self.assertEqual(c.native_jobs()[0]['jobId'], 'job')
        batch.get_paginator.assert_not_called()
        batch.describe_jobs.return_value = {'jobs': []}
        with self.assertRaisesRegex(RuntimeError, 'incomplete or changed'): c.native_jobs()

    def test_partial_cleanup_verifies_role_absence_with_metadata_role(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        class ClientError(Exception):
            def __init__(self, code):
                self.response = {'Error': {'Code': code}}
        operator, metadata = Mock(), Mock()
        operator.get_role.side_effect = ClientError('AccessDenied')
        metadata.get_role.side_effect = ClientError('NoSuchEntity')
        c = self.campaign('.', operator); c.sdk_config = object()
        capacity_factory = Mock(return_value=Mock(metadata_session=Mock(return_value=Mock(client=Mock(return_value=metadata)))))
        with patch.dict('sys.modules', {'botocore.exceptions': SimpleNamespace(ClientError=ClientError),
                                      'capacity': SimpleNamespace(Capacity=capacity_factory)}):
            for name in ['never-created-one', 'never-created-two']:
                self.assertIsNone(c.optional_cleanup_resource('iam', 'get_role', RoleName=name))
            capacity_factory.assert_called_once_with(c)
            self.assertEqual(metadata.get_role.call_count, 2)
            metadata.get_role.side_effect = ClientError('AccessDenied')
            with self.assertRaises(ClientError):
                c.optional_cleanup_resource('iam', 'get_role', RoleName='not-proven-absent')
            operator.describe_table.side_effect = ClientError('AccessDenied')
            with self.assertRaises(ClientError):
                c.optional_cleanup_resource('dynamodb', 'describe_table', TableName='not-proven-absent')


if __name__ == '__main__':
    unittest.main()
