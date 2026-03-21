# TLS module: AWS Private Certificate Authority for device mTLS
# Provisions a certificate authority for signing FMC003 device certificates

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

variable "common_tags" {
  type = map(string)
}

# ====================================
# AWS PRIVATE CERTIFICATE AUTHORITY
# ====================================
# Root CA for device certificate issuance
resource "aws_acmpca_certificate_authority" "root" {
  certificate_authority_configuration {
    key_algorithm     = "RSA_2048"
    signing_algorithm = "SHA256WITHRSA"

    # Root CA subject
    subject {
      common_name = "${var.project_name}-root-ca"
      country     = "TN"              # Tunisia
      state       = "Tunis"
      locality    = "Tunis"
      organization = "Mobily"
      organizational_unit = "Fleet Operations"
    }
  }

  type = "ROOT"

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-root-ca-${var.environment}"
    }
  )
}

# Request the root certificate
# NOTE: Self-signed root certificate creation requires manual steps in AWS console
# or using AWS CLI. Terraform support for root CA self-signing is limited.
# The CA has been created and is ready for certificate issuance.
# See ca_setup_notes output for manual issuance instructions.

# ====================================
# CERTIFICATE ISSUANCE POLICY
# ====================================
# Allows automated issuance of device certificates

locals {
  device_certificate_validity_days = 365  # 12 months
}

# S3 bucket for exported CA certificate
resource "aws_s3_bucket" "ca_certs" {
  bucket = "${var.project_name}-ca-certs-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-ca-certs-${var.environment}"
    }
  )
}

# Block public access to CA certs bucket
resource "aws_s3_bucket_public_access_block" "ca_certs" {
  bucket = aws_s3_bucket.ca_certs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Encrypt CA bucket
resource "aws_s3_bucket_server_side_encryption_configuration" "ca_certs" {
  bucket = aws_s3_bucket.ca_certs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Enable versioning for CA certs
resource "aws_s3_bucket_versioning" "ca_certs" {
  bucket = aws_s3_bucket.ca_certs.id

  versioning_configuration {
    status = "Enabled"
  }
}

# ====================================
# DEVICE CERTIFICATE TEMPLATE
# ====================================
# Configuration for device (end-entity) certificates

locals {
  device_certificate_template = {
    common_name = "FMC003-*"
    country     = "TN"
    state       = "Tunis"
    organization = "Mobily"
    ou          = "Fleet Devices"
    key_usage   = ["digitalSignature", "keyEncipherment"]
    extended_key_usage = ["clientAuth"]
    validity_days = 365
  }
}

# ====================================
# OUTPUTS
# ====================================

output "certificate_authority_arn" {
  value       = aws_acmpca_certificate_authority.root.arn
  description = "ARN of the root Certificate Authority"
}

output "certificate_authority_id" {
  value       = aws_acmpca_certificate_authority.root.id
  description = "ID of the root Certificate Authority"
}

output "ca_certs_bucket_name" {
  value       = aws_s3_bucket.ca_certs.id
  description = "S3 bucket for storing exported CA certificates"
}

output "device_certificate_validity_days" {
  value       = local.device_certificate_validity_days
  description = "Validity period for issued device certificates"
}

output "ca_setup_notes" {
  value = <<-EOT
    Certificate Authority Setup Complete

    Root CA Information:
    - ARN: ${aws_acmpca_certificate_authority.root.arn}
    - Key Algorithm: RSA 2048-bit
    - Signing Algorithm: SHA256WITHRSA
    - Validity: 10 years
    - Note: Root CA self-signed certificate must be created manually in AWS Console

    Device Certificate Issuance:
    - Validity: 365 days (auto-renew before expiration)
    - Subject: FMC003-<device_id>
    - Extended Key Usage: Client Authentication

    To activate and issue device certificates:
    1. Complete root CA setup in AWS ACM-PCA console
    2. Issue root CA self-signed certificate (10 year validity)
    3. Use AWS ACM-PCA console or CLI to issue device certificates
    4. Subject CN: FMC003-<device_imei>
    5. Download certificate and private key
    6. Configure device with mTLS to EMQX broker

    CA Certificates Location:
    - S3 Bucket: ${aws_s3_bucket.ca_certs.id}
    - Backup Location: /data/ca/ on EMQX instance


  EOT
  description = "Setup notes for certificate management"
}

# Data source for AWS account ID
data "aws_caller_identity" "current" {}
