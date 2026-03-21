# Security groups with strict ingress/egress rules
# Enforces network segmentation between microservices
# Each service can only reach authorized peers

data "aws_vpc" "main" {
  filter {
    name   = "tag:Name"
    values = ["${var.project_name}-vpc-${var.environment}"]
  }
}

# ====================================
# SG-EMQX: MQTT Broker
# ====================================
# Inbound: IoT devices (port 8883 TLS from internet), admin (18083 from processing)
# Outbound: Traccar (port 5055 to ingestion subnet)
resource "aws_security_group" "emqx" {
  name        = "${var.project_name}-sg-emqx-${var.environment}"
  description = "EMQX MQTT broker - accepts encrypted device connections and forwards to Traccar"
  vpc_id      = data.aws_vpc.main.id

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-sg-emqx-${var.environment}"
    }
  )
}

# Allow IoT devices to connect on port 8883 (TLS MQTT) from anywhere
resource "aws_security_group_rule" "emqx_inbound_devices" {
  type              = "ingress"
  from_port         = 8883
  to_port           = 8883
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.emqx.id
  description       = "MQTT TLS from IoT devices (internet)"
}

# Allow internal MQTT (non-TLS) only from ingestion subnet
resource "aws_security_group_rule" "emqx_inbound_internal" {
  type              = "ingress"
  from_port         = 1883
  to_port           = 1883
  protocol          = "tcp"
  cidr_blocks       = ["10.0.2.0/24"]  # ingestion_subnet_cidr
  security_group_id = aws_security_group.emqx.id
  description       = "Internal MQTT from Traccar"
}

# Allow admin dashboard access from processing subnet only
resource "aws_security_group_rule" "emqx_inbound_dashboard" {
  type              = "ingress"
  from_port         = 18083
  to_port           = 18083
  protocol          = "tcp"
  cidr_blocks       = ["10.0.3.0/24"]  # processing_subnet_cidr
  security_group_id = aws_security_group.emqx.id
  description       = "EMQX dashboard from processing subnet"
}

# Allow outbound to Traccar on port 5055
resource "aws_security_group_rule" "emqx_outbound_traccar" {
  type              = "egress"
  from_port         = 5055
  to_port           = 5055
  protocol          = "tcp"
  cidr_blocks       = ["10.0.2.0/24"]  # ingestion_subnet_cidr
  security_group_id = aws_security_group.emqx.id
  description       = "Forward MQTT to Traccar decoder"
}

# Allow DNS resolution
resource "aws_security_group_rule" "emqx_outbound_dns" {
  type              = "egress"
  from_port         = 53
  to_port           = 53
  protocol          = "udp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.emqx.id
  description       = "DNS resolution"
}

# ====================================
# SG-TRACCAR: GPS Decoder
# ====================================
# Inbound: EMQX (5055), L4 monitoring (8082 from processing)
# Outbound: NATS (4222 to ingestion subnet)
resource "aws_security_group" "traccar" {
  name        = "${var.project_name}-sg-traccar-${var.environment}"
  description = "Traccar GPS decoder - receives MQTT from EMQX, publishes to NATS"
  vpc_id      = data.aws_vpc.main.id

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-sg-traccar-${var.environment}"
    }
  )
}

# Inbound from EMQX on port 5055
resource "aws_security_group_rule" "traccar_inbound_emqx" {
  type              = "ingress"
  from_port         = 5055
  to_port           = 5055
  protocol          = "tcp"
  cidr_blocks       = ["10.0.2.0/24"]  # ingestion_subnet_cidr
  security_group_id = aws_security_group.traccar.id
  description       = "GPS data from EMQX"
}

# Inbound monitoring/web UI from processing subnet
resource "aws_security_group_rule" "traccar_inbound_monitoring" {
  type              = "ingress"
  from_port         = 8082
  to_port           = 8082
  protocol          = "tcp"
  cidr_blocks       = ["10.0.3.0/24"]  # processing_subnet_cidr
  security_group_id = aws_security_group.traccar.id
  description       = "Traccar web UI from processing subnet"
}

# Outbound to NATS on port 4222
resource "aws_security_group_rule" "traccar_outbound_nats" {
  type              = "egress"
  from_port         = 4222
  to_port           = 4222
  protocol          = "tcp"
  cidr_blocks       = ["10.0.2.0/24"]  # ingestion_subnet_cidr
  security_group_id = aws_security_group.traccar.id
  description       = "Publish decoded data to NATS"
}

# Allow DNS resolution
resource "aws_security_group_rule" "traccar_outbound_dns" {
  type              = "egress"
  from_port         = 53
  to_port           = 53
  protocol          = "udp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.traccar.id
  description       = "DNS resolution"
}

