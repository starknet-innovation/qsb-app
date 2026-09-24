resource "aws_iam_role" "watchdog" {
  count              = local.runtime_count
  name               = "${var.name}-cleanup-watchdog"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_cloudwatch_log_group" "watchdog" {
  count             = local.runtime_count
  name              = "/aws/lambda/${var.name}-cleanup-watchdog"
  retention_in_days = 30
}
resource "aws_iam_role_policy" "watchdog" {
  count = local.runtime_count
  role  = aws_iam_role.watchdog[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.watchdog[0].arn}:*" },
    { Effect = "Allow", Action = "dynamodb:PutItem", Resource = aws_dynamodb_table.cleanup[0].arn }
  ], var.runpod_secret_arn == "" ? [] : [{ Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = var.runpod_secret_arn }], var.runpod_secret_kms_key_arn == "" ? [] : [{ Effect = "Allow", Action = "kms:Decrypt", Resource = var.runpod_secret_kms_key_arn, Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" } } }]) })
}
resource "aws_lambda_function" "watchdog" {
  count                          = local.runtime_count
  function_name                  = "${var.name}-cleanup-watchdog"
  role                           = aws_iam_role.watchdog[0].arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  filename                       = "${local.artifacts}/watchdog.zip"
  source_code_hash               = filebase64sha256("${local.artifacts}/watchdog.zip")
  timeout                        = 90
  memory_size                    = 256
  reserved_concurrent_executions = 1
  environment {
    variables = { CLEANUP_ENDPOINTS = jsonencode(var.cleanup_endpoints), CLEANUP_TABLE = aws_dynamodb_table.cleanup[0].name, RUNPOD_SECRET_ARN = var.runpod_secret_arn }
  }
  lifecycle {
    precondition {
      condition     = length(var.cleanup_endpoints) == 0 || var.runpod_secret_arn != ""
      error_message = "Enrolled cleanup targets require a privately provisioned provider secret ARN."
    }
  }
  depends_on = [terraform_data.release, aws_iam_role_policy.watchdog]
}
resource "aws_cloudwatch_event_rule" "watchdog" {
  count               = local.runtime_count
  name                = "${var.name}-cleanup-watchdog"
  schedule_expression = "rate(1 minute)"
  state               = length(var.cleanup_endpoints) == 0 ? "DISABLED" : "ENABLED"
}
resource "aws_cloudwatch_event_target" "watchdog" {
  count = local.runtime_count
  rule  = aws_cloudwatch_event_rule.watchdog[0].name
  arn   = aws_lambda_function.watchdog[0].arn
  retry_policy {
    maximum_event_age_in_seconds = 120
    maximum_retry_attempts       = 0
  }
}
resource "aws_lambda_permission" "watchdog" {
  count         = local.runtime_count
  statement_id  = "ScheduledCleanup"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.watchdog[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.watchdog[0].arn
}
resource "aws_lambda_function_event_invoke_config" "watchdog" {
  count                        = local.runtime_count
  function_name                = aws_lambda_function.watchdog[0].function_name
  maximum_event_age_in_seconds = 120
  maximum_retry_attempts       = 0
}
resource "aws_cloudwatch_metric_alarm" "watchdog_errors" {
  count               = local.runtime_count
  alarm_name          = "${var.name}-cleanup-watchdog-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.watchdog[0].function_name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}
output "supervised_runtime" {
  value = var.provision_runtime ? {
    instance_id                  = aws_instance.runtime[0].id
    evidence_volume              = aws_ebs_volume.evidence[0].id
    artifact_and_evidence_bucket = aws_s3_bucket.runtime[0].id
    image_repository             = aws_ecr_repository.runtime[0].repository_url
    dispatch_queue_url           = aws_sqs_queue.dispatch[0].url
    cleanup_table                = aws_dynamodb_table.cleanup[0].name
    execution_enabled            = false
  } : null
}
resource "aws_cloudwatch_metric_alarm" "watchdog_missing" {
  count               = var.provision_runtime && length(var.cleanup_endpoints) > 0 ? 1 : 0
  alarm_name          = "${var.name}-cleanup-watchdog-missing"
  namespace           = "AWS/Lambda"
  metric_name         = "Invocations"
  dimensions          = { FunctionName = aws_lambda_function.watchdog[0].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_actions
}
