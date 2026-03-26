# Compute module - All EC2 instances for 6 services
# This file contain all terraform configuration, variables, and outputs for the compute module
# Individual service files (emqx.tf, traccar.tf, etc.) contain only resource definitions

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }
}

# ====================================================================
# INPUT VARIABLES
# ====================================================================

variable "environment" {
  type = string
}

variable "project_name" {
  type = string
}

variable "instance_name_prefix" {
  type = string
}

variable "key_pair_name" {
  type = string
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "enable_detailed_monitoring" {
  type = bool
}

variable "termination_protection" {
  type = bool
}

variable "ingestion_subnet_id" {
  type = string
}

variable "processing_subnet_id" {
  type = string
}

variable "presentation_subnet_id" {
  type = string
}

variable "sg_emqx_id" {
  type = string
}

variable "sg_traccar_id" {
  type = string
}

variable "sg_nats_id" {
  type = string
}

variable "sg_l4_id" {
  type = string
}

variable "sg_timescaledb_id" {
  type = string
}

variable "sg_odoo_id" {
  type = string
}

variable "timescaledb_volume_id" {
  type = string
}

variable "emqx_image" {
  type = string
}

variable "traccar_image" {
  type = string
}

variable "nats_image" {
  type = string
}

variable "timescaledb_image" {
  type = string
}

variable "odoo_image" {
  type = string
}

variable "common_tags" {
  type = map(string)
}

# Data source for Ubuntu 22.04 LTS AMI (shared by all instances)
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ====================================================================
# OUTPUTS
# ====================================================================

output "emqx_instance_id" {
  value = aws_instance.emqx.id
}

output "emqx_private_ip" {
  value = aws_instance.emqx.private_ip
}

output "emqx_public_ip" {
  value = aws_eip.emqx.public_ip
}

output "traccar_instance_id" {
  value = aws_instance.traccar.id
}

output "traccar_private_ip" {
  value = aws_instance.traccar.private_ip
}

output "nats_instance_id" {
  value = aws_instance.nats.id
}

output "nats_private_ip" {
  value = aws_instance.nats.private_ip
}

output "l4_instance_id" {
  value = aws_instance.l4.id
}

output "l4_private_ip" {
  value = aws_instance.l4.private_ip
}

output "timescaledb_instance_id" {
  value = aws_instance.timescaledb.id
}

output "timescaledb_private_ip" {
  value = aws_instance.timescaledb.private_ip
}

output "odoo_instance_id" {
  value = aws_instance.odoo.id
}

output "odoo_private_ip" {
  value = aws_instance.odoo.private_ip
}

output "odoo_public_ip" {
  value = aws_eip.odoo.public_ip
}
