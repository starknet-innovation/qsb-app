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
    network            = "mainnet"
    runpod_endpoint_id = "exampleendpoint"
    runpod_secret_arn  = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:qsb/runpod-Example"
  }
  assert {
    condition     = output.runpod_configured && output.transactions_enabled == false && length(aws_iam_role_policy.runpod) == 1 && length(jsondecode(aws_iam_role_policy.runpod[0].policy).Statement) == 1 && jsondecode(aws_iam_role_policy.runpod[0].policy).Statement[0].Effect == "Allow" && jsondecode(aws_iam_role_policy.runpod[0].policy).Statement[0].Resource == var.runpod_secret_arn && toset(try(tolist(jsondecode(aws_iam_role_policy.runpod[0].policy).Statement[0].Action), [jsondecode(aws_iam_role_policy.runpod[0].policy).Statement[0].Action])) == toset(["secretsmanager:GetSecretValue"])
    error_message = "Only one provider-key reference may be enrolled; configuration must not activate transactions."
  }
  assert {
    condition     = aws_lambda_function.coordinator.environment[0].variables.RUNPOD_SECRET_ARN == var.runpod_secret_arn && !contains(keys(aws_lambda_function.api.environment[0].variables), "RUNPOD_SECRET_ARN") && length(aws_lambda_function.reference.environment) == 0 && aws_lambda_function.coordinator.environment[0].variables.TABLE_NAME == aws_lambda_function.api.environment[0].variables.TABLE_NAME && aws_lambda_function.api.environment[0].variables.TABLE_NAME == aws_dynamodb_table.records.name
    error_message = "API and coordinator must share the one table; only coordinator receives the provider reference."
  }
  assert {
    condition     = length(aws_iam_role.lambda) == 3 && toset(keys(aws_iam_role.lambda)) == toset(["api", "coordinator", "reference"]) && aws_lambda_function.api.environment[0].variables.WORKFLOW_ARN == local.workflow_arn && aws_lambda_function.coordinator.environment[0].variables.REFERENCE_FUNCTION == aws_lambda_function.reference.function_name && jsondecode(aws_sfn_state_machine.withdrawal.definition).StartAt == "CoordinateSearch"
    error_message = "Keep the API-to-workflow-to-coordinator path and its CPU reference Lambda."
  }
}

run "operator_reconcile_scope" {
  command = plan
  variables {
    network                      = "mainnet"
    operator_principal_arns      = ["arn:aws:iam::123456789012:user/alice", "arn:aws:iam::123456789012:role/operators"]
    runpod_endpoint_id           = "exampleendpoint"
    runpod_secret_arn            = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:qsb/runpod-Example"
    runpod_secret_kms_key_arn    = "arn:aws:kms:eu-west-1:123456789012:key/mrk-11111111111111111111111111111111"
    iam_role_path                = "/qsb/runtime/"
    iam_permissions_boundary_arn = "arn:aws:iam::123456789012:policy/qsb/bootstrap/qsb-runtime-boundary"
  }
  assert {
    condition = length(jsondecode(aws_iam_role.operator_reconcile.assume_role_policy).Statement) == 1 && jsonencode(jsondecode(aws_iam_role.operator_reconcile.assume_role_policy).Statement[0]) == jsonencode({
      Effect = "Allow", Principal = { AWS = sort(tolist(var.operator_principal_arns)) }, Action = "sts:AssumeRole", Condition = { Bool = { "aws:MultiFactorAuthPresent" = "true" } }
    })
    error_message = "Only the explicit principals with MFA may assume the role."
  }
  assert {
    condition     = aws_iam_role.operator_reconcile.path == var.iam_role_path && aws_iam_role.operator_reconcile.permissions_boundary == var.iam_permissions_boundary_arn
    error_message = "The operator role must retain the configured path and permissions boundary."
  }
  assert {
    condition = length(jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement) == 5 && alltrue([
      for s in slice(jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement, 0, 2) :
      s.Effect == "Allow" && s.Resource == "arn:aws:dynamodb:${var.region}:${var.aws_account_id}:table/${aws_dynamodb_table.records.name}" && s.Condition == {
        "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["OWNER#*"] }, Null = { "dynamodb:LeadingKeys" = "false" }
      }
    ]) && jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement[0].Action == ["dynamodb:GetItem"] && jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement[1].Action == ["dynamodb:PutItem"]
    error_message = "Get/Put must be restricted to present OWNER keys; SYSTEM, OUTPOINT and mixed transactions cannot match."
  }
  assert {
    condition     = toset(flatten([for s in jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement : s.Action])) == toset(["dynamodb:GetItem", "dynamodb:PutItem", "states:StartExecution", "secretsmanager:GetSecretValue", "kms:Decrypt"]) && alltrue([for s in jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement : s.Effect == "Allow"])
    error_message = "No UpdateItem, DeleteItem, BatchWriteItem, Query, Scan, wildcard or other actions may be granted."
  }
  assert {
    condition     = jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement[2].Action == ["states:StartExecution"] && jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement[3].Action == ["secretsmanager:GetSecretValue"] && jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement[4].Action == ["kms:Decrypt"] && jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement[2].Resource == local.workflow_arn && jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement[3].Resource == var.runpod_secret_arn && jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement[4].Resource == var.runpod_secret_kms_key_arn && jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement[4].Condition.StringEquals["kms:ViaService"] == "secretsmanager.${var.region}.amazonaws.com"
    error_message = "Workflow, secret and optional decryption must each target exactly the configured resource."
  }
}
run "operator_without_cmk" {
  command = plan
  variables {
    network            = "mainnet"
    runpod_endpoint_id = "exampleendpoint"
    runpod_secret_arn  = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:qsb/runpod-Example"
  }
  assert {
    condition     = length(jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement) == 4 && !contains(flatten([for s in jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement : s.Action]), "kms:Decrypt")
    error_message = "No decryption grant without a configured customer-managed key."
  }
}
run "operator_without_provider" {
  command = plan
  variables { network = "mainnet" }
  assert {
    condition     = length(jsondecode(aws_iam_role_policy.operator_reconcile.policy).Statement) == 3
    error_message = "An unconfigured provider must not grant any secret or KMS access."
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

run "reject_provider_secret_wildcard" {
  command = plan
  variables {
    network            = "mainnet"
    runpod_endpoint_id = "exampleendpoint"
    runpod_secret_arn  = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:qsb/*"
  }
  expect_failures = [var.runpod_secret_arn]
}
run "reject_provider_key_wildcard" {
  command = plan
  variables {
    network                   = "mainnet"
    runpod_endpoint_id        = "exampleendpoint"
    runpod_secret_arn         = "arn:aws:secretsmanager:eu-west-1:123456789012:secret:qsb/runpod-Example"
    runpod_secret_kms_key_arn = "arn:aws:kms:eu-west-1:123456789012:key/*"
  }
  expect_failures = [var.runpod_secret_kms_key_arn]
}
