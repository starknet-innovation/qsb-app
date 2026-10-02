resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.name}-${each.key}"
  retention_in_days = 30
}
resource "aws_iam_role" "lambda" {
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn
  for_each             = local.functions
  name                 = "${var.name}-${each.key}"
  assume_role_policy   = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "logs" {
  for_each = local.functions
  role     = aws_iam_role.lambda[each.key].id
  policy   = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.lambda[each.key].arn}:*" }] })
}
# API reservations remain conditional creates; coordinator writes only OWNER rows.
resource "aws_iam_role_policy" "records" {
  for_each = toset(["api"])
  role     = aws_iam_role.lambda[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      for statement in jsondecode(file("${path.module}/policies/app-records.json")) : merge(statement, {
        Resource = "arn:${data.aws_partition.current.partition}:dynamodb:${var.region}:${var.aws_account_id}:table/${aws_dynamodb_table.records.name}"
      })
    ]
  })
}
resource "aws_iam_role_policy" "coordinator_records" {
  role = aws_iam_role.lambda["coordinator"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      for statement in jsondecode(file("${path.module}/policies/coordinator-records.json")) : merge(statement, {
        Resource = "arn:${data.aws_partition.current.partition}:dynamodb:${var.region}:${var.aws_account_id}:table/${aws_dynamodb_table.records.name}"
      })
    ]
  })
}
resource "aws_iam_role_policy" "batch" {
  count = local.compute ? 1 : 0
  role  = aws_iam_role.lambda["coordinator"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["batch:DescribeJobs", "batch:DescribeJobDefinitions", "batch:DescribeJobQueues", "batch:DescribeComputeEnvironments", "batch:ListJobs"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
    { Effect = "Allow", Action = "batch:SubmitJob", Resource = [var.batch_job_queue, var.batch_job_definition] },
    # Tagging on SubmitJob is authorized against the queue and job definition too, not only the new job.
    { Effect = "Allow", Action = "batch:TagResource", Resource = ["arn:aws:batch:${var.region}:${var.aws_account_id}:job/*", var.batch_job_queue, var.batch_job_definition], Condition = { StringEquals = { "aws:RequestTag/Project" = "qsb-gpu" }, "ForAllValues:StringEquals" = { "aws:TagKeys" = ["Project", "QsbRequest", "InputSha256"] } } },
    { Effect = "Allow", Action = ["batch:CancelJob", "batch:TerminateJob"], Resource = "arn:aws:batch:${var.region}:${var.aws_account_id}:job/*", Condition = { StringEquals = { "aws:ResourceTag/Project" = "qsb-gpu" } } },
    { Effect = "Allow", Action = "s3:PutObject", Resource = "arn:aws:s3:::${var.batch_job_bucket}/inputs/*" },
    { Effect = "Allow", Action = "s3:GetObject", Resource = "arn:aws:s3:::${var.batch_job_bucket}/outputs/*" }
  ] })
}
resource "aws_iam_role_policy" "reference" {
  role   = aws_iam_role.lambda["coordinator"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = aws_lambda_function.reference.arn }] })
}
# Only the API calls MARA Slipstream, so only it may read the one miner credential, when configured.
resource "aws_iam_role_policy" "miner_credential" {
  count  = var.slipstream_secret_arn == "" ? 0 : 1
  role   = aws_iam_role.lambda["api"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = var.slipstream_secret_arn }] })
}
resource "aws_iam_role_policy" "start" {
  role   = aws_iam_role.lambda["api"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "states:StartExecution", Resource = local.workflow_arn }] })
}
resource "aws_lambda_function" "reference" {
  function_name                  = "${var.name}-reference"
  role                           = aws_iam_role.lambda["reference"].arn
  runtime                        = "python3.13"
  architectures                  = ["arm64"]
  handler                        = "handler.handler"
  filename                       = "${local.artifacts}/reference.zip"
  source_code_hash               = filebase64sha256("${local.artifacts}/reference.zip")
  timeout                        = 25
  memory_size                    = 1024
  reserved_concurrent_executions = var.lambda_concurrency
  depends_on                     = [terraform_data.release, aws_iam_role_policy.logs]
}
resource "aws_lambda_function" "coordinator" {
  function_name                  = "${var.name}-coordinator"
  role                           = aws_iam_role.lambda["coordinator"].arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  filename                       = "${local.artifacts}/coordinator.zip"
  source_code_hash               = filebase64sha256("${local.artifacts}/coordinator.zip")
  timeout                        = 90
  memory_size                    = 512
  reserved_concurrent_executions = var.lambda_concurrency
  environment {
    variables = merge({ TABLE_NAME = aws_dynamodb_table.records.name, QSB_NETWORK = var.network, SOLVER_RELEASE_ID = local.solver_release_id, QSB_MAINNET_ENABLED = tostring(var.mainnet_enabled), REFERENCE_FUNCTION = aws_lambda_function.reference.function_name }, local.gpu_limit_env, local.owner_limit_env, local.compute ? { AWS_BATCH_JOB_QUEUE = var.batch_job_queue, AWS_BATCH_JOB_DEFINITION = var.batch_job_definition, AWS_BATCH_JOB_BUCKET = var.batch_job_bucket } : {})
  }
  depends_on = [terraform_data.release, aws_iam_role_policy.logs, aws_iam_role_policy.coordinator_records, aws_iam_role_policy.reference, aws_iam_role_policy.batch]
}
resource "aws_lambda_function" "api" {
  function_name                  = "${var.name}-api"
  role                           = aws_iam_role.lambda["api"].arn
  runtime                        = "nodejs22.x"
  architectures                  = ["arm64"]
  handler                        = "index.handler"
  filename                       = "${local.artifacts}/api.zip"
  source_code_hash               = filebase64sha256("${local.artifacts}/api.zip")
  timeout                        = 120
  memory_size                    = 512
  reserved_concurrent_executions = var.lambda_concurrency
  # JSON records keep a console call's sole object argument as its `message` object, so the
  # stray-payments metric filter (workflow.tf) can select a field no logged string can supply.
  # The flag is a console.warn, so the level must stay at WARN or below.
  logging_config {
    log_format            = "JSON"
    application_log_level = "INFO"
  }
  environment {
    variables = merge({ TABLE_NAME = aws_dynamodb_table.records.name, APP_ORIGIN = "https://${aws_cloudfront_distribution.web.domain_name}", QSB_EXACT_SUBMIT_ENABLED = tostring(var.exact_submit_enabled), WORKFLOW_ARN = local.workflow_arn, QSB_NETWORK = var.network, SOLVER_RELEASE_ID = local.solver_release_id, QSB_MAINNET_ENABLED = tostring(var.mainnet_enabled), QSB_API_KEYS_ENABLED = tostring(var.api_keys_enabled) }, local.owner_limit_env, var.slipstream_secret_arn == "" ? {} : { SLIPSTREAM_SECRET_ARN = var.slipstream_secret_arn })
  }
  depends_on = [terraform_data.release, aws_iam_role_policy.logs, aws_iam_role_policy.records, aws_iam_role_policy.start, aws_iam_role_policy.miner_credential]
}
