"""Rate-limited read collection never replays paid work or hides incomplete pages."""
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from control import fixed_deadline, Campaign, check_operator_config


class Throttled(Exception): pass


class Clock:
    def __init__(self): self.now = 100.0
    def monotonic(self): return self.now
    def sleep(self, seconds): self.now += seconds


class LogCollectionTests(unittest.TestCase):
    def campaign(self, directory, results):
        c = object.__new__(Campaign); c.directory = Path(directory)
        clock = Clock(); calls = []
        def read(**params):
            calls.append((clock.now, params.copy()))
            result = results.pop(0)
            if isinstance(result, Exception): raise result
            return result
        logs = SimpleNamespace(filter_log_events=Mock(side_effect=read), exceptions=SimpleNamespace(ThrottlingException=Throttled))
        c.client = Mock(return_value=logs); c.mutate = Mock()
        return c, clock, calls

    def test_sdk_retry_metadata_and_empty_continuation_pages_are_retained_without_replay(self):
        first = {'events': [{'eventId': 'a'}], 'nextToken': 'one'}
        empty = {'events': [], 'nextToken': 'two', 'ResponseMetadata': {'RetryAttempts': 2}}
        last = {'events': [{'eventId': 'b'}]}
        with TemporaryDirectory() as directory:
            c, clock, calls = self.campaign(directory, [first, empty, last])
            with patch('control.time.monotonic', clock.monotonic), patch('control.time.sleep', clock.sleep):
                self.assertEqual(c.log_pages(logGroupName='ours'), [first, empty, last])
            self.assertEqual([p.get('nextToken') for _, p in calls], [None, 'one', 'two'])
            self.assertTrue(all(b[0] - a[0] >= 0.399 for a, b in zip(calls, calls[1:])))
            c.mutate.assert_not_called(); self.assertTrue(all(call.args == ('logs',) for call in c.client.call_args_list))

    def test_other_errors_do_not_retry_or_claim_collection_success(self):
        with TemporaryDirectory() as directory:
            c, clock, calls = self.campaign(directory, [RuntimeError('Access denied')])
            with patch('control.time.monotonic', clock.monotonic), patch('control.time.sleep', clock.sleep):
                with self.assertRaisesRegex(RuntimeError, 'Access denied'): c.log_pages(logGroupName='ours')
            self.assertEqual(len(calls), 1); c.mutate.assert_not_called()

    def test_repeated_tokens_fail_closed_and_rate_limit_survives_separate_groups(self):
        with TemporaryDirectory() as directory:
            c, clock, calls = self.campaign(directory, [{'events': []}, {'events': [], 'nextToken': 'same'}, {'events': [], 'nextToken': 'same'}])
            with patch('control.time.monotonic', clock.monotonic), patch('control.time.sleep', clock.sleep):
                c.log_pages(logGroupName='first')
                with self.assertRaisesRegex(RuntimeError, 'Repeated'): c.log_pages(logGroupName='second')
            self.assertTrue(all(b[0] - a[0] >= 0.399 for a, b in zip(calls, calls[1:]))); c.mutate.assert_not_called()

    def test_ireland_requires_explicit_isolated_mode_and_regions_stay_bounded(self):
        base = {'profile': 'selected', 'account': '123456789012', 'region': 'eu-west-2'}
        check_operator_config(base)
        check_operator_config(dict(base, region='eu-west-1', snfIsolation=True))
        for changed in [dict(base, region='eu-west-1'), dict(base, snfIsolation=False),
                        dict(base, region='us-east-1', snfIsolation=True), dict(base, extra=True)]:
            with self.assertRaises(RuntimeError): check_operator_config(changed)

    def test_virginia_deadline_is_required_and_bounded_by_reservation(self):
        config = dict(profile='selected', account='123456789012', region='us-east-1', snfIsolation=True, notAfter=50000)
        check_operator_config(config)
        self.assertEqual(fixed_deadline(config, 10000, False), 50000)
        self.assertEqual(fixed_deadline(dict(config, notAfter=60000), 10000, False), 53200)
        with self.assertRaises(RuntimeError): fixed_deadline(dict(config, notAfter=9999), 10000, False)
        with self.assertRaises(RuntimeError): check_operator_config(dict(config, notAfter=True))
        with self.assertRaises(RuntimeError): check_operator_config(dict(config, snfIsolation=False))
        london = dict(profile='selected', account='123456789012', region='eu-west-2', notAfter=11000)
        check_operator_config(london)
        self.assertEqual(fixed_deadline(london, 10000, False), 11000)


if __name__ == '__main__': unittest.main()
