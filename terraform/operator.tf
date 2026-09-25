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
      local.runpod ? [{ Sid = "ReadProviderCredential", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.runpod_secret_arn }] : [],
      local.runpod && var.runpod_secret_kms_key_arn != "" ? [{ Sid = "DecryptProviderCredential", Effect = "Allow", Action = ["kms:Decrypt"], Resource = var.runpod_secret_kms_key_arn, Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${var.region}.amazonaws.com" } } }] : []
    )
  })
}
