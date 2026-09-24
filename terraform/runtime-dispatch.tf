# Dormant delivery path. Activation requires a separately reviewed runtime enrollment.
resource "aws_iam_role" "dispatch" {
  count              = local.runtime_count
  name               = "${var.name}-dispatch-publisher"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_cloudwatch_log_group" "dispatch" {
  count             = local.runtime_count
  name              = "/aws/lambda/${var.name}-dispatch-publisher"
  retention_in_days = 30
}
resource "aws_iam_role_policy" "dispatch" {
  count = local.runtime_count
  role  = aws_iam_role.dispatch[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.dispatch[0].arn}:*" },
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:Query"], Resource = aws_dynamodb_table.records.arn },
    { Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:DeleteItem"], Resource = aws_dynamodb_table.records.arn, Condition = { "ForAllValues:StringEquals" = { "dynamodb:LeadingKeys" = ["SYSTEM#QSB_DISPATCH_OUTBOX"] } } },
    { Effect = "Allow", Action = "sqs:SendMessage", Resource = aws_sqs_queue.dispatch[0].arn }
  ] })
}
resource "aws_lambda_function" "dispatch" {
  count                          = local.runtime_count
  function_name                  = "${var.name}-dispatch-publisher"
  role                           = aws_iam_role.dispatch[0].arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  filename                       = "${local.artifacts}/dispatch.zip"
  source_code_hash               = filebase64sha256("${local.artifacts}/dispatch.zip")
  timeout                        = 60
  memory_size                    = 256
  reserved_concurrent_executions = 1
  environment { variables = { TABLE_NAME = aws_dynamodb_table.records.name, SUPERVISED_DISPATCH_QUEUE_URL = aws_sqs_queue.dispatch[0].url, SUPERVISED_EXECUTION_ENABLED = "false" } }
  depends_on = [terraform_data.release, aws_iam_role_policy.dispatch]
}
resource "aws_cloudwatch_event_rule" "dispatch" {
  count               = local.runtime_count
  name                = "${var.name}-dispatch-publisher"
  schedule_expression = "rate(1 minute)"
  state               = "DISABLED"
}
resource "aws_cloudwatch_event_target" "dispatch" {
  count = local.runtime_count
  rule  = aws_cloudwatch_event_rule.dispatch[0].name
  arn   = aws_lambda_function.dispatch[0].arn
  retry_policy {
    maximum_event_age_in_seconds = 120
    maximum_retry_attempts       = 0
  }
}
resource "aws_lambda_permission" "dispatch" {
  count         = local.runtime_count
  statement_id  = "ScheduledDispatch"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dispatch[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.dispatch[0].arn
}
