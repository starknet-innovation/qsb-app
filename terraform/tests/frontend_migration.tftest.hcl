# The first apply after index.html got its own resource must move the existing object in state, not destroy
# frontend["index.html"] and create aws_s3_object.index. A plan without prior state can't show that, so the first
# run seeds a state with the earlier layout and the second plans the stack against it. The last two runs check the
# way back (docs/OPERATIONAL-RUNBOOK.md, "Rolling back past the index.html split").
mock_provider "aws" {
  mock_data "aws_partition" { defaults = { partition = "aws" } }
  mock_data "aws_caller_identity" { defaults = { account_id = "123456789012" } }
}
run "frontend_before_index_split" {
  command   = apply
  state_key = "frontend_migration"
  module { source = "./tests/fixtures/before-index-split" }
  variables {
    name           = "qsb-test"
    aws_account_id = "123456789012"
    region         = "eu-west-2"
  }
}
run "frontend_index_moved_not_recreated" {
  command   = plan
  state_key = "frontend_migration"
  variables {
    solver_release_id       = try(jsondecode(file(".build/manifest.json")).identities.solver.id, "")
    operator_principal_arns = ["arn:aws:iam::123456789012:user/reconcile-test"]
    aws_account_id          = "123456789012"
    region                  = "eu-west-2"
    name                    = "qsb-test"
    network                 = "mainnet"
  }
  assert {
    # A created object's id is unknown at plan; only the moved one keeps the id the first run stored.
    condition     = aws_s3_object.index.id == run.frontend_before_index_split.index_html_id && !contains(keys(aws_s3_object.frontend), "index.html")
    error_message = "The existing index.html object must move to aws_s3_object.index, not be destroyed and created again."
  }
}

# Rolling back to a commit from before the split: after the runbook's state mv (the fixture's moved block stands in
# for it), the earlier layout must plan index.html as an update of the existing object, not a delete and a create.
run "frontend_after_index_split" {
  command   = apply
  state_key = "frontend_rollback"
  # The frontend objects and what they depend on; the mock provider can't apply the rest of the stack.
  plan_options { target = [aws_s3_object.index] }
  variables {
    solver_release_id       = try(jsondecode(file(".build/manifest.json")).identities.solver.id, "")
    operator_principal_arns = ["arn:aws:iam::123456789012:user/reconcile-test"]
    aws_account_id          = "123456789012"
    region                  = "eu-west-2"
    name                    = "qsb-test"
    network                 = "mainnet"
  }
}
run "frontend_rollback_keeps_index_html" {
  command   = plan
  state_key = "frontend_rollback"
  module { source = "./tests/fixtures/before-index-split" }
  variables {
    name           = "qsb-test"
    aws_account_id = "123456789012"
    region         = "eu-west-2"
  }
  assert {
    # A created object's id is unknown at plan, which fails this condition; the moved one keeps its stored id.
    condition     = length(output.index_html_id) > 0
    error_message = "After the state move, the earlier layout must keep the existing index.html object."
  }
}
