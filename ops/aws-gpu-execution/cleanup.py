"""Terminate only this experiment's tagged instance after its absolute deadline."""
import os
import time
import boto3
from botocore.config import Config


def handler(event, context):
    if time.time() < int(os.environ['DEADLINE']):
        return {'status': 'armed'}
    ec2 = boto3.client('ec2', config=Config(connect_timeout=5, read_timeout=10,
                       retries={'mode': 'standard', 'total_max_attempts': 3}))
    ids = []
    for page in ec2.get_paginator('describe_instances').paginate(Filters=[
        {'Name': 'tag:QsbBenchmarkToken', 'Values': [os.environ['RUN_TOKEN']]},
        {'Name': 'instance-state-name', 'Values': ['pending', 'running', 'stopping', 'stopped']} ]):
        ids.extend(i['InstanceId'] for r in page['Reservations'] for i in r['Instances'])
    if ids:
        ec2.terminate_instances(InstanceIds=ids)
    return {'terminated': ids}
