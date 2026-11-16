output "app_url" { value = "https://${aws_cloudfront_distribution.web.domain_name}" }
output "frontend_bucket" { value = aws_s3_bucket.frontend.id }
output "cloudfront_distribution_id" { value = aws_cloudfront_distribution.web.id }
# The IDs an administrator registers in the ops/github-aws inventory after the first apply: the
# distribution, both origin access controls and the response headers policy.
output "origin_access_control_ids" { value = [aws_cloudfront_origin_access_control.web.id, aws_cloudfront_origin_access_control.api.id] }
output "response_headers_policy_id" { value = aws_cloudfront_response_headers_policy.security.id }
output "table_name" { value = aws_dynamodb_table.records.name }
output "workflow_arn" { value = aws_sfn_state_machine.withdrawal.arn }
output "source_commit" { value = var.source_commit }
output "transactions_enabled" { value = var.mainnet_enabled }
output "compute_configured" { value = local.compute }
output "gpu_limits" {
  value = {
    workersMax         = local.gpu_spend.workersMax
    workersMin         = local.gpu_spend.workersMin
    executionTimeoutMs = local.gpu_spend.executionTimeoutMs
  }
}
output "gpu_capacity" {
  value = {
    instanceTypes      = local.gpu_instance_types
    allocationStrategy = local.gpu_allocation_strategy
    maxVcpus           = local.gpu_max_vcpus
    vcpuCeiling        = local.gpu_vcpu_ceiling
    parallelSlots      = local.gpu_parallel_slots
  }
}
output "operator_reconcile_role_arn" { value = aws_iam_role.operator_reconcile.arn }

output "exact_submit_enabled" { value = var.mainnet_enabled && var.exact_submit_enabled }
