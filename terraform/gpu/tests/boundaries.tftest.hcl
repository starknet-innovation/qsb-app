mock_provider "aws" {}
mock_provider "archive" {}

variables {
  aws_account_id               = "123456789012"
  gpu_permissions_boundary_arn = "arn:aws:iam::123456789012:policy/qsb/bootstrap/qsb-gpu-boundary"
  source_commit                = "0000000000000000000000000000000000000000"
  image                        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@sha256:0000000000000000000000000000000000000000000000000000000000000000"
  subnets                      = ["subnet-0123456789abcdef0"]
  vpc_id                       = "vpc-0123456789abcdef0"
}

run "every_gpu_role_is_bounded" {
  command = plan
  assert {
    condition = alltrue([
      for role in [aws_iam_role.instance, aws_iam_role.job, aws_iam_role.execution, aws_iam_role.watchdog] :
      role.permissions_boundary == var.gpu_permissions_boundary_arn && role.path == "/qsb/runtime/"
    ])
    error_message = "All four GPU roles must carry the required GPU boundary on the operator-managed path."
  }
  assert {
    condition     = aws_batch_compute_environment.gpu.compute_resources[0].min_vcpus == 0 && aws_batch_compute_environment.gpu.compute_resources[0].max_vcpus == 4
    error_message = "Boundary enrollment must not change the zero-idle-capacity and one-instance configuration."
  }
}
run "reject_empty_boundary" {
  command = plan
  variables { gpu_permissions_boundary_arn = "" }
  expect_failures = [var.gpu_permissions_boundary_arn]
}
run "reject_other_account_boundary" {
  command = plan
  variables { gpu_permissions_boundary_arn = "arn:aws:iam::222222222222:policy/qsb/bootstrap/qsb-gpu-boundary" }
  expect_failures = [var.gpu_permissions_boundary_arn]
}
run "reject_runtime_boundary" {
  command = plan
  variables { gpu_permissions_boundary_arn = "arn:aws:iam::123456789012:policy/qsb/bootstrap/qsb-runtime-boundary" }
  expect_failures = [var.gpu_permissions_boundary_arn]
}
run "reject_other_policy_path" {
  command = plan
  variables { gpu_permissions_boundary_arn = "arn:aws:iam::123456789012:policy/qsb-gpu-boundary" }
  expect_failures = [var.gpu_permissions_boundary_arn]
}
