variable "environment" {
  description = "Deployment environment (production, staging, dev)"
  type        = string
  default     = "production"
}

variable "aws_region" {
  description = "AWS region for infrastructure deployment"
  type        = string
  default     = "me-south-1" # Middle East (Bahrain), closest to Saudi Arabia
}

variable "project_name" {
  description = "Name of the project for resource naming"
  type        = string
  default     = "fleet-telemetry"
}

variable "db_password" {
  description = "TimescaleDB root password"
  type        = string
  sensitive   = true
}

variable "key_pair_name" {
  description = "AWS EC2 key pair name for SSH access to instances"
  type        = string
}

variable "owner_email" {
  description = "Cloud engineer or operator email for notifications"
  type        = string
  default     = "cloud-engineer@example.com"
}

variable "backup_retention_days" {
  description = "Number of days to retain raw backups in S3"
  type        = number
  default     = 90
}

variable "backup_archive_retention_days" {
  description = "Number of days to retain archived backups (2 years default)"
  type        = number
  default     = 730
}

variable "instance_termination_protection_enabled" {
  description = "Enable termination protection on production instances"
  type        = bool
  default     = true
}

variable "enable_detailed_monitoring" {
  description = "Enable CloudWatch detailed monitoring on EC2 instances"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Common tags applied to all resources"
  type        = map(string)
  default = {
    Project   = "fleet-telemetry"
    ManagedBy = "terraform"
    Owner     = "cloud-engineer"
    Client    = "mobily-fleet-operations"
  }
}
