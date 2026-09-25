mock_provider "aws" {
  mock_data "aws_ami" { defaults = { id = "ami-0123456789abcdef0" } }
  mock_data "aws_partition" { defaults = { partition = "aws" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
}
variables {
  aws_account_id = "123456789012"
  name           = "qsb-test"
  network        = "mainnet"
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
    condition = jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[0].Action == ["dynamodb:GetItem"] && jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[1].Action == ["dynamodb:PutItem"] && jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[1].Condition["ForAllValues:StringLike"]["dynamodb:LeadingKeys"] == ["OWNER#*"] && jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement[1].Condition.Null["dynamodb:LeadingKeys"] == "false" && length(jsondecode(aws_iam_role_policy.coordinator_records.policy).Statement) == 2 && !contains(keys(aws_iam_role_policy.records), "coordinator")
    error_message = "Coordinator may only GetItem and PutItem on present OWNER keys."
  }
}
run "baseline" {
  command = plan
  variables {
    network = "mainnet"
  }
  assert {
    condition     = output.transactions_enabled == false && output.runpod_configured == false
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
    condition     = length(aws_instance.runtime) == 0 && !contains(keys(aws_lambda_function.api.environment[0].variables), "SUPERVISED_EXECUTION_ENABLED") && !contains(keys(aws_lambda_function.api.environment[0].variables), "SUPERVISED_DISPATCH_QUEUE_URL")
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
    condition     = aws_lambda_function.coordinator.environment[0].variables.RUNPOD_WORKERS_MAX == "1" && aws_lambda_function.coordinator.environment[0].variables.RUNPOD_WORKERS_MIN == "0" && aws_lambda_function.coordinator.environment[0].variables.RUNPOD_EXECUTION_TIMEOUT_MS == tostring(local.gpu_spend.executionTimeoutMs) && aws_lambda_function.coordinator.environment[0].variables.MAX_JOB_GPU_SECONDS == (tostring(local.gpu_spend.maxJobGpuSeconds)) && output.runpod_limits.workersMax == 1 && output.runpod_limits.workersMin == 0 && output.runpod_limits.executionTimeoutMs == local.gpu_spend.executionTimeoutMs
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
    network            = "mainnet"
    runpod_endpoint_id = "exampleendpoint"
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
run "reject_mainnet_supervised_runtime" {
  command = plan
  variables {
    network                   = "mainnet"
    provision_runtime         = true
    runtime_ami_id            = "ami-0123456789abcdef0"
    runtime_ami_owner         = "123456789012"
    runtime_availability_zone = "eu-west-1a"
    runpod_endpoint_id        = "exampleendpoint"
    runpod_secret_arn         = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:test-Example"
    cleanup_endpoints         = { disposabletest1 = { delete_after = "2026-09-24T20:00:00Z" } }
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
