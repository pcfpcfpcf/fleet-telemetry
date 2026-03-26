# Database module: EBS volumes and S3 backup bucket

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }
}

variable "environment" {
  type = string
}

variable "project_name" {
  type = string
}

variable "aws_region" {
  type = string
}

variable "backup_retention_days" {
  type = number
}

variable "backup_archive_retention_days" {
  type = number
}

variable "availability_zone" {
  type = string
}

variable "common_tags" {
  type = map(string)
}

# ====================================
# EBS VOLUME FOR TIMESCALEDB
# ====================================
# 500GB gp3 encrypted volume for time-series data storage
# Delete on termination is set to false - data persists beyond instance lifecycle
resource "aws_ebs_volume" "timescaledb" {
  availability_zone = var.availability_zone
  size              = 500
  type              = "gp3"
  encrypted         = true
  iops              = 3000 # Baseline: 3000 IOPS
  throughput        = 125  # Baseline: 125 MB/s

  tags = merge(
    var.common_tags,
    {
      Name      = "${var.project_name}-timescaledb-data-${var.environment}"
      Retention = "persistent"
    }
  )
}

# ====================================
# S3 BACKUP BUCKET
# ====================================
# Store TimescaleDB and service backups with versioning and encryption
resource "aws_s3_bucket" "backups" {
  bucket = "fleet-telemetry-backups-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-backups-${var.environment}"
    }
  )
}

# Enable versioning for backup recovery
resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Enable encryption
resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Block all public access to backup bucket
resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Lifecycle policy: expire raw backups after 90 days, archives after 2 years
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "expire-raw-backups"
    status = "Enabled"

    filter {
      prefix = "daily/"
    }

    expiration {
      days = var.backup_retention_days
    }
  }

  rule {
    id     = "expire-archives"
    status = "Enabled"

    filter {
      prefix = "monthly/"
    }

    expiration {
      days = var.backup_archive_retention_days
    }
  }

  rule {
    id     = "expire-transaction-logs"
    status = "Enabled"

    filter {
      prefix = "wal/"
    }

    expiration {
      days = 30 # WAL files kept for 30 days
    }
  }
}

# Enable logging to track access to backup bucket
resource "aws_s3_bucket_logging" "backups" {
  bucket = aws_s3_bucket.backups.id

  target_bucket = aws_s3_bucket.backups.id
  target_prefix = "logs/"
}

# ====================================
# OUTPUTS
# ====================================

output "timescaledb_volume_id" {
  value       = aws_ebs_volume.timescaledb.id
  description = "EBS volume ID for TimescaleDB data storage"
}

output "timescaledb_volume_arn" {
  value       = aws_ebs_volume.timescaledb.arn
  description = "ARN of TimescaleDB EBS volume"
}

output "backup_bucket_name" {
  value       = aws_s3_bucket.backups.id
  description = "S3 bucket name for backups"
}

output "backup_bucket_arn" {
  value       = aws_s3_bucket.backups.arn
  description = "ARN of backup bucket"
}

output "backup_bucket_region" {
  value       = aws_s3_bucket.backups.region
  description = "Region of backup bucket"
}

# Data source for AWS account ID
data "aws_caller_identity" "current" {}
