output "app_url" { value = "https://${aws_cloudfront_distribution.web.domain_name}" }
output "api_url" { value = aws_apigatewayv2_api.api.api_endpoint }
output "frontend_bucket" { value = aws_s3_bucket.frontend.id }
output "cloudfront_distribution_id" { value = aws_cloudfront_distribution.web.id }
# The four IDs an administrator registers in the ops/github-aws inventory after the first apply.
output "origin_access_control_id" { value = aws_cloudfront_origin_access_control.web.id }
output "response_headers_policy_id" { value = aws_cloudfront_response_headers_policy.security.id }
output "api_id" { value = aws_apigatewayv2_api.api.id }
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
output "operator_reconcile_role_arn" { value = aws_iam_role.operator_reconcile.arn }

output "exact_submit_enabled" { value = var.mainnet_enabled && var.exact_submit_enabled }
