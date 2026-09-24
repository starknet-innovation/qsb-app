locals {
  artifacts    = "${path.module}/.build"
  build        = jsondecode(file("${local.artifacts}/manifest.json"))
  workflow_arn = "arn:${data.aws_partition.current.partition}:states:${var.region}:${var.aws_account_id}:stateMachine:${var.name}-withdrawal"
  runpod            = var.runpod_endpoint_id != "" && var.runpod_secret_arn != ""
  functions         = toset(["api", "coordinator", "reference"])
  deploy_identities = jsondecode(file("${local.artifacts}/deploy-identities.json"))
  current_solver    = jsondecode(file("${path.module}/../src/lib/releases/qsb-config-a-ranked-v2-d28103b.json"))
  mime = {
    html = "text/html; charset=utf-8", js = "application/javascript", mjs = "application/javascript",
    css  = "text/css", json = "application/json", svg = "image/svg+xml", wasm = "application/wasm",
    py   = "text/plain; charset=utf-8", zip = "application/zip", png = "image/png", ico = "image/x-icon", whl = "application/zip"
  }
}
resource "terraform_data" "release" {
  input = var.source_commit
  lifecycle {
    precondition {
      condition     = local.build.commit == var.source_commit && local.build.clean && local.build.network == var.network
      error_message = "Rebuild from the requested clean commit and matching network before deployment."
    }
    precondition {
      condition     = alltrue([for name, hash in local.build.files : filesha256("${local.artifacts}/${name}") == hash]) && toset(fileset("${local.artifacts}/frontend", "**")) == toset(local.build.frontend_files)
      error_message = "Build artifacts changed or frontend files were added/removed; rebuild."
    }
    precondition {
      condition     = (var.runpod_endpoint_id == "") == (var.runpod_secret_arn == "")
      error_message = "Supply both Runpod endpoint and secret ARN, or neither."
    }
    precondition {
      condition     = !(var.network == "mainnet" && var.provision_runtime)
      error_message = "Do not deploy the supervised runtime for the mainnet environment. Mainnet jobs use the Step Functions coordinator."
    }
    precondition {
      condition = (
        local.deploy_identities.format == "qsb-deploy-identities-v1" &&
        local.deploy_identities.mainnetEnabled == false &&
        local.deploy_identities.broadcastAuthorized == false &&
        can(regex("^[a-f0-9]{40}$", local.deploy_identities.artifactCommit)) &&
        can(regex("^sha256:[a-f0-9]{64}$", local.deploy_identities.worker.digest)) &&
        can(regex("^sha256:[a-f0-9]{64}$", local.deploy_identities.cpuVerifier.digest)) &&
        can(regex("^[a-f0-9]{64}$", local.deploy_identities.cpuVerifier.packageSha256)) &&
        local.deploy_identities.worker.pull == "${local.deploy_identities.worker.repository}@${local.deploy_identities.worker.digest}" &&
        local.deploy_identities.cpuVerifier.pull == "${local.deploy_identities.cpuVerifier.repository}@${local.deploy_identities.cpuVerifier.digest}" &&
        local.deploy_identities.runpod.image == local.deploy_identities.worker.pull &&
        !strcontains(local.deploy_identities.worker.repository, "000000000000") &&
        !strcontains(local.deploy_identities.cpuVerifier.repository, "000000000000") &&
        local.current_solver.id == "qsb-config-a-ranked-v2-d28103b" &&
        local.current_solver.protocol == "qsb-config-a-v1" &&
        local.current_solver.generatorCommit == "2c9172051d5c150ef0a994ca6b988a08a3ef9e85" &&
        endswith(local.current_solver.image, "@${local.deploy_identities.worker.digest}") &&
        startswith(local.current_solver.image, "000000000000.dkr.ecr.") &&
        filesha256("${local.artifacts}/reference.zip") == local.deploy_identities.cpuVerifier.packageSha256
      )
      error_message = "Generate deploy identities from the pushed artifact commit before deployment. The coordinator image references must be registry digests."
    }
  }
}
resource "aws_dynamodb_table" "records" {
  name                        = "${var.name}-records"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  range_key                   = "sk"
  deletion_protection_enabled = true
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket" "frontend" {
  bucket        = "${var.name}-${var.aws_account_id}-${var.region}-web"
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_object" "frontend" {
  for_each      = fileset("${local.artifacts}/frontend", "**")
  bucket        = aws_s3_bucket.frontend.id
  key           = each.value
  source        = "${local.artifacts}/frontend/${each.value}"
  source_hash   = filesha256("${local.artifacts}/frontend/${each.value}")
  content_type  = lookup(local.mime, reverse(split(".", each.value))[0], "application/octet-stream")
  cache_control = startswith(each.value, "assets/") ? "public,max-age=31536000,immutable" : "no-cache,max-age=0,must-revalidate"
  depends_on    = [terraform_data.release, aws_s3_bucket_public_access_block.frontend]
}
