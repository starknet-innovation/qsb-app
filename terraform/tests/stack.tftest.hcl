mock_provider "aws" {
  mock_data "aws_partition" { defaults = { partition = "aws" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
}
variables {
  # Use the actual clean build selection. The same suite supports a null or an
  # enrolled solver without changing artifacts or performing another native build.
  solver_release_id       = try(jsondecode(file(".build/manifest.json")).identities.solver.id, "")
  operator_principal_arns = ["arn:aws:iam::123456789012:user/reconcile-test"]
  aws_account_id          = "123456789012"
  region                  = "eu-west-2"
  name                    = "qsb-test"
  network                 = "mainnet"
}
run "app_role_record_denies" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition = alltrue([
      for role in ["api"] :
      length([
        for statement in jsondecode(aws_iam_role_policy.records[role].policy).Statement : statement
        if statement.Sid == "DenyOutpointDelete" && statement.Effect == "Deny" && contains(statement.Action, "dynamodb:DeleteItem") && contains(try(statement.Condition["ForAnyValue:StringLike"]["dynamodb:LeadingKeys"], []), "OUTPOINT#*") && !contains(statement.Action, "dynamodb:PutItem")
        ]) == 1 && length([
        for statement in jsondecode(aws_iam_role_policy.records[role].policy).Statement : statement
        if statement.Sid == "DenySystemRowWrites" && statement.Effect == "Deny" && contains(statement.Action, "dynamodb:PutItem") && contains(statement.Action, "dynamodb:DeleteItem") && contains(try(statement.Condition["ForAnyValue:StringLike"]["dynamodb:LeadingKeys"], []), "SYSTEM#*")
        ]) == 1 && length([
        for statement in jsondecode(aws_iam_role_policy.records[role].policy).Statement : statement
        if statement.Sid == "TableDataAccess" && statement.Effect == "Allow" && contains(statement.Action, "dynamodb:PutItem") && contains(statement.Action, "dynamodb:ConditionCheckItem") && !contains(keys(statement), "Condition")
      ]) == 1
    ])
    error_message = "App roles must be able to create a reservation, must deny deleting one, and must deny system-row writes."
  }
}
run "coordinator_least_privilege" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[0].Action == ["dynamodb:GetItem"] && jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[1].Action == ["dynamodb:PutItem"] && jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[1].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] == ["OWNER#*", "WEBHOOK#*"] && jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[1].Condition.Null["dynamodb:LeadingKeys"] == "false" && length(jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement) == 2 && !contains(keys(aws_iam_role_policy.records), "coordinator")
    error_message = "Coordinator may only GetItem, and PutItem on present OWNER and WEBHOOK keys (the owner's webhook row)."
  }
}
run "baseline" {
  command = plan
  variables {
    network = "mainnet"
  }
  assert {
    condition     = output.transactions_enabled == false && output.compute_configured == false
    error_message = "Baseline must not activate transactions or configure paid compute."
  }
  assert {
    condition     = aws_dynamodb_table.records.deletion_protection_enabled && aws_dynamodb_table.records.point_in_time_recovery[0].enabled
    error_message = "Durable records require deletion protection and PITR."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.api.environment[0].variables), "RUNPOD_SECRET_ARN") && aws_lambda_function.api.environment[0].variables.QSB_REHEARSAL_ENABLED == "false"
    error_message = "The API must not receive the provider secret or enable rehearsal."
  }
  assert {
    condition     = !contains(keys(aws_lambda_function.api.environment[0].variables), "SUPERVISED_EXECUTION_ENABLED") && !contains(keys(aws_lambda_function.api.environment[0].variables), "SUPERVISED_DISPATCH_QUEUE_URL")
    error_message = "The default mainnet plan must not deploy the supervised runtime."
  }
  assert {
    condition     = aws_lambda_function.coordinator.timeout == 90 && jsondecode(aws_sfn_state_machine.withdrawal.definition).States.CoordinateSearch.TimeoutSeconds > aws_lambda_function.coordinator.timeout
    error_message = "Workflow timeout must cover the coordinator preflight and paid submission budget."
  }
  assert {
    # A throttled invoke never ran the coordinator, so it is the only error retried; the retrier is bounded.
    condition = try(
      length(jsondecode(aws_sfn_state_machine.withdrawal.definition).States.CoordinateSearch.Retry) == 1 &&
      jsondecode(aws_sfn_state_machine.withdrawal.definition).States.CoordinateSearch.Retry[0].ErrorEquals == ["Lambda.TooManyRequestsException"] &&
      jsondecode(aws_sfn_state_machine.withdrawal.definition).States.CoordinateSearch.Retry[0].MaxAttempts >= 1 &&
      jsondecode(aws_sfn_state_machine.withdrawal.definition).States.CoordinateSearch.Retry[0].MaxAttempts <= 10,
      false
    )
    error_message = "CoordinateSearch must retry only Lambda.TooManyRequestsException, a bounded number of times. Do not add generic automatic retries around billable coordination."
  }
  assert {
    condition = jsonencode(jsondecode(aws_sfn_state_machine.withdrawal.definition).States.CoordinateSearch.Catch) == jsonencode([
      { ErrorEquals = ["States.ALL"], ResultPath = "$.failure", Next = "NeedsOperatorAttention" }
    ])
    error_message = "Every other CoordinateSearch error, including an exhausted throttling retry, must end in NeedsOperatorAttention."
  }
  assert {
    # A Pass or Succeed here would end an unreconciled outcome as a succeeded execution, with no failure alarm.
    condition     = try(jsondecode(aws_sfn_state_machine.withdrawal.definition).States.NeedsOperatorAttention.Type == "Fail", false)
    error_message = "NeedsOperatorAttention must stay a Fail state, so the execution fails and the workflow-failures alarm fires."
  }
  assert {
    condition     = aws_lambda_function.coordinator.environment[0].variables.GPU_WORKERS_MAX == tostring(local.gpu_spend.workersMax) && local.gpu_spend.workersMax >= 1 && local.gpu_spend.workersMax <= 16 && aws_lambda_function.coordinator.environment[0].variables.GPU_WORKERS_MIN == "0" && aws_lambda_function.coordinator.environment[0].variables.GPU_EXECUTION_TIMEOUT_MS == tostring(local.gpu_spend.executionTimeoutMs) && aws_lambda_function.coordinator.environment[0].variables.MAX_JOB_GPU_SECONDS == (tostring(local.gpu_spend.maxJobGpuSeconds)) && output.gpu_limits.workersMax == local.gpu_spend.workersMax && output.gpu_limits.workersMin == 0 && output.gpu_limits.executionTimeoutMs == local.gpu_spend.executionTimeoutMs
    error_message = "Deployed configuration must show the reviewed workersMax (1-16), workersMin=0, and the execution timeout."
  }
  assert {
    condition = length(aws_cloudfront_distribution.web.ordered_cache_behavior) == 2 && alltrue([
      for pattern in ["/api/*", "/v1/*"] : length([
        for b in aws_cloudfront_distribution.web.ordered_cache_behavior : b
        if b.path_pattern == pattern && b.target_origin_id == "api" && b.viewer_protocol_policy == "https-only" && toset(b.allowed_methods) == toset(["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]) && toset(b.cached_methods) == toset(["GET", "HEAD"]) && b.cache_policy_id == data.aws_cloudfront_cache_policy.caching_disabled.id && b.origin_request_policy_id == data.aws_cloudfront_origin_request_policy.all_viewer_except_host_header.id
      ]) == 1
    ])
    error_message = "/api/* and /v1/* must both reach the API origin uncached, with the same policies."
  }
}
run "frontend_index_uploaded_on_its_own" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = aws_s3_object.index.key == "index.html" && !contains(keys(aws_s3_object.frontend), "index.html") && toset(concat(keys(aws_s3_object.frontend), [aws_s3_object.index.key])) == toset(local.build.frontend_files)
    error_message = "index.html is uploaded on its own; every other built file is an aws_s3_object.frontend object."
  }
  assert {
    # index.html waits for aws_s3_object.frontend, so every asset it names must be one of those objects, and no
    # other page may name a hashed asset.
    condition = length(regexall("\"/(assets/[^\"]+)\"", file("${local.artifacts}/frontend/index.html"))) > 0 && alltrue([
      for match in regexall("\"/(assets/[^\"]+)\"", file("${local.artifacts}/frontend/index.html")) : contains(keys(aws_s3_object.frontend), match[0])
      ]) && alltrue([
      for name in local.build.frontend_files : name == "index.html" || !endswith(name, ".html") || length(regexall("/assets/", file("${local.artifacts}/frontend/${name}"))) == 0
    ])
    error_message = "Only index.html may name hashed assets, and each one it names must be uploaded before it."
  }
  assert {
    condition     = aws_s3_object.index.cache_control == "no-cache,max-age=0,must-revalidate" && aws_s3_object.index.content_type == "text/html; charset=utf-8" && alltrue([for name, object in aws_s3_object.frontend : object.cache_control == (startswith(name, "assets/") ? "public,max-age=31536000,immutable" : "no-cache,max-age=0,must-revalidate")])
    error_message = "index.html revalidates on every request; only content-hashed assets/* are cached as immutable."
  }
}
run "reject_network_mismatch" {
  command = plan
  variables { network = "testnet4" }
  expect_failures = [terraform_data.release]
}
run "reject_partial_compute_config" {
  command = plan
  variables {
    network         = "mainnet"
    batch_job_queue = "arn:aws:batch:eu-west-2:123456789012:job-queue/qsb-gpu"
  }
  expect_failures = [terraform_data.release]
}
run "reject_wrong_commit" {
  command = plan
  variables {
    network       = "mainnet"
    source_commit = "0000000000000000000000000000000000000000"
  }
  expect_failures = [terraform_data.release]
}
run "ci_runtime_roles_are_bounded" {
  command = plan
  variables {
    network                      = "mainnet"
    iam_role_path                = "/qsb/runtime/"
    iam_permissions_boundary_arn = "arn:aws:iam::123456789012:policy/qsb/bootstrap/qsb-runtime-boundary"
  }
  assert {
    condition     = alltrue([for role in aws_iam_role.lambda : role.path == "/qsb/runtime/" && role.permissions_boundary == var.iam_permissions_boundary_arn]) && aws_iam_role.workflow.path == "/qsb/runtime/" && aws_iam_role.workflow.permissions_boundary == var.iam_permissions_boundary_arn
    error_message = "CI-created Lambda and workflow roles must keep the required path and boundary."
  }
}

