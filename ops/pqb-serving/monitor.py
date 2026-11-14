"""Bounded public-campaign observation. Paid work starts only through control.py."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from deadline import owns_job
from control import ROOT, ACTIVE, check_operator_config, clean_source, dump, persist


@contextmanager
def watcher_lock(directory):
    fd = os.open(directory / 'monitor.lock', os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('Another watcher holds this campaign; no stop was issued') from error
        yield
    finally:
        os.close(fd)


def active_inventory(read, queue):
    # ListJobs status queries are separate snapshots. A transitioning job can
    # legitimately appear in more than one; DescribeJobs rejects duplicate IDs.
    ids = set()
    for status in ACTIVE:
        page = read('batch', 'list-jobs', ['--job-queue', queue, '--job-status', status])
        for job in page['jobSummaryList']:
            if not isinstance(job.get('jobId'), str) or not job['jobId']:
                raise RuntimeError('Invalid active job identity')
            ids.add(job['jobId'])
    ordered = sorted(ids)
    jobs = []
    for start in range(0, len(ordered), 100):
        jobs.extend(read('batch', 'describe-jobs', ['--jobs', *ordered[start:start + 100]])['jobs'])
    if sorted(j['jobId'] for j in jobs) != ordered:
        raise RuntimeError('Unresolved active queue inventory')
    return jobs


def save_bytes(path, data):
    if path.exists():
        if path.read_bytes() != data:
            raise RuntimeError('Original receipt changed: ' + path.name)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as out:
        out.write(data); out.flush(); os.fsync(out.fileno())


def archive(directory, read):
    base = json.loads((directory / 'instance-baseline.json').read_text())
    old = {i['InstanceId'] for r in base['Reservations'] for i in r['Instances']}
    history = directory / 'capacity/instance-history'
    for path in [directory / 'instance-baseline.json', *directory.glob('instances-[0-9]*.json')]:
        save_bytes(history / path.name, path.read_bytes())
    hosts, terminal = set(), set()
    for path in history.glob('*.json'):
        for reservation in json.loads(path.read_text()).get('Reservations', []):
            for instance in reservation['Instances']:
                identity = instance['InstanceId']
                if identity in old:
                    continue
                hosts.add(identity)
                if instance['State']['Name'] == 'terminated':
                    terminal.add(identity)
    # Preserve terminated-state receipts before EC2 expires them. SG-filtered
    # inventory alone can omit a terminated instance after its interfaces vanish.
    pending = sorted(hosts - terminal)
    for start in range(0, len(pending), 100):
        chunk = pending[start:start + 100]
        response = read('ec2', 'describe-instances', ['--instance-ids', *chunk])
        found = [i['InstanceId'] for r in response['Reservations'] for i in r['Instances']]
        if sorted(found) != chunk:
            raise RuntimeError('Incomplete recorded instance inventory')
        save_bytes(history / ('explicit-' + str(time.time_ns()) + '.json'), (json.dumps(response, indent=2) + '\n').encode())
    if hosts:
        response = read('ec2', 'describe-volumes', ['--filters', 'Name=attachment.instance-id,Values=' + ','.join(sorted(hosts))])
        save_bytes(directory / 'capacity/volume-history' / (str(time.time_ns()) + '.json'), (json.dumps(response, indent=2) + '\n').encode())
    return len(hosts)


class Monitor:
    def __init__(self, directory):
        self.directory = directory.resolve()
        if self.directory.is_relative_to(ROOT):
            raise RuntimeError('Keep campaign receipts outside Git')
        self.operator = json.loads((self.directory / 'operator.json').read_text())
        self.state = self.load()
        check_operator_config(self.operator)
        if hashlib.sha256(dump(self.operator).encode()).hexdigest() != self.state['operatorHash']:
            raise RuntimeError('Frozen operator binding changed')
        if clean_source() != self.state['sourceCommit']:
            raise RuntimeError('Use the exact clean pushed campaign controller')
        if self.read('sts', 'get-caller-identity', [])['Account'] != self.operator['account']:
            raise RuntimeError('Wrong operator account')

    def load(self):
        return json.loads((self.directory / 'campaign.json').read_text())

    def read(self, service, operation, args):
        if (service, operation) not in {('sts', 'get-caller-identity'), ('batch', 'list-jobs'),
                ('batch', 'describe-jobs'), ('ec2', 'describe-instances'), ('ec2', 'describe-volumes')}:
            raise RuntimeError('Only reviewed metadata reads are allowed')
        result = subprocess.run(['aws', service, operation, '--profile', self.operator['profile'], '--region', self.operator['region'],
            '--cli-connect-timeout', '5', '--cli-read-timeout', '20', '--no-cli-pager', '--output', 'json', *args],
            env={**os.environ, 'AWS_RETRY_MODE': 'standard', 'AWS_MAX_ATTEMPTS': '5'}, capture_output=True, text=True, timeout=120)
        if result.returncode:
            raise RuntimeError('Independent fleet read failed: ' + result.stderr)
        return json.loads(result.stdout)

    def controller(self, mode):
        if mode not in ('collect', 'stop'):
            raise RuntimeError('The monitor cannot start paid work')
        return subprocess.run([sys.executable, str(ROOT / 'ops/pqb-serving/control.py'), mode, str(self.directory)],
            cwd=ROOT, text=True, capture_output=True, timeout=600)

    def guard(self):
        jobs = active_inventory(self.read, self.state['queue'])
        if any(not owns_job(j, self.state) or j['jobQueue'] != self.state['queue'] for j in jobs):
            raise RuntimeError('Unrelated work appeared; yield capacity without terminating it')
        return jobs

    def status(self, value):
        record = {'observedAt': time.time(), 'sourceCommit': self.state['sourceCommit'], **value}
        persist(self.directory / 'monitor-status.json', record)
        print(json.dumps(record), flush=True)

    def check(self):
        jobs = self.guard()
        hosts = archive(self.directory, self.read)
        persist(self.directory / 'monitor-readiness.json', {'sourceCommit': self.state['sourceCommit'],
            'monitorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'activeJobs': len(jobs), 'recordedHosts': hosts}, exclusive=True)

    def run(self):
        initial_phase = None
        while True:
            self.state = self.load()
            if initial_phase and self.state['phase'] != initial_phase:
                success = (initial_phase == 'preflight-running' and self.state['phase'] in ('preflight-passed', 'solve-running', 'solve-complete')
                           or initial_phase == 'solve-running' and self.state['phase'] == 'solve-complete')
                self.status({'status': 'complete' if success else 'stopped', 'phase': self.state['phase'], 'monitoredPhase': initial_phase})
                return 0 if success else 1
            if self.state['phase'] not in ('preflight-running', 'solve-running'):
                success = self.state['phase'] in ('preflight-passed', 'solve-complete')
                self.status({'status': 'complete' if success else 'stopped', 'phase': self.state['phase']})
                return 0 if success else 1
            initial_phase = self.state['phase']
            try:
                self.guard()
                mode = 'stop' if time.time() >= self.state['deadline'] - 1200 else 'collect'
                result = self.controller(mode)
                hosts = archive(self.directory, self.read)
                self.status({'status': 'running', 'mode': mode, 'returnCode': result.returncode, 'hostsObserved': hosts,
                             'stdout': result.stdout, 'stderr': result.stderr})
                if mode == 'stop':
                    self.status({'status': 'stopped', 'returnCode': result.returncode, 'reason': 'Fixed assessment deadline reached'})
                    return 1
                if result.returncode:
                    raise RuntimeError('Collector failed or fixed assessment deadline reached')
                if self.load()['phase'] != initial_phase:
                    continue
            except Exception as error:
                self.status({'status': 'failed', 'error': str(error)})
                # A stop is a fresh, journaled pause/drain, never a compute retry.
                stopped = self.controller('stop')
                self.status({'status': 'failed', 'stopReturnCode': stopped.returncode,
                             'stdout': stopped.stdout, 'stderr': stopped.stderr, 'error': str(error)})
                return 1
            time.sleep(25)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--check', action='store_true', help='Only check inventory and archive metadata; never start or stop work')
    args = parser.parse_args()
    directory = args.directory.resolve()
    if directory.is_relative_to(ROOT):
        parser.error('Keep campaign receipts outside Git')
    with watcher_lock(directory):
        monitor = Monitor(directory)
        if args.check:
            monitor.check()
            return 0
        return monitor.run()


if __name__ == '__main__':
    sys.exit(main())
