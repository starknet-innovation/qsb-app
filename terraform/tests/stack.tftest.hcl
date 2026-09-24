mock_provider "aws" {
  mock_data "aws_ami" { defaults = { id = "ami-0123456789abcdef0" } }
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
run "dormant_runtime" {
  command = plan
  variables {
    provision_runtime         = true
    runtime_ami_id            = "ami-0123456789abcdef0"
    runtime_ami_owner         = "123456789012"
    runtime_availability_zone = "eu-west-1a"
  }
  assert {
    condition     = length(aws_instance.runtime) == 1 && !aws_instance.runtime[0].associate_public_ip_address && aws_instance.runtime[0].metadata_options[0].http_tokens == "required"
    error_message = "Runtime host must be private and require IMDSv2."
  }
  assert {
    condition     = length(aws_security_group.runtime[0].ingress) == 0 && aws_ebs_volume.evidence[0].encrypted
    error_message = "Runtime has no inbound listener and requires encrypted evidence storage."
  }
  assert {
    condition     = aws_cloudwatch_event_rule.watchdog[0].state == "DISABLED" && output.supervised_runtime.execution_enabled == false
    error_message = "Provisioning without enrolled targets must not activate cleanup or execution."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables.SUPERVISED_EXECUTION_ENABLED == "false"
    error_message = "Provisioned API transport must not activate the dispatcher."
  }
  assert {
    condition = aws_cloudwatch_event_rule.dispatch[0].state == "DISABLED" && aws_lambda_function.dispatch[0].environment[0].variables.SUPERVISED_EXECUTION_ENABLED == "false" && length(aws_s3_object.dispatcher) == 11
    error_message = "Dispatcher artifacts must be provisioned without activation."
  }
  assert {
    condition     = jsondecode(aws_sqs_queue.dispatch[0].redrive_policy).maxReceiveCount == 3
    error_message = "Dispatch delivery retries must remain bounded; durable invocation claims prevent duplicate paid work."
  }
}
run "enrolled_cleanup" {
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
  assert {
    condition     = aws_cloudwatch_event_rule.watchdog[0].state == "ENABLED" && aws_lambda_function.watchdog[0].reserved_concurrent_executions == 1
    error_message = "Only explicit endpoint enrollment activates the serialized cleanup watchdog."
  }
}
run "reject_missing_runtime_ami" {
  command = plan
  variables {
    provision_runtime         = true
    runtime_ami_owner         = "123456789012"
    runtime_availability_zone = "eu-west-1a"
  }
  expect_failures = [aws_instance.runtime]
}