# ====================================
# SG-NATS: JetStream Message Queue
# ====================================
# Inbound: Traccar (4222), L4 Node.js (4222), Monitoring (8222 from processing)
# Outbound: L4 Node.js (3000, 3001)
resource "aws_security_group" "nats" {
  name        = "${var.project_name}-sg-nats-${var.environment}"
  description = "NATS JetStream - message queue for inter-service communication"
  vpc_id      = data.aws_vpc.main.id

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-sg-nats-${var.environment}"
    }
  )
}

# Inbound from Traccar on port 4222
resource "aws_security_group_rule" "nats_inbound_traccar" {
  type              = "ingress"
  from_port         = 4222
  to_port           = 4222
  protocol          = "tcp"
  cidr_blocks       = ["10.0.2.0/24"]  # ingestion_subnet_cidr
  security_group_id = aws_security_group.nats.id
  description       = "Stream publish from Traccar"
}

# Inbound from L4 Node.js on port 4222
resource "aws_security_group_rule" "nats_inbound_l4" {
  type              = "ingress"
  from_port         = 4222
  to_port           = 4222
  protocol          = "tcp"
  cidr_blocks       = ["10.0.3.0/24"]  # processing_subnet_cidr
  security_group_id = aws_security_group.nats.id
  description       = "Stream subscribe from L4 Node.js"
}

# Inbound monitoring from processing subnet on port 8222
resource "aws_security_group_rule" "nats_inbound_monitoring" {
  type              = "ingress"
  from_port         = 8222
  to_port           = 8222
  protocol          = "tcp"
  cidr_blocks       = ["10.0.3.0/24"]  # processing_subnet_cidr
  security_group_id = aws_security_group.nats.id
  description       = "Monitoring/jsz endpoint from processing subnet"
}

# Outbound to L4 Node.js REST API port 3000
resource "aws_security_group_rule" "nats_outbound_l4_rest" {
  type              = "egress"
  from_port         = 3000
  to_port           = 3000
  protocol          = "tcp"
  cidr_blocks       = ["10.0.3.0/24"]  # processing_subnet_cidr
  security_group_id = aws_security_group.nats.id
  description       = "Push processed data to L4 REST API"
}

# Allow DNS resolution
resource "aws_security_group_rule" "nats_outbound_dns" {
  type              = "egress"
  from_port         = 53
  to_port           = 53
  protocol          = "udp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.nats.id
  description       = "DNS resolution"
}

# ====================================
# SG-L4: L4 Node.js Processing Service
# ====================================
# Inbound: NATS (4222), REST from Odoo (3000, 3001)
# Outbound: TimescaleDB (5432), Odoo (3000, 3001)
resource "aws_security_group" "l4" {
  name        = "${var.project_name}-sg-l4-${var.environment}"
  description = "L4 Node.js - processes telemetry, stores to DB, exposes REST/WebSocket to Odoo"
  vpc_id      = data.aws_vpc.main.id

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-sg-l4-${var.environment}"
    }
  )
}

# Inbound from NATS on port 4222
resource "aws_security_group_rule" "l4_inbound_nats" {
  type              = "ingress"
  from_port         = 4222
  to_port           = 4222
  protocol          = "tcp"
  cidr_blocks       = ["10.0.2.0/24"]  # ingestion_subnet_cidr
  security_group_id = aws_security_group.l4.id
  description       = "Subscribe to NATS streams"
}

# Inbound REST API from Odoo on port 3000
resource "aws_security_group_rule" "l4_inbound_odoo_rest" {
  type              = "ingress"
  from_port         = 3000
  to_port           = 3000
  protocol          = "tcp"
  cidr_blocks       = ["10.0.4.0/24"]  # presentation_subnet_cidr
  security_group_id = aws_security_group.l4.id
  description       = "REST API calls from Odoo"
}

# Inbound WebSocket from Odoo on port 3001
resource "aws_security_group_rule" "l4_inbound_odoo_websocket" {
  type              = "ingress"
  from_port         = 3001
  to_port           = 3001
  protocol          = "tcp"
  cidr_blocks       = ["10.0.4.0/24"]  # presentation_subnet_cidr
  security_group_id = aws_security_group.l4.id
  description       = "WebSocket from Odoo for real-time updates"
}

# Outbound to TimescaleDB on port 5432
resource "aws_security_group_rule" "l4_outbound_timescaledb" {
  type              = "egress"
  from_port         = 5432
  to_port           = 5432
  protocol          = "tcp"
  cidr_blocks       = ["10.0.3.0/24"]  # processing_subnet_cidr
  security_group_id = aws_security_group.l4.id
  description       = "Write processed telemetry to TimescaleDB"
}

# Outbound to Odoo on port 443 (HTTPS)
resource "aws_security_group_rule" "l4_outbound_odoo_https" {
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["10.0.4.0/24"]  # presentation_subnet_cidr
  security_group_id = aws_security_group.l4.id
  description       = "HTTPS to Odoo for API updates"
}

