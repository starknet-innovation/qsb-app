"""Terminate stale QSB Batch jobs; never launch or retry GPU work."""
import os
import time
import boto3
from botocore.config import Config

batch = boto3.client('batch', config=Config(retries={'total_max_attempts': 2}, connect_timeout=5, read_timeout=10))

def handler(event, context):
    queue = os.environ['JOB_QUEUE']
    cutoff = int(time.time() * 1000) - 30 * 60 * 1000
    terminated = []
    for status in ('SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING', 'RUNNING'):
        for page in batch.get_paginator('list_jobs').paginate(jobQueue=queue, jobStatus=status):
            for summary in page.get('jobSummaryList', []):
                if summary.get('createdAt', cutoff + 1) > cutoff:
                    continue
                for job in batch.describe_jobs(jobs=[summary['jobId']]).get('jobs', []):
                    if job['jobQueue'] != queue or job.get('tags', {}).get('Project') != 'qsb-gpu':
                        raise RuntimeError('Unexpected job identity in dedicated QSB queue')
                    batch.terminate_job(jobId=job['jobId'], reason='QSB 30-minute submission age ceiling')
                    terminated.append(job['jobId'])
    print({'terminated': terminated})
    return {'terminated': terminated}