run "configured_single_pipeline" {
  command = plan
  variables {
    network              = "mainnet"
    batch_job_queue      = "arn:aws:batch:eu-west-2:123456789012:job-queue/qsb-gpu"
    batch_job_definition = "arn:aws:batch:eu-west-2:123456789012:job-definition/qsb-gpu-solver:1"
    batch_job_bucket     = "qsb-gpu-123456789012-eu-west-2-jobs"
  }
  assert {
    condition     = output.compute_configured && !output.transactions_enabled && length(aws_iam_role_policy.batch) == 1 && aws_lambda_function.coordinator.environment[0].variables.AWS_BATCH_JOB_QUEUE == var.batch_job_queue && !contains(keys(aws_lambda_function.api.environment[0].variables), "AWS_BATCH_JOB_QUEUE") && length(aws_lambda_function.reference.environment) == 0
    error_message = "Only the coordinator receives paid compute bindings; configuration cannot activate mainnet."
  }
  assert {
    condition     = length(aws_iam_role.lambda) == 3 && toset(keys(aws_iam_role.lambda)) == toset(["api", "coordinator", "reference"]) && aws_lambda_function.coordinator.environment[0].variables.TABLE_NAME == aws_lambda_function.api.environment[0].variables.TABLE_NAME && aws_lambda_function.api.environment[0].variables.WORKFLOW_ARN == local.workflow_arn && aws_lambda_function.coordinator.environment[0].variables.REFERENCE_FUNCTION == aws_lambda_function.reference.function_name
    error_message = "Keep one coordinator pipeline, shared records and independent CPU verification."
  }
  assert {
    condition     = jsondecode(aws_sfn_state_machine.withdrawal.definition).StartAt == "CoordinateSearch" && aws_lambda_function.api.environment[0].variables.TABLE_NAME == aws_dynamodb_table.records.name
    error_message = "Keep the entry state and exact shared records table."
  }
  assert {
    condition = jsonencode(jsondecode(aws_iam_role_policy.batch[0].policy).Statement) == jsonencode([
      { Effect = "Allow", Action = ["batch:DescribeJobs", "batch:DescribeJobDefinitions", "batch:DescribeJobQueues", "batch:DescribeComputeEnvironments", "batch:ListJobs"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
      { Effect = "Allow", Action = "batch:SubmitJob", Resource = [var.batch_job_queue, var.batch_job_definition] },
      { Effect = "Allow", Action = "batch:TagResource", Resource = ["arn:aws:batch:${var.region}:${var.aws_account_id}:job/*", var.batch_job_queue, var.batch_job_definition], Condition = { StringEquals = { "aws:RequestTag/Project" = "qsb-gpu" }, "ForAllValues:StringEquals" = { "aws:TagKeys" = ["Project", "QsbRequest", "InputSha256"] } } },
      { Effect = "Allow", Action = ["batch:CancelJob", "batch:TerminateJob"], Resource = "arn:aws:batch:${var.region}:${var.aws_account_id}:job/*", Condition = { StringEquals = { "aws:ResourceTag/Project" = "qsb-gpu" } } },
      { Effect = "Allow", Action = "s3:PutObject", Resource = "arn:aws:s3:::${var.batch_job_bucket}/inputs/*" },
      { Effect = "Allow", Action = "s3:GetObject", Resource = "arn:aws:s3:::${var.batch_job_bucket}/outputs/*" }
    ])
    error_message = "Paid submission, tag/cancel and input/output permissions must remain exactly scoped."
  }

}
run "operator_reconcile_scope" {
  command = plan
  variables {
    network                      = "mainnet"
    batch_job_queue              = "arn:aws:batch:eu-west-2:123456789012:job-queue/qsb-gpu"
    batch_job_definition         = "arn:aws:batch:eu-west-2:123456789012:job-definition/qsb-gpu-solver:1"
    batch_job_bucket             = "qsb-gpu-123456789012-eu-west-2-jobs"
    operator_principal_arns      = ["arn:aws:iam::123456789012:user/alice", "arn:aws:iam::123456789012:role/operators"]
    iam_role_path                = "/qsb/runtime/"
    iam_permissions_boundary_arn = "arn:aws:iam::123456789012:policy/qsb/bootstrap/qsb-runtime-boundary"
  }
  assert {
    condition     = jsondecode(aws_iam_role.operator_reconcile.assume_role_policy).Statement[0].Condition.Bool["aws:MultiFactorAuthPresent"] == "true" && aws_iam_role.operator_reconcile.path == var.iam_role_path && aws_iam_role.operator_reconcile.permissions_boundary == var.iam_permissions_boundary_arn
    error_message = "Human MFA and the administrator boundary remain required."
  }
  assert {
    condition     = toset(flatten([for s in jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement : s.Action])) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "states:StartExecution", "batch:DescribeJobs", "batch:ListJobs", "batch:DescribeJobQueues", "s3:GetObject"]) && alltrue([for s in slice(jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement, 0, 2) : s.Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] == ["OWNER#*"] && s.Condition.Null["dynamodb:LeadingKeys"] == "false"])
    error_message = "The operator can reconcile OWNER records and read results, never submit paid jobs or write system/outpoint rows."
  }
  assert {
    condition = jsonencode(jsondecode(aws_iam_role.operator_reconcile.assume_role_policy).Statement) == jsonencode([{
      Effect = "Allow", Principal = { AWS = sort(tolist(var.operator_principal_arns)) }, Action = "sts:AssumeRole", Condition = { Bool = { "aws:MultiFactorAuthPresent" = "true" } }
    }])
    error_message = "Only the exact configured principals with MFA may assume the operator role."
  }
  assert {
    condition = jsonencode(jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement) == jsonencode([
      { Sid = "ReadOwnedRecords", Effect = "Allow", Action = ["dynamodb:GetItem"], Resource = "arn:aws:dynamodb:${var.region}:${var.aws_account_id}:table/${aws_dynamodb_table.records.name}", Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["OWNER#*"] }, Null = { "dynamodb:LeadingKeys" = "false" } } },
      { Sid = "ReconcileOwnedJobAndAudit", Effect = "Allow", Action = ["dynamodb:PutItem"], Resource = "arn:aws:dynamodb:${var.region}:${var.aws_account_id}:table/${aws_dynamodb_table.records.name}", Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["OWNER#*"] }, Null = { "dynamodb:LeadingKeys" = "false" } } },
      { Sid = "StartCoordinator", Effect = "Allow", Action = ["states:StartExecution"], Resource = local.workflow_arn },
      { Effect = "Allow", Action = ["batch:DescribeJobs", "batch:ListJobs", "batch:DescribeJobQueues"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
      { Effect = "Allow", Action = "s3:GetObject", Resource = "arn:aws:s3:::${var.batch_job_bucket}/outputs/*" }
    ])
    error_message = "Operator statements must retain exact actions, effects, resources and conditions; never SubmitJob."
  }

}
run "operator_without_provider" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = length(jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement) == 3
    error_message = "No provider permissions without complete configuration."
  }
}
run "reject_operator_wildcard" {
  command = plan
  variables {
    network                 = "mainnet"
    operator_principal_arns = ["arn:aws:iam::123456789012:user/*"]
  }
  expect_failures = [var.operator_principal_arns]
}
run "reject_operator_empty" {
  command = plan
  variables {
    network                 = "mainnet"
    operator_principal_arns = []
  }
  expect_failures = [var.operator_principal_arns]
}

