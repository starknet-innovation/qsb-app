resource "aws_iam_role" "runtime" {
  count              = local.runtime_count
  name               = "${var.name}-runtime-host"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_instance_profile" "runtime" {
  count = local.runtime_count
  name  = "${var.name}-runtime-host"
  role  = aws_iam_role.runtime[0].name
}
resource "aws_iam_role_policy_attachment" "runtime_ssm" {
  count      = local.runtime_count
  role       = aws_iam_role.runtime[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "runtime" {
  count = local.runtime_count
  role  = aws_iam_role.runtime[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:ConditionCheckItem"], Resource = aws_dynamodb_table.records.arn },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.dispatch[0].arn },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:GetObjectVersion"], Resource = "${aws_s3_bucket.runtime[0].arn}/releases/*" },
    { Effect = "Allow", Action = ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion"], Resource = "${aws_s3_bucket.runtime[0].arn}/evidence/*" },
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.runtime[0].arn, Condition = { StringLike = { "s3:prefix" = ["evidence/*", "releases/*"] } } },
    { Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = aws_ecr_repository.runtime[0].arn },
    { Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*" },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.runtime[0].arn}:*" }
  ] })
}
resource "aws_iam_role_policy" "api_dispatch" {
  count  = local.runtime_count
  role   = aws_iam_role.lambda["api"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sqs:SendMessage", Resource = aws_sqs_queue.dispatch[0].arn }] })
}
resource "aws_cloudwatch_log_group" "runtime" {
  count             = local.runtime_count
  name              = "/qsb/${var.name}/runtime"
  retention_in_days = 30
}
resource "aws_instance" "runtime" {
  count                       = local.runtime_count
  ami                         = data.aws_ami.runtime[0].id
  instance_type               = var.runtime_instance_type
  subnet_id                   = aws_subnet.runtime_private[0].id
  vpc_security_group_ids      = [aws_security_group.runtime[0].id]
  associate_public_ip_address = false
  iam_instance_profile        = aws_iam_instance_profile.runtime[0].name
  disable_api_termination     = true
  monitoring                  = true
  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
    # Host SDK uses IMDS; isolated CPU verification containers must not access it.
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }
  root_block_device {
    encrypted   = true
    volume_type = "gp3"
    volume_size = 40
  }
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/runtime/bootstrap.sh.tftpl", {
    config_b64    = base64encode(jsonencode({ region = var.region, table = aws_dynamodb_table.records.name, dispatchQueue = aws_sqs_queue.dispatch[0].url, evidenceBucket = aws_s3_bucket.runtime[0].id, evidenceVolume = aws_ebs_volume.evidence[0].id, sourceCommit = var.source_commit, executionEnabled = false, logGroup = aws_cloudwatch_log_group.runtime[0].name }))
    volume_serial = replace(aws_ebs_volume.evidence[0].id, "-", "")
    preflight_b64 = filebase64("${path.module}/runtime/preflight.py")
  })
  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.runtime_ami_id != "" && can(regex("^[0-9]{12}$", var.runtime_ami_owner)) && startswith(var.runtime_availability_zone, var.region)
      error_message = "The dormant runtime requires a pinned AMI/owner and an explicit AZ in the selected region."
    }
  }
  depends_on = [terraform_data.release, aws_route_table_association.runtime_private, aws_route_table_association.runtime_public, aws_iam_role_policy.runtime, aws_iam_role_policy_attachment.runtime_ssm]
  tags       = { Name = "${var.name}-runtime", Execution = "disabled" }
}
resource "aws_volume_attachment" "evidence" {
  count                          = local.runtime_count
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.evidence[0].id
  instance_id                    = aws_instance.runtime[0].id
  force_detach                   = false
  stop_instance_before_detaching = true
}
resource "aws_cloudwatch_metric_alarm" "runtime_host" {
  count               = local.runtime_count
  alarm_name          = "${var.name}-runtime-host-failure"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = aws_instance.runtime[0].id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = var.alarm_actions
}
resource "aws_cloudwatch_metric_alarm" "runtime_dead_letters" {
  count               = local.runtime_count
  alarm_name          = "${var.name}-runtime-dispatch-dead-letter"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dispatch_dead[0].name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_actions
}
