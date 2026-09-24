mock_provider "aws" {
  mock_data "aws_partition" { defaults = { partition = "aws" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
}
variables {
  aws_account_id = "123456789012"
  name           = "qsb-test"
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