run "reject_provider_definition_wildcard" {
  command = plan
  variables {
    network              = "mainnet"
    batch_job_definition = "arn:aws:batch:eu-west-2:123456789012:job-definition/qsb-*"
  }
  expect_failures = [var.batch_job_definition]
}
run "miner_credential_default_off" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = length(aws_iam_role_policy.miner_credential) == 0 && !contains(keys(aws_lambda_function.api.environment[0].variables), "SLIPSTREAM_SECRET_ARN") && !contains(keys(aws_lambda_function.coordinator.environment[0].variables), "SLIPSTREAM_SECRET_ARN") && length(aws_lambda_function.reference.environment) == 0
    error_message = "Without a configured secret, no role may read a miner credential and no Lambda receives one."
  }
}
run "miner_credential_api_only" {
  command = plan
  variables {
    network               = "mainnet"
    slipstream_secret_arn = "arn:aws:secretsmanager:eu-west-2:123456789012:secret:qsb/slipstream-AbC123"
  }
  assert {
    condition = length(aws_iam_role_policy.miner_credential) == 1 && jsonencode(jsondecode(aws_iam_role_policy.miner_credential[0].policy).Statement) == jsonencode([
      { Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = var.slipstream_secret_arn }
    ])
    error_message = "The miner credential grant must be exactly GetSecretValue on the configured secret."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.SLIPSTREAM_SECRET_ARN == var.slipstream_secret_arn && !contains(keys(aws_lambda_function.coordinator.environment[0].variables), "SLIPSTREAM_SECRET_ARN") && length(aws_lambda_function.reference.environment) == 0 && !output.transactions_enabled && !output.exact_submit_enabled
    error_message = "Only the API receives the miner credential reference, and configuring it activates nothing."
  }
}
run "reject_miner_credential_other_secret" {
  command = plan
  variables {
    network               = "mainnet"
    slipstream_secret_arn = "arn:aws:secretsmanager:eu-west-2:123456789012:secret:qsb/other-AbC123"
  }
  expect_failures = [var.slipstream_secret_arn]
}
run "reject_miner_credential_other_account" {
  command = plan
  variables {
    network               = "mainnet"
    slipstream_secret_arn = "arn:aws:secretsmanager:eu-west-2:210987654321:secret:qsb/slipstream-AbC123"
  }
  expect_failures = [var.slipstream_secret_arn]
}
run "reject_miner_credential_other_region" {
  command = plan
  variables {
    network               = "mainnet"
    slipstream_secret_arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:qsb/slipstream-AbC123"
  }
  expect_failures = [var.slipstream_secret_arn]
}
run "reject_miner_credential_legacy_region" {
  command = plan
  variables {
    network               = "mainnet"
    slipstream_secret_arn = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:qsb/slipstream-AbC123"
  }
  expect_failures = [var.slipstream_secret_arn]
}
run "reject_batch_binding_other_region" {
  command = plan
  variables {
    network              = "mainnet"
    batch_job_queue      = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu"
    batch_job_definition = "arn:aws:batch:eu-west-1:123456789012:job-definition/qsb-gpu-solver:1"
    batch_job_bucket     = "qsb-gpu-123456789012-eu-west-1-jobs"
  }
  expect_failures = [var.batch_job_queue, var.batch_job_definition, var.batch_job_bucket]
}
run "reject_batch_binding_other_account" {
  command = plan
  variables {
    network              = "mainnet"
    batch_job_queue      = "arn:aws:batch:eu-west-2:210987654321:job-queue/qsb-gpu"
    batch_job_definition = "arn:aws:batch:eu-west-2:210987654321:job-definition/qsb-gpu-solver:1"
    batch_job_bucket     = "qsb-gpu-210987654321-eu-west-2-jobs"
  }
  expect_failures = [var.batch_job_queue, var.batch_job_definition, var.batch_job_bucket]
}
run "freeze_throttles_every_function" {
  command = plan
  variables {
    network            = "mainnet"
    lambda_concurrency = 0
  }
  assert {
    condition     = aws_lambda_function.api.reserved_concurrent_executions == 0 && aws_lambda_function.coordinator.reserved_concurrent_executions == 0 && aws_lambda_function.reference.reserved_concurrent_executions == 0
    error_message = "A freeze must throttle every application function, so nothing writes the records table."
  }
}
run "reject_negative_concurrency" {
  command = plan
  variables {
    network            = "mainnet"
    lambda_concurrency = -1
  }
  expect_failures = [var.lambda_concurrency]
}
run "region_is_pinned" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = terraform_data.region_pin.triggers_replace == "eu-west-2"
    error_message = "The state must be pinned to its region, so a region change can't replan the stack elsewhere."
  }
}
run "reject_malformed_region" {
  command = plan
  variables {
    network = "mainnet"
    region  = "London"
  }
  expect_failures = [var.region]
}
run "exact_submit_default_off" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = !output.exact_submit_enabled && aws_lambda_function.api.environment[0].variables.QSB_EXACT_SUBMIT_ENABLED == "false"
    error_message = "The exact submit switch must default off."
  }
}
run "exact_submit_explicit_switch" {
  command = plan
  variables {
    network              = "mainnet"
    exact_submit_enabled = true
  }
  assert {
    condition     = !output.exact_submit_enabled && aws_lambda_function.api.environment[0].variables.QSB_EXACT_SUBMIT_ENABLED == "true" && !output.transactions_enabled
    error_message = "A submit request cannot enable the effective submit output while mainnet is disabled."
  }
}
run "api_keys_default_off" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.QSB_API_KEYS_ENABLED == "false" && !contains(keys(aws_lambda_function.coordinator.environment[0].variables), "QSB_API_KEYS_ENABLED") && length(aws_lambda_function.reference.environment) == 0
    error_message = "API keys must default off, on the API Lambda only."
  }
}
run "api_keys_explicit_switch" {
  command = plan
  variables {
    network          = "mainnet"
    api_keys_enabled = true
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.QSB_API_KEYS_ENABLED == "true" && !contains(keys(aws_lambda_function.coordinator.environment[0].variables), "QSB_API_KEYS_ENABLED") && !output.transactions_enabled && !output.exact_submit_enabled && aws_lambda_function.api.environment[0].variables.QSB_MAINNET_ENABLED == "false" && aws_lambda_function.api.environment[0].variables.QSB_EXACT_SUBMIT_ENABLED == "false"
    error_message = "The API key switch reaches only the API Lambda and changes no mainnet switch."
  }
}
run "exact_submit_reject_testnet" {
  command = plan
  variables {
    network              = "testnet4"
    exact_submit_enabled = true
  }
  expect_failures = [var.exact_submit_enabled, terraform_data.release]
}

