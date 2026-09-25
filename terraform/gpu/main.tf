terraform {

  required_version = ">= 1.7, < 2.0"
  required_providers {
    archive = { source = "hashicorp/archive", version = "~> 2.7" }
    aws = {
      source = "hashicorp/aws", version = "~> 6.0"
    }
  }
  backend "s3" {

  }

}
variable "source_commit" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.source_commit))
    error_message = "Record the exact clean pushed source commit."
  }
}
variable "image" {

  type = string
  validation {

    condition     = can(regex("^905846953990\\.dkr\\.ecr\\.eu-west-1\\.amazonaws\\.com/qsb-solver@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Use the immutable AWS A10G solver image in the QSB repository."

  }

}
variable "gpu_ami" {
  type        = string
  default     = "ami-05db4db06e751ab89"
  description = "Pinned AWS ECS AL2023 NVIDIA x86_64 AMI, Ireland; verified 2026-09-25."
}
variable "subnets" {
  type = list(string)
}
variable "vpc_id" {
  type = string
}
provider "aws" {

  region              = "eu-west-1"
  allowed_account_ids = ["905846953990"]
  default_tags {
    tags = {
      Project = "qsb-gpu", SourceCommit = var.source_commit, ManagedBy = "Terraform"
    }
  }

}
locals {
  name = "qsb-gpu"
}
resource "aws_ecr_repository" "solver" {

  name                 = "qsb-solver"
  image_tag_mutability = "IMMUTABLE"
  encryption_configuration {
    encryption_type = "AES256"
  }
  image_scanning_configuration {
    scan_on_push = true
  }

}
resource "aws_s3_bucket" "jobs" {
  bucket = "qsb-gpu-905846953990-eu-west-1-jobs"
}
resource "aws_s3_bucket_public_access_block" "jobs" {

  bucket                  = aws_s3_bucket.jobs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true

}
resource "aws_s3_bucket_server_side_encryption_configuration" "jobs" {

  bucket = aws_s3_bucket.jobs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }

}
resource "aws_s3_bucket_policy" "jobs" {

  bucket = aws_s3_bucket.jobs.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.jobs.arn, "${aws_s3_bucket.jobs.arn}/*"], Condition = {
        Bool = {
          "aws:SecureTransport" = "false"
        }
      }
    }]
  })

}
resource "aws_s3_bucket_lifecycle_configuration" "jobs" {

  bucket = aws_s3_bucket.jobs.id
  rule {

    id     = "public-job-artifacts"
    status = "Enabled"
    filter {
      prefix = ""
    }
    expiration {
      days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }

  }

}
resource "aws_cloudwatch_log_group" "jobs" {
  name              = "/aws/batch/qsb-gpu"
  retention_in_days = 30
}
resource "aws_security_group" "gpu" {

  name        = "qsb-gpu-no-ingress"
  vpc_id      = var.vpc_id
  description = "No inbound; Batch agent, ECR and public job artifacts use HTTPS"
  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

}
resource "aws_iam_role" "instance" {

  name = "qsb-gpu-instance"
  path = "/qsb/runtime/"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ec2.amazonaws.com"
      }, Action = "sts:AssumeRole"
    }]
  })

}
resource "aws_iam_role_policy_attachment" "ecs" {

  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"

}
resource "aws_iam_instance_profile" "gpu" {
  name = "qsb-gpu-instance"
  path = "/qsb/runtime/"
  role = aws_iam_role.instance.name
}
resource "aws_iam_role" "job" {

  name = "qsb-gpu-job"
  path = "/qsb/runtime/"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ecs-tasks.amazonaws.com"
        }, Action = "sts:AssumeRole", Condition = {
        StringEquals = {
          "aws:SourceAccount" = "905846953990"
          }, ArnLike = {
          "aws:SourceArn" = "arn:aws:ecs:eu-west-1:905846953990:*"
        }
      }
    }]
  })

}
resource "aws_iam_role_policy" "job" {

  role = aws_iam_role.job.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = "s3:GetObject", Resource = "${aws_s3_bucket.jobs.arn}/inputs/*"
      },
      {
        Effect = "Allow", Action = "s3:PutObject", Resource = "${aws_s3_bucket.jobs.arn}/outputs/*"
      }
    ]
  })

}
resource "aws_iam_role" "execution" {

  name               = "qsb-gpu-execution"
  path               = "/qsb/runtime/"
  assume_role_policy = aws_iam_role.job.assume_role_policy

}
resource "aws_iam_role_policy" "execution" {

  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      {
        Effect = "Allow", Action = "ecr:GetAuthorizationToken", Resource = "*"
      },
      {
        Effect = "Allow", Action = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], Resource = aws_ecr_repository.solver.arn
      },
      {
        Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.jobs.arn}:*"
      }
    ]
  })

}
resource "aws_launch_template" "gpu" {

  name = "qsb-gpu"
  block_device_mappings {

    device_name = "/dev/xvda"
    ebs {
      volume_size           = 80
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }

  }
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  # Tasks use ECS task credentials, not the instance profile.
  user_data = base64encode("MIME-Version: 1.0\nContent-Type: multipart/mixed; boundary=\"QSB\"\n\n--QSB\nContent-Type: text/x-shellscript; charset=\"us-ascii\"\n\n#!/bin/bash\necho ECS_AWSVPC_BLOCK_IMDS=true >> /etc/ecs/ecs.config\n--QSB--\n")

}
resource "aws_batch_compute_environment" "gpu" {

  name  = "qsb-gpu"
  type  = "MANAGED"
  state = "ENABLED"
  compute_resources {

    type                = "EC2"
    allocation_strategy = "BEST_FIT"
    min_vcpus           = 0
    max_vcpus           = 4
    instance_type       = ["g5.xlarge"]
    instance_role       = aws_iam_instance_profile.gpu.arn
    subnets             = var.subnets
    security_group_ids  = [aws_security_group.gpu.id]
    ec2_configuration {
      image_type        = "ECS_AL2023_NVIDIA"
      image_id_override = var.gpu_ami
    }
    launch_template {
      launch_template_id = aws_launch_template.gpu.id
      version            = aws_launch_template.gpu.latest_version
    }
    tags = {
      Project = "qsb-gpu", SourceCommit = var.source_commit
    }

  }
  depends_on = [aws_iam_role_policy_attachment.ecs]

}
resource "aws_batch_job_queue" "gpu" {

  name     = "qsb-gpu"
  state    = "ENABLED"
  priority = 1
  compute_environment_order {
    order               = 1
    compute_environment = aws_batch_compute_environment.gpu.arn
  }

}
resource "aws_batch_job_definition" "solver" {

  name                  = "qsb-gpu-solver"
  type                  = "container"
  platform_capabilities = ["EC2"]
  retry_strategy {
    attempts = 1
  }
  timeout {
    attempt_duration_seconds = 900
  }
  propagate_tags = true
  container_properties = jsonencode({

    image = var.image, jobRoleArn = aws_iam_role.job.arn, executionRoleArn = aws_iam_role.execution.arn,
    resourceRequirements = [{
      type = "VCPU", value = "4"
      }, {
      type = "MEMORY", value = "12000"
      }, {
      type = "GPU", value = "1"
    }],
    environment = [{
      name = "QSB_JOB_BUCKET", value = aws_s3_bucket.jobs.id
    }],
    readonlyRootFilesystem = true, privileged = false,
    linuxParameters = {
      capabilities = {
        drop = ["ALL"]
        }, tmpfs = [{
          containerPath = "/tmp", size = 2048, mountOptions = ["rw", "nosuid", "nodev"]
      }]
    },
    logConfiguration = {
      logDriver = "awslogs", options = {
        awslogs-group = aws_cloudwatch_log_group.jobs.name, awslogs-region = "eu-west-1", awslogs-stream-prefix = "solver"
      }
    }

  })

}
output "queue" {
  value = aws_batch_job_queue.gpu.arn
}
output "definition" {
  value = aws_batch_job_definition.solver.arn
}
output "bucket" {
  value = aws_s3_bucket.jobs.id
}
output "image_repository" {
  value = aws_ecr_repository.solver.repository_url
}
