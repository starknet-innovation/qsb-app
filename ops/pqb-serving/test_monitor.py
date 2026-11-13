"""Metadata races, strict inventory and terminal retention; no AWS calls."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from monitor import Monitor, active_inventory, archive, watcher_lock


class MonitorTests(unittest.TestCase):
    def test_second_watcher_fails_without_touching_work_and_lock_releases_on_exit(self):
        with TemporaryDirectory() as temp:
            directory = Path(temp)
            with watcher_lock(directory):
                with self.assertRaisesRegex(RuntimeError, 'Another watcher'):
                    with watcher_lock(directory): self.fail('Acquired twice')
            with watcher_lock(directory): pass

    def test_preflight_watcher_exits_even_when_parent_already_started_solve(self):
        monitor = object.__new__(Monitor)
        monitor.load = Mock(side_effect=[{'phase': 'preflight-running', 'deadline': 99999999999},
                                         {'phase': 'preflight-passed'}, {'phase': 'solve-running'}])
        monitor.guard = Mock(return_value=[]); monitor.directory = Path('/unused')
        monitor.status = Mock(); monitor.read = Mock()
        monitor.controller = Mock(return_value=SimpleNamespace(returncode=0, stdout='passed', stderr=''))
        with patch('monitor.archive', return_value=1), patch('monitor.time.sleep') as sleep:
            self.assertEqual(monitor.run(), 0)
            sleep.assert_not_called()
        monitor.controller.assert_called_once_with('collect')
        self.assertEqual(monitor.status.call_args.args[0]['monitoredPhase'], 'preflight-running')

    def test_transitioning_job_is_described_once_across_status_pages(self):
        calls = []
        def read(service, operation, args):
            calls.append((operation, args))
            if operation == 'list-jobs':
                return {'jobSummaryList': [{'jobId': 'transition'}] if args[-1] in ('RUNNABLE', 'STARTING', 'RUNNING') else []}
            self.assertEqual(args, ['--jobs', 'transition'])
            return {'jobs': [{'jobId': 'transition', 'status': 'SUCCEEDED'}]}
        jobs = active_inventory(read, 'queue')
        self.assertEqual(len(jobs), 1)
        self.assertEqual(sum(op == 'describe-jobs' for op, _ in calls), 1)

    def test_all_unique_ids_are_batched_and_missing_or_duplicate_descriptions_fail(self):
        for behavior in ['complete', 'missing', 'duplicate']:
            def read(service, operation, args):
                if operation == 'list-jobs':
                    return {'jobSummaryList': [{'jobId': f'job-{i:03}'} for i in range(150)]}
                ids = args[1:]; self.assertLessEqual(len(ids), 100)
                jobs = [{'jobId': k} for k in ids]
                if behavior == 'missing': jobs = jobs[:-1]
                if behavior == 'duplicate': jobs += jobs[:1]
                return {'jobs': jobs}
            if behavior == 'complete': self.assertEqual(len(active_inventory(read, 'queue')), 150)
            else:
                with self.assertRaisesRegex(RuntimeError, 'Unresolved'): active_inventory(read, 'queue')

    def test_guard_preserves_unrelated_work(self):
        monitor = object.__new__(Monitor); monitor.state = {'queue': 'ours', 'definition': 'owned'}
        monitor.read = Mock(); monitor.controller = Mock()
        with patch('monitor.active_inventory', return_value=[{'jobId': 'foreign', 'jobQueue': 'ours', 'jobDefinition': 'another'}]):
            with self.assertRaisesRegex(RuntimeError, 'Unrelated'): monitor.guard()
        monitor.controller.assert_not_called()

    def test_guard_error_stops_once_and_returns_failure(self):
        monitor = object.__new__(Monitor)
        monitor.load = Mock(return_value={'phase': 'solve-running', 'deadline': 99999999999})
        monitor.guard = Mock(side_effect=RuntimeError('incomplete inventory'))
        monitor.status = Mock(); monitor.controller = Mock(return_value=SimpleNamespace(returncode=0, stdout='drained', stderr=''))
        self.assertEqual(monitor.run(), 1)
        monitor.controller.assert_called_once_with('stop')
        self.assertEqual(monitor.status.call_args.args[0]['status'], 'failed')

    def test_fixed_deadline_stops_once_without_starting_or_replaying_work(self):
        monitor = object.__new__(Monitor)
        monitor.load = Mock(return_value={'phase': 'solve-running', 'deadline': 100})
        monitor.guard = Mock(return_value=[]); monitor.directory = Path('/unused')
        monitor.status = Mock(); monitor.read = Mock()
        monitor.controller = Mock(return_value=SimpleNamespace(returncode=0, stdout='drained', stderr=''))
        with patch('monitor.time.time', return_value=200), patch('monitor.archive', return_value=0):
            self.assertEqual(monitor.run(), 1)
        monitor.controller.assert_called_once_with('stop')
        self.assertEqual(monitor.status.call_args.args[0]['status'], 'stopped')

    def test_terminal_history_is_retained_and_no_longer_queried_after_capture(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'instance-baseline.json').write_text('{"Reservations":[]}')
            snapshot = {'Reservations': [{'Instances': [{'InstanceId': 'new-host', 'State': {'Name': 'running'},
                'BlockDeviceMappings': [{'Ebs': {'VolumeId': 'recorded-root'}}]}]}]}
            (root / 'instances-1.json').write_text(json.dumps(snapshot))
            read = Mock(side_effect=lambda service, op, args: {'Reservations': [{'Instances': [{'InstanceId': 'new-host', 'State': {'Name': 'terminated'}}]}]}
                        if op == 'describe-instances' else {'Volumes': []})
            self.assertEqual(archive(root, read), 1)
            self.assertEqual(archive(root, read), 1)
            self.assertEqual(sum(call.args[1] == 'describe-instances' for call in read.call_args_list), 1)
            receipts = list((root / 'capacity/instance-history').glob('explicit-*.json'))
            self.assertEqual(len(receipts), 1)
            self.assertEqual(json.loads(receipts[0].read_text())['Reservations'][0]['Instances'][0]['State']['Name'], 'terminated')


if __name__ == '__main__':
    unittest.main()
