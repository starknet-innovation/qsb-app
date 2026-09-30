variable "build_manifest_path" {
  type        = string
  default     = null
  description = "Optional build manifest path; artifact hashes are always checked against this module's .build directory."
}
locals {
  artifacts         = "${path.module}/.build"
  build             = jsondecode(file("${local.artifacts}/manifest.json"))
  checked_build     = var.build_manifest_path != null ? jsondecode(file(var.build_manifest_path)) : local.build
  workflow_arn      = "arn:${data.aws_partition.current.partition}:states:${var.region}:${var.aws_account_id}:stateMachine:${var.name}-withdrawal"
  solver_release_id = try(local.build.identities.solver.id, "")
  compute           = var.batch_job_queue != "" && var.batch_job_definition != "" && var.batch_job_bucket != ""
  gpu_spend         = jsondecode(file("${path.module}/../server/gpu-spend.json"))
  gpu_limit_env = {
    GPU_WORKERS_MAX          = tostring(local.gpu_spend.workersMax)
    GPU_WORKERS_MIN          = tostring(local.gpu_spend.workersMin)
    GPU_EXECUTION_TIMEOUT_MS = tostring(local.gpu_spend.executionTimeoutMs)
    MAX_JOB_GPU_SECONDS      = tostring(local.gpu_spend.maxJobGpuSeconds)
  }
  # Unset switches add no keys, so a default plan leaves both environments as they were.
  owner_limit_env = merge(
    length(var.owner_allowlist) > 0 ? { QSB_OWNER_ALLOWLIST = join(",", sort(var.owner_allowlist)) } : {},
    var.owner_max_active_jobs == null ? {} : { QSB_OWNER_MAX_ACTIVE_JOBS = tostring(var.owner_max_active_jobs) },
    var.owner_max_gpu_seconds == null ? {} : { QSB_OWNER_MAX_GPU_SECONDS = tostring(var.owner_max_gpu_seconds) },
  )
  # The webhook dispatcher (webhooks.tf) gets the same role, log group and error alarm as the others, only when enabled.
  functions = toset(concat(["api", "coordinator", "reference"], var.webhook_dispatcher_enabled ? ["webhooks"] : []))
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
      condition     = var.solver_release_id == local.solver_release_id && try(local.checked_build.commit == local.build.commit && local.checked_build.identities.solver == local.build.identities.solver && local.checked_build.identities.reference.appCommit == var.source_commit && local.checked_build.identities.reference.artifact == "reference.zip" && local.checked_build.identities.reference.sha256 == local.build.files["reference.zip"], false)
      error_message = "Rebuild with the selected --solver-release and matching CPU artifact; deployment identities must come from that build."
    }
    precondition {
      condition     = alltrue([for name, hash in local.build.files : filesha256("${local.artifacts}/${name}") == hash]) && toset(fileset("${local.artifacts}/frontend", "**")) == toset(local.build.frontend_files)
      error_message = "Build artifacts changed or frontend files were added/removed; rebuild."
    }
    precondition {
      condition     = length(compact([var.batch_job_queue, var.batch_job_definition, var.batch_job_bucket])) == 0 || length(compact([var.batch_job_queue, var.batch_job_definition, var.batch_job_bucket])) == 3
      error_message = "Supply all three AWS Batch bindings, or none."
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
  # The due-delivery index the webhook dispatcher queries (server/webhooks.ts). Sparse: only WEBHOOKS rows with a
  # delivery due carry its keys. Keys only, so a query of it returns no hook, secret or event. It doesn't depend on
  # webhook_dispatcher_enabled: this provider keeps an index whose block is removed (the blocks are Optional and
  # Computed), so switching it off couldn't take the index away cleanly, and on its own it costs next to nothing.
  attribute {
    name = "webhookQueue"
    type = "S"
  }
  attribute {
    name = "webhookDueAt"
    type = "N"
  }
  global_secondary_index {
    name            = local.webhook_due_index
    projection_type = "KEYS_ONLY"
    key_schema {
      attribute_name = "webhookQueue"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "webhookDueAt"
      key_type       = "RANGE"
    }
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
# Upload order. index.html is the only file that names the content-hashed assets/*, so it is uploaded on its own,
# after every other file. Those use create_before_destroy: a file dropped from the build (the previous bundle's
# hashed assets) is then deleted after the new index.html is uploaded, not at the start of the apply, where
# Terraform otherwise puts it. A removed instance takes that flag from state, so this holds from the second apply
# on. check-single-pipeline.py keeps this shape.
resource "aws_s3_object" "frontend" {
  for_each      = setsubtract(fileset("${local.artifacts}/frontend", "**"), ["index.html"])
  bucket        = aws_s3_bucket.frontend.id
  key           = each.value
  source        = "${local.artifacts}/frontend/${each.value}"
  source_hash   = filesha256("${local.artifacts}/frontend/${each.value}")
  content_type  = lookup(local.mime, reverse(split(".", each.value))[0], "application/octet-stream")
  cache_control = startswith(each.value, "assets/") ? "public,max-age=31536000,immutable" : "no-cache,max-age=0,must-revalidate"
  depends_on    = [terraform_data.release, aws_s3_bucket_public_access_block.frontend]
  lifecycle { create_before_destroy = true }
}
resource "aws_s3_object" "index" {
  bucket        = aws_s3_bucket.frontend.id
  key           = "index.html"
  source        = "${local.artifacts}/frontend/index.html"
  source_hash   = filesha256("${local.artifacts}/frontend/index.html")
  content_type  = local.mime.html
  cache_control = "no-cache,max-age=0,must-revalidate"
  depends_on    = [terraform_data.release, aws_s3_bucket_public_access_block.frontend, aws_s3_object.frontend]
}
# The same S3 object, so the first apply moves it in state instead of deleting and re-creating index.html.
# check-single-pipeline.py requires this mapping; tests/frontend_migration.tftest.hcl plans it against the old state.
moved {
  from = aws_s3_object.frontend["index.html"]
  to   = aws_s3_object.index
}
