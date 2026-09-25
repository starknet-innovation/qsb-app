terraform {
  # State lives in the administrator-created bootstrap state bucket (ops/github-aws), never on a laptop.
  # Only the bucket is supplied at init (-backend-config=bucket=...); the key is fixed so the GPU
  # stack's qsb/gpu/ state can't be picked up by mistake. S3 lockfiles need Terraform 1.11+.
  backend "s3" {
    key          = "qsb/main/terraform.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }
  required_version = ">= 1.11, < 2.0"
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
