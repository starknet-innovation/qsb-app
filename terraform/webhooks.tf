# Scheduled webhook dispatcher: every 5 minutes, EventBridge Scheduler invokes a small Lambda that sends queued
# webhook deliveries whose retry is due (server/webhook-dispatcher.ts). Without it a retry waits for the owner's
# next API request or coordinator tick. Off by default: with webhook_dispatcher_enabled = false nothing here is
# planned. The due-delivery index it queries is on the table either way (data.tf).
#
# The dispatcher runs no coordinator, payment or reconcile code. Its role may query the due-delivery index and read
# and write WEBHOOK# rows, the owners' webhook partitions, and no other row. The schedule's role may only invoke the
# dispatcher. Both roles sit under the runtime path and boundary, like every other application role.
locals {
  webhook_due_index    = "webhook-due"
  webhook_table_arn    = "arn:${data.aws_partition.current.partition}:dynamodb:${var.region}:${var.aws_account_id}:table/${aws_dynamodb_table.records.name}"
  webhook_function_arn = "arn:${data.aws_partition.current.partition}:lambda:${var.region}:${var.aws_account_id}:function:${var.name}-webhooks"
}
resource "aws_iam_role_policy" "webhook_records" {
  count = var.webhook_dispatcher_enabled ? 1 : 0
  role  = aws_iam_role.lambda["webhooks"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      for statement in jsondecode(file("${path.module}/policies/webhook-dispatcher-records.json")) : merge(statement, {
        # Query reaches the keys-only index and nothing else; GetItem and PutItem the table's WEBHOOK# partitions.
        Resource = statement.Sid == "FindDueOwners" ? "${local.webhook_table_arn}/index/${local.webhook_due_index}" : local.webhook_table_arn
      })
    ]
  })
}
resource "aws_lambda_function" "webhooks" {
  count                          = var.webhook_dispatcher_enabled ? 1 : 0
  function_name                  = "${var.name}-webhooks"
  role                           = aws_iam_role.lambda["webhooks"].arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  filename                       = "${local.artifacts}/webhooks.zip"
  source_code_hash               = filebase64sha256("${local.artifacts}/webhooks.zip")
  timeout                        = 60
  memory_size                    = 256
  reserved_concurrent_executions = 1
  environment {
    variables = { TABLE_NAME = aws_dynamodb_table.records.name }
  }
  depends_on = [terraform_data.release, aws_iam_role_policy.logs, aws_iam_role_policy.webhook_records]
}
# Scheduler invokes the dispatcher asynchronously, so Lambda's own async retries (two by default) would re-run a
# failed run. None: the next scheduled run finds the same due deliveries. An invoke that can't start within a
# period is dropped for the same reason.
resource "aws_lambda_function_event_invoke_config" "webhooks" {
  count                        = var.webhook_dispatcher_enabled ? 1 : 0
  function_name                = aws_lambda_function.webhooks[0].function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 300
}
resource "aws_iam_role" "webhook_schedule" {
  count                = var.webhook_dispatcher_enabled ? 1 : 0
  name                 = "${var.name}-webhook-schedule"
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow"
    Principal = { Service = "scheduler.amazonaws.com" }
    Action    = "sts:AssumeRole"
    Condition = { StringEquals = { "aws:SourceAccount" = var.aws_account_id } }
  }] })
}
resource "aws_iam_role_policy" "webhook_schedule" {
  count  = var.webhook_dispatcher_enabled ? 1 : 0
  role   = aws_iam_role.webhook_schedule[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = local.webhook_function_arn }] })
}
resource "aws_scheduler_schedule" "webhooks" {
  count               = var.webhook_dispatcher_enabled ? 1 : 0
  name                = "${var.name}-webhooks"
  description         = "Send queued webhook deliveries whose retry is due."
  schedule_expression = "rate(5 minutes)"
  flexible_time_window { mode = "OFF" }
  target {
    arn      = local.webhook_function_arn
    role_arn = aws_iam_role.webhook_schedule[0].arn
    # A missed run isn't retried: the next one, 5 minutes later, finds the same due deliveries.
    retry_policy {
      maximum_retry_attempts       = 0
      maximum_event_age_in_seconds = 300
    }
  }
  depends_on = [aws_lambda_function.webhooks, aws_iam_role_policy.webhook_schedule]
}
