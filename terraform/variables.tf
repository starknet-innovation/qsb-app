variable "region" {
  description = "Deploy region, set explicitly in every tfvars. QSB runs in eu-west-2 (organisation requirement); eu-west-1 only while the legacy stack is torn down. Moving region is a new stack, never an in-place change: see docs/REGION-MIGRATION.md."
  type        = string
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.region))
    error_message = "Use an AWS region name such as eu-west-2."
  }
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
    condition = var.batch_job_queue == "" || (
      can(regex("^arn:aws:batch:[a-z0-9-]+:[0-9]{12}:job-queue/qsb-[a-z0-9-]+$", var.batch_job_queue)) &&
      try(split(":", var.batch_job_queue)[3] == var.region && split(":", var.batch_job_queue)[4] == var.aws_account_id, false)
    )
    error_message = "Use an exact QSB AWS Batch binding in this stack's account and region."
  }
}
variable "batch_job_definition" {
  type    = string
  default = ""
  validation {
    condition = var.batch_job_definition == "" || (
      can(regex("^arn:aws:batch:[a-z0-9-]+:[0-9]{12}:job-definition/qsb-[a-z0-9-]+:[0-9]+$", var.batch_job_definition)) &&
      try(split(":", var.batch_job_definition)[3] == var.region && split(":", var.batch_job_definition)[4] == var.aws_account_id, false)
    )
    error_message = "Use an exact QSB AWS Batch binding in this stack's account and region."
  }
}
variable "batch_job_bucket" {
  type    = string
  default = ""
  validation {
    # The runtime boundary grants job input/output access to this bucket name only.
    condition     = var.batch_job_bucket == "" || var.batch_job_bucket == "qsb-gpu-${var.aws_account_id}-${var.region}-jobs"
    error_message = "Use this stack's account and region job bucket, qsb-gpu-<account>-<region>-jobs."
  }
}
variable "lambda_concurrency" {
  description = "Reserved concurrency for each application function. 0 freezes the stack: every function is throttled, so nothing reads or writes the records table."
  type        = number
  default     = 2
  validation {
    condition     = var.lambda_concurrency >= 0 && var.lambda_concurrency <= 10 && floor(var.lambda_concurrency) == var.lambda_concurrency
    error_message = "Concurrency must be an integer from 0 (frozen) to 10 (AWS account quota must also permit it)."
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
variable "api_keys_enabled" {
  description = "Scoped API keys (#85) for the API Lambda only. Keep false until the maintainer explicitly approves third-party access. Does not enable mainnet, deposits, withdrawals or submission."
  type        = bool
  default     = false
}
variable "webhook_dispatcher_enabled" {
  description = "Scheduled webhook dispatcher: a dispatcher Lambda and an EventBridge Scheduler schedule every 5 minutes, each with its own role (webhooks.tf); the due-delivery index it queries is on the table either way. It sends queued webhook retries that would otherwise wait for the owner's next API request or coordinator tick. Keep false until the AWS administrator has installed the reviewed deploy-policy update (ops/github-aws/update_installed.py): before that the scoped roles can't create the schedule. Does not enable mainnet, deposits, withdrawals or submission."
  type        = bool
  default     = false
}
variable "slipstream_secret_arn" {
  description = "Optional existing Secrets Manager secret qsb/slipstream, created by an administrator in this account and region with the default aws/secretsmanager key and holding a JSON object with client_code (MARA's client code, added to the body of transaction submissions only), authorization (sent as the Authorization header) or both. Both go to MARA Slipstream only. Empty sends no credential. Terraform only references it: the value never enters state or plans."
  type        = string
  default     = ""
  validation {
    condition = var.slipstream_secret_arn == "" || (
      can(regex("^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:qsb/slipstream-[A-Za-z0-9]{6}$", var.slipstream_secret_arn)) &&
      try(split(":", var.slipstream_secret_arn)[3] == var.region && split(":", var.slipstream_secret_arn)[4] == var.aws_account_id, false)
    )
    error_message = "Supply the full ARN of the qsb/slipstream secret in this stack's account and region, or leave it empty."
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
variable "owner_allowlist" {
  description = "Partner-phase owner allowlist (QSB_OWNER_ALLOWLIST) for the API and coordinator. Empty allows every signed-in owner, as today. When set, only these Bitcoin addresses may register vaults, deposit, or create or resume withdrawals, and the coordinator pauses other owners' withdrawals. Lambda environments hold 4 KB in all, so keep it to a short partner list."
  type        = set(string)
  default     = []
  nullable    = false
  validation {
    condition     = alltrue([for address in var.owner_allowlist : can(regex("^[A-Za-z0-9]{14,100}$", address))])
    error_message = "List Bitcoin addresses exactly as the wallet signs in with them."
  }
  # Both Lambdas get the list; this leaves either one room for its other variables under the
  # 4 KB environment limit, so an apply can't update one and fail the other.
  validation {
    condition     = length(join(",", var.owner_allowlist)) <= 2500
    error_message = "The allowlist must stay within 2500 characters, joined with commas, to fit the 4 KB Lambda environment."
  }
}
variable "owner_max_active_jobs" {
  description = "Most withdrawals one owner may have queued or searching at once (QSB_OWNER_MAX_ACTIVE_JOBS); pausing frees a slot and resume claims one. Null: no limit. The reconcile CLI must be given the same value, or off."
  type        = number
  default     = null
  validation {
    condition     = var.owner_max_active_jobs == null ? true : var.owner_max_active_jobs >= 1 && var.owner_max_active_jobs <= 9007199254740991 && floor(var.owner_max_active_jobs) == var.owner_max_active_jobs
    error_message = "Use a positive integer up to 9007199254740991, or null for no limit."
  }
}
variable "owner_max_gpu_seconds" {
  description = "GPU seconds one owner may reserve across all of its withdrawals, never refunded (QSB_OWNER_MAX_GPU_SECONDS). It only adds to the per-job cap in server/gpu-spend.json, and must cover at least one submission's reservation. Null: no owner budget."
  type        = number
  default     = null
  validation {
    condition     = var.owner_max_gpu_seconds == null ? true : var.owner_max_gpu_seconds >= ceil(local.gpu_spend.executionTimeoutMs / 1000) && var.owner_max_gpu_seconds <= 9007199254740991 && floor(var.owner_max_gpu_seconds) == var.owner_max_gpu_seconds
    error_message = "Use an integer number of seconds of at least one submission's reservation (executionTimeoutMs in server/gpu-spend.json), or null for no owner budget."
  }
}
