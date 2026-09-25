output "app_url" { value = "https://${aws_cloudfront_distribution.web.domain_name}" }
output "api_url" { value = aws_apigatewayv2_api.api.api_endpoint }
output "frontend_bucket" { value = aws_s3_bucket.frontend.id }
output "cloudfront_distribution_id" { value = aws_cloudfront_distribution.web.id }
output "table_name" { value = aws_dynamodb_table.records.name }
output "workflow_arn" { value = aws_sfn_state_machine.withdrawal.arn }
output "source_commit" { value = var.source_commit }
output "transactions_enabled" { value = false }
output "runpod_configured" { value = local.runpod }
output "runpod_limits" {
  value = {
    workersMax         = local.gpu_spend.workersMax
    workersMin         = local.gpu_spend.workersMin
    executionTimeoutMs = local.gpu_spend.executionTimeoutMs
  }
}
output "operator_reconcile_role_arn" { value = aws_iam_role.operator_reconcile.arn }

output "exact_submit_enabled" { value = var.exact_submit_enabled }
