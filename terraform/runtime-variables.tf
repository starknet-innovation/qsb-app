variable "provision_runtime" {
  description = "Provision the dormant supervised CPU host and its supporting infrastructure. Does not start a dispatcher or GPUs."
  type        = bool
  default     = false
}
variable "runtime_ami_id" {
  description = "Pinned, reviewed x86_64 Linux AMI with SSM agent, Docker, Node 22 and Python installed; see runtime/README.md."
  type        = string
  default     = ""
  validation {
    condition     = var.runtime_ami_id == "" || can(regex("^ami-[a-f0-9]{8,17}$", var.runtime_ami_id))
    error_message = "Supply a pinned AMI ID."
  }
}
variable "runtime_ami_owner" {
  description = "Expected AMI owner account; checked before provisioning."
  type        = string
  default     = ""
}
variable "runtime_availability_zone" {
  description = "Explicit AZ for persistent EBS and host; changing it requires an evidence migration."
  type        = string
  default     = ""
}
variable "runtime_instance_type" {
  type    = string
  default = "m6i.large"
  validation {
    condition     = contains(["m6i.large", "m6i.xlarge", "m6a.large", "m6a.xlarge"], var.runtime_instance_type)
    error_message = "Use a supported x86 CPU-only host type; GPUs remain on Runpod."
  }
}
variable "runtime_vpc_cidr" {
  type    = string
  default = "10.79.0.0/16"
  validation {
    condition     = can(cidrsubnet(var.runtime_vpc_cidr, 8, 1))
    error_message = "Supply an IPv4 VPC CIDR with space for two subnets."
  }
}
variable "runtime_evidence_gib" {
  type    = number
  default = 50
  validation {
    condition     = var.runtime_evidence_gib >= 20 && var.runtime_evidence_gib <= 1000 && floor(var.runtime_evidence_gib) == var.runtime_evidence_gib
    error_message = "Evidence storage must be an integer between 20 and 1000 GiB."
  }
}
variable "cleanup_endpoints" {
  description = "Explicit operator-authorized disposable Runpod endpoints and immutable deletion deadlines. Never shared endpoints. Empty by default."
  type        = map(object({ delete_after = string }))
  default     = {}
  validation {
    condition     = length(var.cleanup_endpoints) <= 10 && alltrue([for id, item in var.cleanup_endpoints : can(regex("^[a-z0-9]{10,32}$", id)) && can(timecmp(item.delete_after, "2026-01-01T00:00:00Z"))])
    error_message = "At most ten endpoint IDs with RFC3339 deadlines are supported."
  }
}
