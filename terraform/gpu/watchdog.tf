data "archive_file" "watchdog" {
  type        = "zip"
  source_file = "${path.module}/watchdog.py"
  output_path = "${path.module}/.build/watchdog.zip"
}
resource "aws_iam_role" "watchdog" {
  name               = "qsb-gpu-watchdog"
  path               = "/qsb/runtime/"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }] })
}
resource "aws_cloudwatch_log_group" "watchdog" {
  name              = "/aws/lambda/qsb-gpu-watchdog"
  retention_in_days = 30
}
resource "aws_iam_role_policy" "watchdog" {
  role = aws_iam_role.watchdog.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["batch:ListJobs", "batch:DescribeJobs"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = "eu-west-1" } } },
    { Effect = "Allow", Action = ["batch:TerminateJob"], Resource = "arn:aws:batch:eu-west-1:905846953990:job/*", Condition = { StringEquals = { "aws:ResourceTag/Project" = "qsb-gpu" } } },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.watchdog.arn}:*" }
  ] })
}
resource "aws_lambda_function" "watchdog" {
  function_name                  = "qsb-gpu-watchdog"
  role                           = aws_iam_role.watchdog.arn
  runtime                        = "python3.13"
  handler                        = "watchdog.handler"
  timeout                        = 120
  reserved_concurrent_executions = 1
  filename                       = data.archive_file.watchdog.output_path
  source_code_hash               = data.archive_file.watchdog.output_base64sha256
  environment { variables = { JOB_QUEUE = aws_batch_job_queue.gpu.arn, SOURCE_COMMIT = var.source_commit } }
  depends_on = [aws_iam_role_policy.watchdog]
}
resource "aws_cloudwatch_event_rule" "watchdog" {
  name                = "qsb-gpu-watchdog"
  schedule_expression = "rate(5 minutes)"
}
resource "aws_cloudwatch_event_target" "watchdog" {
  rule = aws_cloudwatch_event_rule.watchdog.name
  arn  = aws_lambda_function.watchdog.arn
}
resource "aws_lambda_permission" "watchdog" {
  statement_id  = "QsbGpuWatchdogSchedule"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.watchdog.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.watchdog.arn
}