run "reject_solver_release_not_selected_by_build" {
  command = plan
  variables {
    solver_release_id = "qsb-reviewed-release"
    network           = "mainnet"
  }
  expect_failures = [terraform_data.release]
}
run "solver_release_shared_from_build" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.SOLVER_RELEASE_ID == local.solver_release_id && aws_lambda_function.coordinator.environment[0].variables.SOLVER_RELEASE_ID == local.solver_release_id
    error_message = "API admission and coordinator must consume the same generated build identity."
  }
}

run "solver_release_preserves_generated_selection_or_null" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.SOLVER_RELEASE_ID == try(local.build.identities.solver.id, "") && aws_lambda_function.coordinator.environment[0].variables.SOLVER_RELEASE_ID == try(local.build.identities.solver.id, "")
    error_message = "The build selection must remain exact, including an empty value for a null solver."
  }
}

run "mainnet_defaults_off" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = !output.transactions_enabled && aws_lambda_function.api.environment[0].variables.QSB_MAINNET_ENABLED == "false" && aws_lambda_function.coordinator.environment[0].variables.QSB_MAINNET_ENABLED == "false"
    error_message = "Both mainnet entry points must default disabled."
  }
}
run "mainnet_on_submit_off" {
  command = plan
  variables {
    network         = "mainnet"
    mainnet_enabled = true
  }
  assert {
    condition     = output.transactions_enabled && !output.exact_submit_enabled && aws_lambda_function.api.environment[0].variables.QSB_MAINNET_ENABLED == "true" && aws_lambda_function.coordinator.environment[0].variables.QSB_MAINNET_ENABLED == "true"
    error_message = "Funding and search must share the mainnet switch without enabling submission."
  }
}
run "mainnet_and_submit_on" {
  command = plan
  variables {
    network              = "mainnet"
    mainnet_enabled      = true
    exact_submit_enabled = true
  }
  assert {
    condition     = output.transactions_enabled && output.exact_submit_enabled
    error_message = "Both switches can be configured explicitly from the same release package."
  }
}
run "mainnet_reject_testnet" {
  command = plan
  variables {
    mainnet_enabled = true
    network         = "testnet4"
  }
  expect_failures = [var.mainnet_enabled, terraform_data.release]
}