# Allow DNS resolution
resource "aws_security_group_rule" "l4_outbound_dns" {
  type              = "egress"
  from_port         = 53
  to_port           = 53
  protocol          = "udp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.l4.id
  description       = "DNS resolution"
}

# ====================================
# SG-TIMESCALEDB: Time-Series Database
# ====================================
# Inbound: L4 Node.js (5432)
# Outbound: None (database only receives, doesn't initiate)
resource "aws_security_group" "timescaledb" {
  name        = "${var.project_name}-sg-timescaledb-${var.environment}"
  description = "TimescaleDB - time-series database, write-only from L4 Node.js"
  vpc_id      = data.aws_vpc.main.id

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-sg-timescaledb-${var.environment}"
    }
  )
}

# Inbound from L4 on port 5432
resource "aws_security_group_rule" "timescaledb_inbound_l4" {
  type              = "ingress"
  from_port         = 5432
  to_port           = 5432
  protocol          = "tcp"
  cidr_blocks       = ["10.0.3.0/24"]  # processing_subnet_cidr
  security_group_id = aws_security_group.timescaledb.id
  description       = "Database writes from L4 Node.js"
}

# ====================================
# SG-ODOO: ERP/Fleet Management UI
# ====================================
# Inbound: Internet (443 for fleet managers), L4 REST/WebSocket
# Outbound: L4 REST/WebSocket
resource "aws_security_group" "odoo" {
  name        = "${var.project_name}-sg-odoo-${var.environment}"
  description = "Odoo fleet management - public-facing web UI + internal API to L4"
  vpc_id      = data.aws_vpc.main.id

  tags = merge(
    var.common_tags,
    {
      Name = "${var.project_name}-sg-odoo-${var.environment}"
    }
  )
}

# Inbound HTTPS from internet (fleet managers)
resource "aws_security_group_rule" "odoo_inbound_public" {
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.odoo.id
  description       = "HTTPS from internet - fleet manager dashboards"
}

# Inbound from L4 on port 3000 (REST API)
resource "aws_security_group_rule" "odoo_inbound_l4_rest" {
  type              = "ingress"
  from_port         = 3000
  to_port           = 3000
  protocol          = "tcp"
  cidr_blocks       = ["10.0.3.0/24"]  # processing_subnet_cidr
  security_group_id = aws_security_group.odoo.id
  description       = "REST API from L4 for data delivery"
}

# Inbound from L4 on port 3001 (WebSocket)
resource "aws_security_group_rule" "odoo_inbound_l4_websocket" {
  type              = "ingress"
  from_port         = 3001
  to_port           = 3001
  protocol          = "tcp"
  cidr_blocks       = ["10.0.3.0/24"]  # processing_subnet_cidr
  security_group_id = aws_security_group.odoo.id
  description       = "WebSocket from L4 for real-time updates"
}

# Outbound to L4 REST on port 3000
resource "aws_security_group_rule" "odoo_outbound_l4_rest" {
  type              = "egress"
  from_port         = 3000
  to_port           = 3000
  protocol          = "tcp"
  cidr_blocks       = ["10.0.3.0/24"]  # processing_subnet_cidr
  security_group_id = aws_security_group.odoo.id
  description       = "REST API calls to L4"
}

# Outbound to L4 WebSocket on port 3001
resource "aws_security_group_rule" "odoo_outbound_l4_websocket" {
  type              = "egress"
  from_port         = 3001
  to_port           = 3001
  protocol          = "tcp"
  cidr_blocks       = ["10.0.3.0/24"]  # processing_subnet_cidr
  security_group_id = aws_security_group.odoo.id
  description       = "WebSocket to L4"
}

# Outbound to internet for external services
resource "aws_security_group_rule" "odoo_outbound_internet" {
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.odoo.id
  description       = "HTTPS to external services"
}

# Allow DNS resolution
resource "aws_security_group_rule" "odoo_outbound_dns" {
  type              = "egress"
  from_port         = 53
  to_port           = 53
  protocol          = "udp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.odoo.id
  description       = "DNS resolution"
}

# ====================================
# OUTPUTS
# ====================================

output "sg_emqx_id" {
  value       = aws_security_group.emqx.id
  description = "EMQX security group ID"
}

output "sg_traccar_id" {
  value       = aws_security_group.traccar.id
  description = "Traccar security group ID"
}

output "sg_nats_id" {
  value       = aws_security_group.nats.id
  description = "NATS security group ID"
}

output "sg_l4_id" {
  value       = aws_security_group.l4.id
  description = "L4 Node.js security group ID"
}

output "sg_timescaledb_id" {
  value       = aws_security_group.timescaledb.id
  description = "TimescaleDB security group ID"
}

output "sg_odoo_id" {
  value       = aws_security_group.odoo.id
  description = "Odoo security group ID"
}
