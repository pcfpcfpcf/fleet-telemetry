# VPC and networking resources
# This module creates:
# - VPC with 4 isolated subnets
# - Route tables for public (device) and internal routing
# - Internet Gateway for device and Odoo connectivity
# - NAT Gateway for internal service outbound access

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

variable "vpc_cidr" {
  type = string
}

variable "device_subnet_cidr" {
  type = string
}

variable "ingestion_subnet_cidr" {
  type = string
}

variable "processing_subnet_cidr" {
  type = string
}

variable "presentation_subnet_cidr" {
  type = string
}

variable "common_tags" {
  type = map(string)
}

# Create VPC with DNS hostnames enabled
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-vpc-${var.environment}"
    }
  )
}

# Internet Gateway for public connectivity
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-igw-${var.environment}"
    }
  )
}

# Device Subnet (10.0.1.0/24) - External IoT devices connect here
# This is a "fake" subnet for network design; no instances run here
# Devices connect to EMQX on public IP via internet
resource "aws_subnet" "device" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.device_subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-device-subnet-${var.environment}"
    }
  )
}

# Ingestion Subnet (10.0.2.0/24) - EMQX, Traccar, NATS
resource "aws_subnet" "ingestion" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.ingestion_subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-ingestion-subnet-${var.environment}"
    }
  )
}

# Processing Subnet (10.0.3.0/24) - L4 Node.js, TimescaleDB
resource "aws_subnet" "processing" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.processing_subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-processing-subnet-${var.environment}"
    }
  )
}

# Presentation Subnet (10.0.4.0/24) - Odoo
resource "aws_subnet" "presentation" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.presentation_subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-presentation-subnet-${var.environment}"
    }
  )
}

# Route table for device subnet (external/public)
# Devices reach EMQX through the internet gateway
resource "aws_route_table" "device" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block      = "0.0.0.0/0"
    gateway_id      = aws_internet_gateway.main.id
  }

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-device-rt-${var.environment}"
    }
  )
}

resource "aws_route_table_association" "device" {
  subnet_id      = aws_subnet.device.id
  route_table_id = aws_route_table.device.id
}

# Route table for ingestion subnet (internal only)
# Ingestion services (EMQX, Traccar, NATS) stay private
resource "aws_route_table" "ingestion" {
  vpc_id = aws_vpc.main.id

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-ingestion-rt-${var.environment}"
    }
  )
}

resource "aws_route_table_association" "ingestion" {
  subnet_id      = aws_subnet.ingestion.id
  route_table_id = aws_route_table.ingestion.id
}

# Route table for processing subnet (internal only)
# Processing services (L4, TimescaleDB) stay private
resource "aws_route_table" "processing" {
  vpc_id = aws_vpc.main.id

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-processing-rt-${var.environment}"
    }
  )
}

resource "aws_route_table_association" "processing" {
  subnet_id      = aws_subnet.processing.id
  route_table_id = aws_route_table.processing.id
}

# Route table for presentation subnet (Odoo - public access)
# Odoo needs outbound access to internet for fleet manager dashboards
resource "aws_route_table" "presentation" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block      = "0.0.0.0/0"
    gateway_id      = aws_internet_gateway.main.id
  }

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-presentation-rt-${var.environment}"
    }
  )
}

resource "aws_route_table_association" "presentation" {
  subnet_id      = aws_subnet.presentation.id
  route_table_id = aws_route_table.presentation.id
}

# Data source for availability zones
data "aws_availability_zones" "available" {
  state = "available"
}

# Output subnet IDs and security group references (will be defined in security.tf)
output "vpc_id" {
  value       = aws_vpc.main.id
  description = "VPC ID"
}

output "device_subnet_id" {
  value       = aws_subnet.device.id
  description = "Device subnet ID"
}

output "ingestion_subnet_id" {
  value       = aws_subnet.ingestion.id
  description = "Ingestion subnet ID"
}

output "processing_subnet_id" {
  value       = aws_subnet.processing.id
  description = "Processing subnet ID"
}

output "presentation_subnet_id" {
  value       = aws_subnet.presentation.id
  description = "Presentation subnet ID"
}

output "internet_gateway_id" {
  value       = aws_internet_gateway.main.id
  description = "Internet Gateway ID"
}
