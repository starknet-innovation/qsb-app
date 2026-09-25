resource "aws_cloudwatch_log_group" "workflow" {
  name              = "/aws/vendedlogs/states/${var.name}"
  retention_in_days = 30
}
resource "aws_iam_role" "workflow" {
  name               = "${var.name}-workflow"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "workflow" {
  role = aws_iam_role.workflow.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = "lambda:InvokeFunction", Resource = aws_lambda_function.coordinator.arn },
    { Effect = "Allow", Action = "states:StartExecution", Resource = local.workflow_arn },
    # These log-delivery control-plane actions do not support resource scoping.
    { Effect = "Allow", Action = ["logs:CreateLogDelivery", "logs:GetLogDelivery", "logs:UpdateLogDelivery", "logs:DeleteLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:DescribeResourcePolicies", "logs:DescribeLogGroups"], Resource = "*" }
  ] })
}
resource "aws_sfn_state_machine" "withdrawal" {
  name     = "${var.name}-withdrawal"
  role_arn = aws_iam_role.workflow.arn
  type     = "STANDARD"
  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.workflow.arn}:*"
    include_execution_data = false
    level                  = "ERROR"
  }
  definition = jsonencode({ StartAt = "CoordinateSearch", States = {
    CoordinateSearch       = { Type = "Task", Resource = "arn:${data.aws_partition.current.partition}:lambda:${var.region}:${var.aws_account_id}:function:${var.name}-coordinator", TimeoutSeconds = aws_lambda_function.coordinator.timeout + 5, Catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.failure", Next = "NeedsOperatorAttention" }], Next = "SearchFinished" },
    SearchFinished         = { Type = "Choice", Choices = [{ Variable = "$.done", BooleanEquals = true, Next = "Finished" }, { Variable = "$.polls", NumericGreaterThanEquals = 1000, Next = "SaveContinuation" }], Default = "WaitForCompute" },
    WaitForCompute         = { Type = "Wait", SecondsPath = "$.waitSeconds", Next = "CoordinateSearch" },
    SaveContinuation       = { Type = "Pass", Parameters = { continuation = { "owner.$" = "$.owner", "jobId.$" = "$.jobId", "revision.$" = "$.revision", polls = 0 } }, Next = "ContinueSearch" },
    ContinueSearch         = { Type = "Task", Resource = "arn:aws:states:::aws-sdk:sfn:startExecution", Parameters = { StateMachineArn = local.workflow_arn, "Input.$" = "States.JsonToString($.continuation)" }, Next = "Finished" },
    Finished               = { Type = "Succeed" },
    NeedsOperatorAttention = { Type = "Fail", Error = "WorkflowInterrupted", Cause = "Reconcile durable intents and provider IDs before retrying paid work." }
  } })
  depends_on = [terraform_data.release, aws_iam_role_policy.workflow]
}
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each            = local.functions
  alarm_name          = "${var.name}-${each.key}-errors"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = "${var.name}-${each.key}" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}
resource "aws_cloudwatch_metric_alarm" "workflow_failures" {
  alarm_name          = "${var.name}-workflow-failures"
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  dimensions          = { StateMachineArn = local.workflow_arn }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}
