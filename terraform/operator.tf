# Human-operated reconciliation only. Never assumed by an application service.
resource "aws_iam_role" "operator_reconcile" {
  name                 = "${var.name}-operator-reconcile"
  path                 = var.iam_role_path
  permissions_boundary = var.iam_permissions_boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = sort(tolist(var.operator_principal_arns)) }
      Action    = "sts:AssumeRole"
      Condition = { Bool = { "aws:MultiFactorAuthPresent" = "true" } }
    }]
  })
}
resource "aws_iam_role_policy" "operator_reconcile" {
  role = aws_iam_role.operator_reconcile.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [for statement in jsondecode(file("${path.module}/policies/operator-reconcile-records.json")) : merge(statement, {
        Resource = "arn:${data.aws_partition.current.partition}:dynamodb:${var.region}:${var.aws_account_id}:table/${aws_dynamodb_table.records.name}"
      })],
      [{ Sid = "StartCoordinator", Effect = "Allow", Action = ["states:StartExecution"], Resource = local.workflow_arn }],
      [for statement in [
        { Effect = "Allow", Action = ["batch:DescribeJobs", "batch:ListJobs", "batch:DescribeJobQueues"], Resource = "*", Condition = { StringEquals = { "aws:RequestedRegion" = var.region } } },
        { Effect = "Allow", Action = "s3:GetObject", Resource = "arn:aws:s3:::${var.batch_job_bucket}/outputs/*" }
      ] : statement if local.compute]
    )
  })
}
