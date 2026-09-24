resource "aws_ebs_volume" "evidence" {
  count             = local.runtime_count
  availability_zone = var.runtime_availability_zone
  type              = "gp3"
  size              = var.runtime_evidence_gib
  encrypted         = true
  tags              = { Name = "${var.name}-evidence" }
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket" "runtime" {
  count         = local.runtime_count
  bucket        = "${var.name}-${var.aws_account_id}-${var.region}-runtime"
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_versioning" "runtime" {
  count  = local.runtime_count
  bucket = aws_s3_bucket.runtime[0].id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_public_access_block" "runtime" {
  count                   = local.runtime_count
  bucket                  = aws_s3_bucket.runtime[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "runtime" {
  count  = local.runtime_count
  bucket = aws_s3_bucket.runtime[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_policy" "runtime" {
  count  = local.runtime_count
  bucket = aws_s3_bucket.runtime[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.runtime[0].arn, "${aws_s3_bucket.runtime[0].arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
resource "aws_ecr_repository" "runtime" {
  count                = local.runtime_count
  name                 = "${var.name}-runtime"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
  force_delete = false
  lifecycle { prevent_destroy = true }
}
resource "aws_sqs_queue" "dispatch_dead" {
  count                     = local.runtime_count
  name                      = "${var.name}-dispatch-dead.fifo"
  fifo_queue                = true
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
}
resource "aws_sqs_queue" "dispatch" {
  count                       = local.runtime_count
  name                        = "${var.name}-dispatch.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  sqs_managed_sse_enabled     = true
  visibility_timeout_seconds  = 2100
  message_retention_seconds   = 1209600
  depends_on                  = [aws_sqs_queue.dispatch_dead]
  redrive_policy              = jsonencode({ deadLetterTargetArn = "arn:${data.aws_partition.current.partition}:sqs:${var.region}:${var.aws_account_id}:${var.name}-dispatch-dead.fifo", maxReceiveCount = 3 })
}
resource "aws_dynamodb_table" "cleanup" {
  count        = local.runtime_count
  name         = "${var.name}-cleanup"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  deletion_protection_enabled = true
  point_in_time_recovery { enabled = true }
  server_side_encryption { enabled = true }
  lifecycle { prevent_destroy = true }
}
resource "aws_backup_vault" "evidence" {
  count         = local.runtime_count
  name          = "${var.name}-evidence"
  force_destroy = false
  lifecycle { prevent_destroy = true }
}
resource "aws_iam_role" "backup" {
  count              = local.runtime_count
  name               = "${var.name}-backup"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "backup.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "backup" {
  count      = local.runtime_count
  role       = aws_iam_role.backup[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}
resource "aws_backup_plan" "evidence" {
  count = local.runtime_count
  name  = "${var.name}-evidence"
  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.evidence[0].name
    schedule          = "cron(0 3 * * ? *)"
    lifecycle { delete_after = 30 }
  }
}
resource "aws_backup_selection" "evidence" {
  count        = local.runtime_count
  name         = "${var.name}-evidence"
  plan_id      = aws_backup_plan.evidence[0].id
  iam_role_arn = aws_iam_role.backup[0].arn
  resources    = [aws_ebs_volume.evidence[0].arn]
  depends_on   = [aws_iam_role_policy_attachment.backup]
}

# Public dispatcher package only. Protected runtime installation/enrollment remains explicit.
resource "aws_s3_object" "dispatcher" {
  for_each               = var.provision_runtime ? toset(["dispatcher.cjs", "host.py", "manifest.json"]) : toset([])
  bucket                 = aws_s3_bucket.runtime[0].id
  key                    = "releases/${var.source_commit}/dispatcher/${each.key}"
  source                 = "${local.artifacts}/runtime/${each.key}"
  source_hash            = filesha256("${local.artifacts}/runtime/${each.key}")
  server_side_encryption = "AES256"
  depends_on             = [terraform_data.release]
}
