"""Route reviewed reads to bounded SDK retries; every other operation stays one attempt."""
READS = {
    'sts': {'get_caller_identity'},
    'batch': {'describe_compute_environments', 'describe_job_definitions', 'describe_job_queues', 'describe_jobs', 'list_jobs'},
    'lambda': {'get_function_configuration', 'list_tags'},
    'dynamodb': {'describe_table', 'get_item', 'scan', 'list_tags_of_resource'},
    'stepfunctions': {'describe_state_machine', 'list_executions', 'list_tags_for_resource'},
    's3': {'get_object', 'head_object', 'list_buckets', 'list_objects_v2'},
    'logs': {'filter_log_events', 'describe_log_groups', 'list_tags_log_group'},
    'iam': {'get_role', 'get_role_policy', 'get_policy', 'get_policy_version', 'get_instance_profile', 'list_role_policies', 'list_attached_role_policies'},
    'ec2': {'describe_instances', 'describe_volumes', 'describe_images', 'describe_vpcs', 'describe_subnets',
            'describe_instance_type_offerings', 'describe_security_groups', 'describe_launch_templates', 'describe_launch_template_versions'},
    'ecr': {'describe_repositories', 'get_authorization_token'},
    'scheduler': {'get_schedule'},
    'service-quotas': {'get_service_quota'},
}
WAITERS = {'dynamodb': {'table_exists'}, 'lambda': {'function_active_v2', 'function_updated_v2'}}


class ScopedClient:
    def __init__(self, service, writer, reader):
        self.service, self.writer, self.reader = service, writer, reader

    def __getattr__(self, operation):
        client = self.reader if operation in READS.get(self.service, ()) else self.writer
        return getattr(client, operation)

    def get_paginator(self, operation):
        if operation not in READS.get(self.service, ()):
            raise RuntimeError('Only reviewed reads may use a retrying paginator')
        return self.reader.get_paginator(operation)

    def get_waiter(self, name):
        if name not in WAITERS.get(self.service, ()):
            raise RuntimeError('Only reviewed read waiters may retry')
        return self.reader.get_waiter(name)
