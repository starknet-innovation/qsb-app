"""Real SDK fault injection on loopback only; no AWS credentials or cloud requests."""
from contextlib import contextmanager, suppress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import Mock

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, ConnectionClosedError
from aws_clients import ScopedClient
from control import Campaign


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        with self.server.lock:
            self.server.calls += 1; count = self.server.calls
        if count <= self.server.failures and self.server.mode == 'closed':
            with suppress(OSError): self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close(); return
        failed = count <= self.server.failures
        payload = {'__type': self.server.mode, 'message': 'local fault'} if failed else {'events': []}
        data = json.dumps(payload).encode()
        self.send_response(400 if failed else 200)
        self.send_header('Content-Type', 'application/x-amz-json-1.1')
        self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)


@contextmanager
def endpoint(mode, failures):
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.mode, server.failures, server.calls, server.lock = mode, failures, 0, threading.Lock()
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True); thread.start()
    try: yield server
    finally: server.shutdown(); server.server_close(); thread.join()


def campaign(directory, server):
    c = object.__new__(Campaign); c.directory = Path(directory); c.clients = {}
    c.sdk_config = Config(connect_timeout=0.5, read_timeout=0.5, retries={'total_max_attempts': 1})
    c.read_sdk_config = Config(connect_timeout=0.5, read_timeout=0.5, retries={'mode': 'standard', 'total_max_attempts': 5})
    c.session = Mock()
    c.session.client.side_effect = lambda service, config: boto3.client(service, config=config, region_name='eu-west-1',
        endpoint_url='http://127.0.0.1:' + str(server.server_port), aws_access_key_id='local-test', aws_secret_access_key='local-test')
    return c


class SdkTransportTests(unittest.TestCase):
    def test_reviewed_reads_recover_from_closed_connections_and_throttling(self):
        for mode in ['closed', 'ThrottlingException']:
            with self.subTest(mode=mode), TemporaryDirectory() as directory, endpoint(mode, 2) as server:
                c = campaign(directory, server)
                response = c.client('logs').filter_log_events(logGroupName='local-only')
                self.assertEqual(server.calls, 3); self.assertEqual(response['ResponseMetadata']['RetryAttempts'], 2)
                self.assertEqual(response['events'], [])

    def test_persistent_read_failure_is_bounded_and_denials_do_not_retry(self):
        for mode, expected, error in [('closed', 5, ConnectionClosedError), ('AccessDeniedException', 1, ClientError)]:
            with self.subTest(mode=mode), TemporaryDirectory() as directory, endpoint(mode, 10) as server:
                c = campaign(directory, server)
                with self.assertRaises(error): c.client('logs').filter_log_events(logGroupName='local-only')
                self.assertEqual(server.calls, expected)

    def test_lost_mutation_response_is_one_request_even_with_the_read_client_cached(self):
        for invoke in [False, True]:
            with self.subTest(invoke=invoke), TemporaryDirectory() as directory, endpoint('closed', 1) as server:
                c = campaign(directory, server); c.client('batch')
                params = {'jobName': 'local-only', 'jobQueue': 'local-only', 'jobDefinition': 'local-only'}
                options = {'invoke': lambda: c.client('batch').submit_job(**params)} if invoke else {}
                with self.assertRaises(ConnectionClosedError): c.mutate('submission', 'batch', 'submit_job', **options, **params)
                with self.assertRaisesRegex(RuntimeError, 'Prior failure'): c.mutate('submission', 'batch', 'submit_job', **options, **params)
                self.assertEqual(server.calls, 1)
                self.assertTrue((Path(directory) / 'requests/submission.intent.json').exists())

    def test_only_reviewed_paginators_and_waiters_use_retrying_clients(self):
        writer, reader = Mock(), Mock(); client = ScopedClient('batch', writer, reader)
        client.get_paginator('list_jobs'); reader.get_paginator.assert_called_once_with('list_jobs')
        with self.assertRaises(RuntimeError): client.get_paginator('submit_job')
        with self.assertRaises(RuntimeError): client.get_waiter('unreviewed')
        client.future_mutation(); writer.future_mutation.assert_called_once(); reader.future_mutation.assert_not_called()


if __name__ == '__main__': unittest.main()
