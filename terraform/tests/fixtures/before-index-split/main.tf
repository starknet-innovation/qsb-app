# Test fixture only (tests/frontend_migration.tftest.hcl): the frontend bucket and objects as they were declared
# before index.html moved to aws_s3_object.index, when one for_each held every built file. The tests apply it with
# the mock provider to seed state and plan it for the rollback check; it is never deployed.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
variable "name" { type = string }
variable "aws_account_id" { type = string }
variable "region" { type = string }
locals {
  # The same relative path the stack uses (path.module is "." there), so the moved object's source is unchanged.
  artifacts = "./.build"
}
resource "aws_s3_bucket" "frontend" {
  bucket        = "${var.name}-${var.aws_account_id}-${var.region}-web"
  force_destroy = false
}
resource "aws_s3_object" "frontend" {
  for_each      = fileset("${local.artifacts}/frontend", "**")
  bucket        = aws_s3_bucket.frontend.id
  key           = each.value
  source        = "${local.artifacts}/frontend/${each.value}"
  source_hash   = filesha256("${local.artifacts}/frontend/${each.value}")
  content_type  = each.value == "index.html" ? "text/html; charset=utf-8" : "application/octet-stream"
  cache_control = startswith(each.value, "assets/") ? "public,max-age=31536000,immutable" : "no-cache,max-age=0,must-revalidate"
}
# Stands in for the rollback runbook's `terraform state mv 'aws_s3_object.index' 'aws_s3_object.frontend["index.html"]'`,
# which terraform test can't run: it moves the same address in state before planning. Old commits have no such block.
# It is a no-op when the state holds no aws_s3_object.index, as in the first run of the test.
moved {
  from = aws_s3_object.index
  to   = aws_s3_object.frontend["index.html"]
}
output "index_html_id" {
  value = aws_s3_object.frontend["index.html"].id
}
