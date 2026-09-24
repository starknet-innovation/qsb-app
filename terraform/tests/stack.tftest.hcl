mock_provider "aws" {
  mock_data "aws_ami" { defaults = { id = "ami-0123456789abcdef0" } }
  mock_data "aws_partition" { defaults = { partition = "aws" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
}
variables {
  aws_account_id = "123456789012"
  name           = "qsb-test"
}
run "app_role_record_denies" {
  command = plan
  assert {
    condition = alltrue([
      for role in ["api", "coordinator"] :
      length([
        for statement in jsondecode(aws_iam_role_policy.records[role].policy).Statement : statement
        if statement.Sid == "DenyOutpointDelete" && statement.Effect == "Deny" && contains(statement.Action, "dynamodb:DeleteItem") && contains(statement.Condition["ForAnyValue:StringLike"]["dynamodb:LeadingKeys"], "OUTPOINT#*") && !contains(statement.Action, "dynamodb:PutItem")
      ]) == 1 && length([
        for statement in jsondecode(aws_iam_role_policy.records[role].policy).Statement : statement
        if statement.Sid == "DenySystemRowWrites" && statement.Effect == "Deny" && contains(statement.Action, "dynamodb:PutItem") && contains(statement.Action, "dynamodb:DeleteItem") && contains(statement.Condition["ForAnyValue:StringLike"]["dynamodb:LeadingKeys"], "SYSTEM#*")
      ]) == 1 && length([
        for statement in jsondecode(aws_iam_role_policy.records[role].policy).Statement : statement
        if statement.Sid == "TableDataAccess" && statement.Effect == "Allow" && contains(statement.Action, "dynamodb:PutItem") && contains(statement.Action, "dynamodb:ConditionCheckItem") && !contains(keys(statement), "Condition")
      ]) == 1
    ])
    error_message = "App roles must be able to create a reservation, must deny deleting one, and must deny system-row writes."
  }
}
run "baseline" {
  command = plan
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
    condition     = !can(jsondecode(aws_sfn_state_machine.withdrawal.definition).States.CoordinateSearch.Retry)
    error_message = "Do not add generic automatic retries around billable coordination."
  }
}
run "reject_network_mismatch" {
  command = plan
  variables { network = "testnet4" }
  expect_failures = [terraform_data.release]
}
run "reject_partial_compute_config" {
  command = plan
  variables { runpod_endpoint_id = "exampleendpoint" }
  expect_failures = [terraform_data.release]
}
run "reject_wrong_commit" {
  command = plan
  variables { source_commit = "0000000000000000000000000000000000000000" }
  expect_failures = [terraform_data.release]
}
run "reject_mainnet_supervised_runtime" {
  command = plan
  variables {
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