run "owner_limits_default_off" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = length([for key in concat(keys(aws_lambda_function.api.environment[0].variables), keys(aws_lambda_function.coordinator.environment[0].variables)) : key if startswith(key, "QSB_OWNER_")]) == 0
    error_message = "Unset owner limits must add nothing to either Lambda environment."
  }
}
run "owner_limits_api_and_coordinator_only" {
  command = plan
  variables {
    network               = "mainnet"
    owner_allowlist       = ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "bc1qexamplepartner0000000000"]
    owner_max_active_jobs = 2
    owner_max_gpu_seconds = 1474560
  }
  assert {
    condition = alltrue([
      for env in [aws_lambda_function.api.environment[0].variables, aws_lambda_function.coordinator.environment[0].variables] :
      env.QSB_OWNER_ALLOWLIST == "bc1qexamplepartner0000000000,bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" && env.QSB_OWNER_MAX_ACTIVE_JOBS == "2" && env.QSB_OWNER_MAX_GPU_SECONDS == "1474560"
    ]) && length(aws_lambda_function.reference.environment) == 0 && !output.transactions_enabled && !output.exact_submit_enabled
    error_message = "Owner limits reach the API and coordinator only, and setting them activates nothing."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[0].Action == ["dynamodb:GetItem"] && jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[1].Action == ["dynamodb:PutItem"] && length(jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement) == 2
    error_message = "Owner limits need no new coordinator grant: its budget row is an OWNER# PutItem."
  }
}
run "reject_owner_allowlist_separator" {
  command = plan
  variables {
    network         = "mainnet"
    owner_allowlist = ["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4,bc1qexamplepartner0000000000"]
  }
  expect_failures = [var.owner_allowlist]
}
run "reject_owner_active_jobs_fraction" {
  command = plan
  variables {
    network               = "mainnet"
    owner_max_active_jobs = 1.5
  }
  expect_failures = [var.owner_max_active_jobs]
}
run "reject_owner_active_jobs_unsafe_integer" {
  command = plan
  variables {
    network               = "mainnet"
    owner_max_active_jobs = 9007199254740992
  }
  expect_failures = [var.owner_max_active_jobs]
}
run "reject_owner_gpu_seconds_below_one_submission" {
  command = plan
  variables {
    network               = "mainnet"
    owner_max_gpu_seconds = 899
  }
  expect_failures = [var.owner_max_gpu_seconds]
}
run "owner_gpu_seconds_one_submission" {
  command = plan
  variables {
    network               = "mainnet"
    owner_max_gpu_seconds = 900
  }
  assert {
    condition     = aws_lambda_function.coordinator.environment[0].variables.QSB_OWNER_MAX_GPU_SECONDS == "900"
    error_message = "One submission's reservation is the smallest owner budget."
  }
}
run "reject_owner_allowlist_over_environment_room" {
  command = plan
  variables {
    network         = "mainnet"
    owner_allowlist = [for i in range(60) : format("bc1q%038d", i)]
  }
  expect_failures = [var.owner_allowlist]
}
run "owner_allowlist_within_environment_room" {
  command = plan
  variables {
    network         = "mainnet"
    owner_allowlist = [for i in range(58) : format("bc1q%038d", i)]
  }
  assert {
    condition     = length(aws_lambda_function.coordinator.environment[0].variables.QSB_OWNER_ALLOWLIST) <= 2500 && length(split(",", aws_lambda_function.api.environment[0].variables.QSB_OWNER_ALLOWLIST)) == 58
    error_message = "A list within the bound reaches both Lambdas whole."
  }
}

