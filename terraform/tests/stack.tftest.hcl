mock_provider "aws" {
  mock_data "aws_partition" { defaults = { partition = "aws" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
}
variables {
  operator_principal_arns = ["arn:aws:iam::123456789012:user/reconcile-test"]
  aws_account_id          = "123456789012"
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
    condition     = jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[0].Action == ["dynamodb:GetItem"] && jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[1].Action == ["dynamodb:PutItem"] && jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[1].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] == ["OWNER#*"] && jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[1].Condition.Null["dynamodb:LeadingKeys"] == "false" && length(jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement) == 2 && !contains(keys(aws_iam_role_policy.records), "coordinator")
    error_message = "Coordinator may only GetItem and PutItem on present OWNER keys."
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
    condition     = !can(jsondecode(aws_sfn_state_machine.withdrawal.definition).States.CoordinateSearch.Retry)
    error_message = "Do not add generic automatic retries around billable coordination."
  }
  assert {
    condition     = aws_lambda_function.coordinator.environment[0].variables.GPU_WORKERS_MAX == "1" && aws_lambda_function.coordinator.environment[0].variables.GPU_WORKERS_MIN == "0" && aws_lambda_function.coordinator.environment[0].variables.GPU_EXECUTION_TIMEOUT_MS == tostring(local.gpu_spend.executionTimeoutMs) && aws_lambda_function.coordinator.environment[0].variables.MAX_JOB_GPU_SECONDS == (tostring(local.gpu_spend.maxJobGpuSeconds)) && output.gpu_limits.workersMax == 1 && output.gpu_limits.workersMin == 0 && output.gpu_limits.executionTimeoutMs == local.gpu_spend.executionTimeoutMs
    error_message = "Deployed configuration must show workersMax=1, workersMin=0, and the execution timeout."
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
    batch_job_queue = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu"
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
    batch_job_queue      = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu"
    batch_job_definition = "arn:aws:batch:eu-west-1:123456789012:job-definition/qsb-gpu-solver:1"
    batch_job_bucket     = "qsb-gpu-jobs"
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
      { Effect = "Allow", Action = "batch:TagResource", Resource = "arn:aws:batch:${var.region}:${var.aws_account_id}:job/*", Condition = { StringEquals = { "aws:RequestTag/Project" = "qsb-gpu" }, "ForAllValues:StringEquals" = { "aws:TagKeys" = ["Project", "QsbRequest", "InputSha256"] } } },
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
    batch_job_queue              = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-gpu"
    batch_job_definition         = "arn:aws:batch:eu-west-1:123456789012:job-definition/qsb-gpu-solver:1"
    batch_job_bucket             = "qsb-gpu-jobs"
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
    batch_job_definition = "arn:aws:batch:eu-west-1:123456789012:job-definition/qsb-*"
  }
  expect_failures = [var.batch_job_definition]
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
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.SOLVER_RELEASE_ID == local.solver_release_id && aws_lambda_function.coordinator.environment[0].variables.SOLVER_RELEASE_ID == local.solver_release_id
    error_message = "API admission and coordinator must consume the same generated build identity."
  }
}

run "solver_release_defaults_unconfigured" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.SOLVER_RELEASE_ID == "" && aws_lambda_function.coordinator.environment[0].variables.SOLVER_RELEASE_ID == ""
    error_message = "A runnable release must never be silently selected by infrastructure defaults."
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

run "reject_provider_queue_wildcard" {
  command = plan
  variables {
    network         = "mainnet"
    batch_job_queue = "arn:aws:batch:eu-west-1:123456789012:job-queue/qsb-*"
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
