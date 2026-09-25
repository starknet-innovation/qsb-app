mock_provider "aws" {}
mock_provider "archive" {}

variables {
  release_manifest_path        = "../.build/test-gpu-valid.json"
  aws_account_id               = "123456789012"
  gpu_permissions_boundary_arn = "arn:aws:iam::123456789012:policy/qsb/bootstrap/qsb-gpu-boundary"
  source_commit                = jsondecode(file("../.build/manifest.json")).commit
  image                        = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@${split("@", jsondecode(file("../../src/lib/releases/qsb-solver-aws-v0-1-0.json")).image)[1]}"
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

run "reject_solver_digest_mismatch" {
  command = plan
  variables { image = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@sha256:1111111111111111111111111111111111111111111111111111111111111111" }
  expect_failures = [terraform_data.release_identity]
}
run "reject_app_source_mismatch" {
  command = plan
  variables { source_commit = "1111111111111111111111111111111111111111" }
  expect_failures = [terraform_data.release_identity]
}

run "reject_unknown_id" {
  command = plan
  variables { release_manifest_path = "../.build/test-gpu-unknown-id.json" }
  expect_failures = [terraform_data.release_identity]
}

run "reject_historical_schema" {
  command = plan
  variables {
    release_manifest_path = "../.build/test-gpu-historical-schema.json"
    image = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@${split("@", jsondecode(file("../.build/test-gpu-historical-schema.json")).identities.solver.image)[1]}"
  }
  expect_failures = [terraform_data.release_identity]
}

run "reject_wrong_image" {
  command = plan
  variables {
    release_manifest_path = "../.build/test-gpu-wrong-image.json"
    image = "123456789012.dkr.ecr.eu-west-1.amazonaws.com/qsb-solver@${split("@", jsondecode(file("../.build/test-gpu-wrong-image.json")).identities.solver.image)[1]}"
  }
  expect_failures = [terraform_data.release_identity]
}

run "reject_wrong_commit" {
  command = plan
  variables { release_manifest_path = "../.build/test-gpu-wrong-commit.json" }
  expect_failures = [terraform_data.release_identity]
}

run "reject_wrong_reference" {
  command = plan
  variables { release_manifest_path = "../.build/test-gpu-wrong-reference.json" }
  expect_failures = [terraform_data.release_identity]
}

run "reject_wrong_file" {
  command = plan
  variables { release_manifest_path = "../.build/test-gpu-wrong-file.json" }
  expect_failures = [terraform_data.release_identity]
}
