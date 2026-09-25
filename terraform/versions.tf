terraform {
  # State lives in the administrator-created bootstrap state bucket (ops/github-aws), never on a laptop.
  # Configure it at init with -backend-config; see README "Build, plan, deploy".
  backend "s3" {}
  required_version = ">= 1.7, < 2.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.aws_account_id]
  default_tags { tags = { Project = var.name, ManagedBy = "Terraform", SourceCommit = var.source_commit } }
}
data "aws_partition" "current" {}
