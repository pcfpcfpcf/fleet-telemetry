terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
  }

  # Backend configuration for remote state
  # Uncomment and configure for your S3 backend
  # backend "s3" {
  #   bucket         = "fleet-telemetry-terraform-state"
  #   key            = "production/terraform.tfstate"
  #   region         = "me-south-1"
  #   encrypt        = true
  #   dynamodb_table = "terraform-locks"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = merge(
      var.tags,
      {
        Environment = var.environment
        Project     = var.project_name
        ManagedBy   = "terraform"
        CreatedAt   = timestamp()
      }
    )
  }
}

# Local values for common configuration
locals {
  common_tags = merge(
    var.tags,
    {
      Environment = var.environment
      Project     = var.project_name
    }
  )

  # VPC and Network Configuration
  vpc_cidr                 = "10.0.0.0/16"
  device_subnet_cidr       = "10.0.1.0/24" # External device ingestion (no instances)
  ingestion_subnet_cidr    = "10.0.2.0/24" # EMQX, Traccar, NATS
  processing_subnet_cidr   = "10.0.3.0/24" # L4 Node.js, TimescaleDB
  presentation_subnet_cidr = "10.0.4.0/24" # Odoo

  # Instance naming
  instance_name_prefix = "${var.project_name}-${var.environment}"

  # Docker image versions
  emqx_image        = "emqx/emqx:5.3.0"
  nats_image        = "nats:2.10-alpine"
  traccar_image     = "traccar/traccar:latest"
  timescaledb_image = "timescale/timescaledb:latest-pg16"
  odoo_image        = "odoo:17"
}

# Network Module - VPC, Subnets, Route Tables, Internet Gateway
module "network" {
  source = "./network"

  environment  = var.environment
  project_name = var.project_name
  aws_region   = var.aws_region

  vpc_cidr                 = local.vpc_cidr
  device_subnet_cidr       = local.device_subnet_cidr
  ingestion_subnet_cidr    = local.ingestion_subnet_cidr
  processing_subnet_cidr   = local.processing_subnet_cidr
  presentation_subnet_cidr = local.presentation_subnet_cidr

  common_tags = local.common_tags
}

# Database Module - EBS volumes and S3 backup bucket
module "database" {
  source = "./database"

  environment  = var.environment
  project_name = var.project_name
  aws_region   = var.aws_region

  backup_retention_days         = var.backup_retention_days
  backup_archive_retention_days = var.backup_archive_retention_days
  availability_zone             = data.aws_availability_zones.available.names[0]

  common_tags = local.common_tags
}

# Messaging Module - NATS JetStream configuration
module "messaging" {
  source = "./messaging"

  environment  = var.environment
  project_name = var.project_name

  common_tags = local.common_tags

  # NATS stream definitions passed via user_data
  nats_image = local.nats_image
}

# TLS Module - AWS Private Certificate Authority
module "tls" {
  source = "./tls"

  environment  = var.environment
  project_name = var.project_name

  common_tags = local.common_tags
}

# Compute Module - All EC2 instances
module "compute" {
  source = "./compute"

  environment                = var.environment
  project_name               = var.project_name
  instance_name_prefix       = local.instance_name_prefix
  key_pair_name              = var.key_pair_name
  db_password                = var.db_password
  enable_detailed_monitoring = var.enable_detailed_monitoring
  termination_protection     = var.instance_termination_protection_enabled

  # Network configuration
  ingestion_subnet_id    = module.network.ingestion_subnet_id
  processing_subnet_id   = module.network.processing_subnet_id
  presentation_subnet_id = module.network.presentation_subnet_id

  # Security groups
  sg_emqx_id        = module.network.sg_emqx_id
  sg_traccar_id     = module.network.sg_traccar_id
  sg_nats_id        = module.network.sg_nats_id
  sg_l4_id          = module.network.sg_l4_id
  sg_timescaledb_id = module.network.sg_timescaledb_id
  sg_odoo_id        = module.network.sg_odoo_id

  # EBS volume for TimescaleDB
  timescaledb_volume_id = module.database.timescaledb_volume_id

  # Docker image references
  emqx_image        = local.emqx_image
  traccar_image     = local.traccar_image
  nats_image        = local.nats_image
  timescaledb_image = local.timescaledb_image
  odoo_image        = local.odoo_image

  common_tags = local.common_tags
}

# Data source for availability zones
data "aws_availability_zones" "available" {
  state = "available"
}

# Data source for Ubuntu AMI (latest LTS)
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}
