terraform {
  # State lives in the administrator-created bootstrap state bucket (ops/github-aws), never on a laptop.
  # The bucket and its region are supplied at init (-backend-config=bucket=... -backend-config=region=...);
  # the key is fixed so the GPU stack's qsb/gpu/ state can't be picked up by mistake. S3 lockfiles need
  # Terraform 1.11+.
  backend "s3" {
    key          = "qsb/main/terraform.tfstate"
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
  # No commit tag: it would change every resource on every deploy. The deployed commit is terraform_data.release
  # and the source_commit output, and data.tf refuses a build that doesn't match it.
  default_tags { tags = { Project = var.name, ManagedBy = "Terraform" } }
}
data "aws_partition" "current" {}
# Pins this state to its region. Changing var.region on an existing stack would otherwise plan a
# second stack in the new region and leave this one running, unmanaged. A region move is a new
# stack (docs/REGION-MIGRATION.md): this refuses the replacement a region change would need.
resource "terraform_data" "region_pin" {
  triggers_replace = var.region
  lifecycle { prevent_destroy = true }
}
