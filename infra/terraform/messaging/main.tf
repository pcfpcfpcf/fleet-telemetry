# Messaging module: NATS JetStream stream definitions
# Note: Streams are created via user_data scripts on NATS instance
# This module provides documentation and can house stream configuration as code

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

variable "nats_image" {
  type = string
}

variable "common_tags" {
  type = map(string)
}

# ====================================
# NATS JETSTREAM STREAM DEFINITIONS
# ====================================
# These are created via user_data on the NATS instance
# Documented here for reference and automation

locals {
  nats_streams = {
    telemetry = {
      name        = "TELEMETRY"
      description = "Raw telemetry from all devices via Traccar"
      subjects    = ["telemetry.raw.*"]
      retention   = "86400s"  # 24 hours
      max_age     = 86400
      storage     = "file"
      replicas    = 1
      max_msgs    = 1000000
    }
    
    processed = {
      name        = "PROCESSED"
      description = "Processed telemetry after L4 normalization"
      subjects    = ["processed.>"]
      retention   = "86400s"
      max_age     = 86400
      storage     = "file"
      replicas    = 1
      max_msgs    = 500000
    }

    alerts = {
      name        = "ALERTS"
      description = "Real-time alerts (speeding, fuel, engine anomalies)"
      subjects    = ["alerts.>"]
      retention   = "604800s"  # 7 days
      max_age     = 604800
      storage     = "file"
      replicas    = 1
      max_msgs    = 50000
    }
  }
}

# Local file with stream configuration for manual management
resource "local_file" "nats_stream_config" {
  filename = "${path.module}/nats-streams.json"
  content  = jsonencode(local.nats_streams)
}

# ====================================
# NOTES: STREAM CREATION
# ====================================
# Streams are auto-created by the adapter on startup:
#
# From adapter/adapter.js:
# ```
# const js = nc.jetstream();
# const jsm = new JetStreamManager(nc);
# await jsm.streams.add({
#   name: "TELEMETRY",
#   subjects: ["telemetry.raw.*"],
#   retention: "limits",
#   max_age: 24 * 60 * 60 * 1000,  // 24 hours
#   storage: "file",
#   duplicateWindow: 2 * 60 * 1000,
# });
# ```
#
# Stream Recovery:
# If NATS container is removed, streams can be reconstructed from /data/nats
# which is persisted on AWS EBS (via docker volume mount)

# Outputs for reference
output "telemetry_stream_name" {
  value       = local.nats_streams.telemetry.name
  description = "Primary telemetry stream name"
}

output "processed_stream_name" {
  value       = local.nats_streams.processed.name
  description = "Processed data stream name"
}

output "alerts_stream_name" {
  value       = local.nats_streams.alerts.name
  description = "Alerts stream name"
}

output "nats_docker_image" {
  value       = var.nats_image
  description = "NATS Docker image used in deployment"
}