run "reject_provider_queue_wildcard" {
  command = plan
  variables {
    network         = "mainnet"
    batch_job_queue = "arn:aws:batch:eu-west-2:123456789012:job-queue/qsb-*"
  }
  expect_failures = [var.batch_job_queue]
}
run "reject_provider_bucket_wildcard" {
  command = plan
  variables {
    network          = "mainnet"
    batch_job_bucket = "qsb-*"
  }
  expect_failures = [var.batch_job_bucket]
}

run "reject_changed_solver_selection_including_omission" {
  command = plan
  variables {
    network           = "mainnet"
    solver_release_id = try(jsondecode(file(".build/manifest.json")).identities.solver.id, "") == "" ? "not-selected-by-build" : ""
  }
  expect_failures = [terraform_data.release]
}

run "reject_reference_identity_mismatch" {
  command = plan
  variables {
    network             = "mainnet"
    build_manifest_path = ".build/test-bad-reference.json"
  }
  expect_failures = [terraform_data.release]
}

run "reject_manifest_solver_override" {
  command = plan
  variables {
    network             = "mainnet"
    build_manifest_path = ".build/test-bad-solver.json"
  }
  expect_failures = [terraform_data.release]
}

run "webhook_dispatcher_default_off" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = length(aws_lambda_function.webhooks) == 0 && length(aws_lambda_function_event_invoke_config.webhooks) == 0 && length(aws_scheduler_schedule.webhooks) == 0 && length(aws_iam_role.webhook_schedule) == 0 && length(aws_iam_role_policy.webhook_schedule) == 0 && length(aws_iam_role_policy.webhook_records) == 0 && toset(keys(aws_iam_role.lambda)) == toset(["api", "coordinator", "reference"])
    error_message = "With the switch off, no dispatcher, invoke setting, schedule or role is planned."
  }
  assert {
    condition = length(aws_dynamodb_table.records.global_secondary_index) == 1 && alltrue([
      for index in aws_dynamodb_table.records.global_secondary_index : index.name == "webhook-due" && index.projection_type == "KEYS_ONLY" && length(coalesce(index.non_key_attributes, [])) == 0 && jsonencode([for key in index.key_schema : [key.attribute_name, key.key_type]]) == jsonencode([["webhookQueue", "HASH"], ["webhookDueAt", "RANGE"]])
    ]) && toset([for a in aws_dynamodb_table.records.attribute : "${a.name}:${a.type}"]) == toset(["pk:S", "sk:S", "webhookQueue:S", "webhookDueAt:N"]) && aws_dynamodb_table.records.deletion_protection_enabled && aws_dynamodb_table.records.point_in_time_recovery[0].enabled
    error_message = "The keys-only due-delivery index is the table's only index whatever the switch, so a query of it returns no hook, secret or event; the table stays protected."
  }
}
run "webhook_dispatcher_enabled" {
  command = plan
  variables {
    network                      = "mainnet"
    webhook_dispatcher_enabled   = true
    iam_role_path                = "/qsb/runtime/"
    iam_permissions_boundary_arn = "arn:aws:iam::123456789012:policy/qsb/bootstrap/qsb-runtime-boundary"
  }
  assert {
    condition     = aws_scheduler_schedule.webhooks[0].name == "qsb-test-webhooks" && aws_scheduler_schedule.webhooks[0].schedule_expression == "rate(5 minutes)" && aws_scheduler_schedule.webhooks[0].flexible_time_window[0].mode == "OFF" && aws_scheduler_schedule.webhooks[0].target[0].arn == "arn:aws:lambda:eu-west-1:123456789012:function:${aws_lambda_function.webhooks[0].function_name}" && aws_scheduler_schedule.webhooks[0].target[0].retry_policy[0].maximum_retry_attempts == 0 && try(aws_scheduler_schedule.webhooks[0].target[0].input, null) == null && length(aws_scheduler_schedule.webhooks[0].target[0].dead_letter_config) == 0 && length(aws_scheduler_schedule.webhooks[0].target[0].sqs_parameters) == 0 && length(aws_scheduler_schedule.webhooks[0].target[0].ecs_parameters) == 0
    error_message = "Every 5 minutes the schedule invokes the dispatcher, with no input, no retry, no dead-letter queue and no target parameters."
  }
  assert {
    condition     = aws_lambda_function_event_invoke_config.webhooks[0].function_name == aws_lambda_function.webhooks[0].function_name && aws_lambda_function_event_invoke_config.webhooks[0].maximum_retry_attempts == 0 && aws_lambda_function_event_invoke_config.webhooks[0].maximum_event_age_in_seconds == 300 && try(aws_lambda_function_event_invoke_config.webhooks[0].qualifier, null) == null && length(aws_lambda_function_event_invoke_config.webhooks[0].destination_config) == 0
    error_message = "Lambda doesn't retry a failed dispatcher run (the next scheduled run does), and sends its results nowhere."
  }
  assert {
    condition = jsonencode(jsondecode(aws_iam_role.webhook_schedule[0].assume_role_policy).Statement) == jsonencode([
      { Effect = "Allow", Principal = { Service = "scheduler.amazonaws.com" }, Action = "sts:AssumeRole", Condition = { StringEquals = { "aws:SourceAccount" = var.aws_account_id } } }
      ]) && jsonencode(jsondecode(aws_iam_role_policy.webhook_schedule[0].policy).Statement) == jsonencode([
      { Effect = "Allow", Action = "lambda:InvokeFunction", Resource = "arn:aws:lambda:eu-west-1:123456789012:function:qsb-test-webhooks" }
    ])
    error_message = "Only EventBridge Scheduler in this account can use the schedule role, and it can only invoke the dispatcher."
  }
  assert {
    condition = jsonencode(jsondecode(aws_iam_role_policy.webhook_records[0].policy).Statement) == jsonencode([
      { Sid = "FindDueOwners", Effect = "Allow", Action = ["dynamodb:Query"], Resource = "arn:aws:dynamodb:eu-west-1:123456789012:table/qsb-test-records/index/webhook-due" },
      { Sid = "ReadWriteWebhookRows", Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem"], Condition = { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["WEBHOOK#*"] }, Null = { "dynamodb:LeadingKeys" = "false" } }, Resource = "arn:aws:dynamodb:eu-west-1:123456789012:table/qsb-test-records" }
    ])
    error_message = "The dispatcher may only query the due-delivery index and read and write WEBHOOK# rows: no job, vault, intent, event or reservation row."
  }
  assert {
    condition     = toset(keys(aws_iam_role.lambda)) == toset(["api", "coordinator", "reference", "webhooks"]) && alltrue([for role in concat(values(aws_iam_role.lambda), aws_iam_role.webhook_schedule) : role.path == "/qsb/runtime/" && role.permissions_boundary == var.iam_permissions_boundary_arn]) && contains(keys(aws_iam_role_policy.logs), "webhooks") && contains(keys(aws_cloudwatch_metric_alarm.lambda_errors), "webhooks") && contains(keys(aws_cloudwatch_log_group.lambda), "webhooks") && !contains(keys(aws_iam_role_policy.records), "webhooks")
    error_message = "Both new roles keep the runtime path and boundary; the dispatcher gets logs and an error alarm, and not the API's record grant."
  }
  assert {
    condition     = aws_lambda_function.webhooks[0].function_name == "qsb-test-webhooks" && aws_lambda_function.webhooks[0].handler == "index.handler" && aws_lambda_function.webhooks[0].timeout == 60 && aws_lambda_function.webhooks[0].reserved_concurrent_executions == 1 && aws_lambda_function.webhooks[0].environment[0].variables == tomap({ TABLE_NAME = aws_dynamodb_table.records.name })
    error_message = "The dispatcher runs one at a time and gets only the table name: no mainnet, workflow, compute or credential setting."
  }
  assert {
    condition     = length(aws_dynamodb_table.records.global_secondary_index) == 1 && jsonencode(jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement) == jsonencode([for s in jsondecode(file("policies/coordinator-records.json")) : merge(s, { Resource = "arn:aws:dynamodb:eu-west-1:123456789012:table/qsb-test-records" })]) && jsonencode(jsondecode(aws_iam_role_policy.records["api"].policy).Statement) == jsonencode([for s in jsondecode(file("policies/app-records.json")) : merge(s, { Resource = "arn:aws:dynamodb:eu-west-1:123456789012:table/qsb-test-records" })]) && !output.transactions_enabled && !output.exact_submit_enabled && aws_lambda_function.api.environment[0].variables.QSB_MAINNET_ENABLED == "false" && aws_lambda_function.coordinator.environment[0].variables.QSB_MAINNET_ENABLED == "false"
    error_message = "Enabling the dispatcher adds no index and changes no API or coordinator grant and no mainnet switch."
  }
}
