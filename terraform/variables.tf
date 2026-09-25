variable "region" {
  type    = string
  default = "eu-west-1"
}
variable "aws_account_id" {
  description = "Explicit intended AWS account; prevents accidental deployment elsewhere."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Supply a 12-digit AWS account ID."
  }
}
variable "name" {
  type    = string
  default = "qsb-research"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,29}$", var.name))
    error_message = "Use 3–30 lowercase letters, numbers or hyphens; start with a letter."
  }
}
variable "source_commit" {
  description = "Full clean Git commit used by scripts/build.mjs; commit and push it before applying."
  type        = string
  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.source_commit))
    error_message = "Supply a full 40-character commit SHA."
  }
}
variable "network" {
  description = "Required network identity baked into this stack. mainnet or testnet4. No default: an omitted value must not select mainnet. This does not enable transactions."
  type        = string
  validation {
    condition     = contains(["mainnet", "testnet4"], var.network)
    error_message = "Set network to mainnet or testnet4."
  }
}
variable "batch_job_queue" {
  type    = string
  default = ""
  validation {
    condition     = var.batch_job_queue == "" || can(regex("^arn:aws:batch:[a-z0-9-]+:[0-9]{12}:job-queue/qsb-[a-z0-9-]+$", var.batch_job_queue))
    error_message = "Use an exact QSB AWS Batch binding."
  }
}
variable "batch_job_definition" {
  type    = string
  default = ""
  validation {
    condition     = var.batch_job_definition == "" || can(regex("^arn:aws:batch:[a-z0-9-]+:[0-9]{12}:job-definition/qsb-[a-z0-9-]+:[0-9]+$", var.batch_job_definition))
    error_message = "Use an exact QSB AWS Batch binding."
  }
}
variable "batch_job_bucket" {
  type    = string
  default = ""
  validation {
    condition     = var.batch_job_bucket == "" || can(regex("^qsb-[a-z0-9-]+$", var.batch_job_bucket))
    error_message = "Use an exact QSB AWS Batch binding."
  }
}
variable "lambda_concurrency" {
  type    = number
  default = 2
  validation {
    condition     = var.lambda_concurrency >= 1 && var.lambda_concurrency <= 10 && floor(var.lambda_concurrency) == var.lambda_concurrency
    error_message = "Concurrency must be an integer from 1 to 10 (AWS account quota must also permit it)."
  }
}
variable "alarm_actions" {
  description = "Optional existing SNS topic ARNs for failure notifications. Empty creates visible alarms without notifications."
  type        = list(string)
  default     = []
}
variable "iam_role_path" {
  description = "Use /qsb/runtime/ for the dedicated GitHub deployment identity."
  type        = string
  default     = "/"
}
variable "iam_permissions_boundary_arn" {
  description = "Administrator-managed boundary required for GitHub-created runtime roles."
  type        = string
  default     = null
}
variable "operator_principal_arns" {
  description = "Explicit IAM user/role principals allowed to assume the reconciliation role with MFA. No account-root delegation, wildcard or default."
  type        = set(string)
  nullable    = false
  validation {
    condition     = length(var.operator_principal_arns) > 0 && alltrue([for arn in var.operator_principal_arns : can(regex("^arn:aws(-[a-z]+)?:iam::[0-9]{12}:(user|role)/[A-Za-z0-9+=,.@_/-]+$", arn))])
    error_message = "Supply at least one exact IAM user or role ARN; root, wildcard and session principals are not accepted."
  }
}
variable "exact_submit_enabled" {
  description = "Single exact-withdrawal submit switch. Keep false until explicit issue #22 transaction authorization. Does not enable wallet creation or search."
  type        = bool
  default     = false
  validation {
    condition     = !var.exact_submit_enabled || var.network == "mainnet"
    error_message = "Exact submission is implemented for mainnet only."
  }
}
variable "solver_release_id" {
  description = "Enrolled schema-v3 solver release served by the configured endpoint. Empty refuses new jobs."
  type        = string
  default     = ""
  validation {
    condition     = var.solver_release_id == "" || can(regex("^[a-z0-9][a-z0-9-]{0,127}$", var.solver_release_id))
    error_message = "solver_release_id must be an enrolled release ID, not an image/tag or URL."
  }
}
variable "mainnet_enabled" {
  description = "Enable mainnet funding/search routes and coordinator. Requires explicit approval for issue #22; exact submission has a separate switch."
  type        = bool
  default     = false
  validation {
    condition     = !var.mainnet_enabled || var.network == "mainnet"
    error_message = "mainnet_enabled is only supported on mainnet."
  }
}
