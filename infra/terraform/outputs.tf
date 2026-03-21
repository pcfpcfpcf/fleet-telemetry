# Root module outputs - expose key infrastructure endpoints

output "vpc_id" {
  value       = module.network.vpc_id
  description = "VPC ID"
}

output "vpc_cidr" {
  value       = "10.0.0.0/16"
  description = "VPC CIDR block"
}

# ====================================
# NETWORK OUTPUTS
# ====================================

output "device_subnet_id" {
  value       = module.network.device_subnet_id
  description = "Device subnet ID (10.0.1.0/24)"
}

output "ingestion_subnet_id" {
  value       = module.network.ingestion_subnet_id
  description = "Ingestion subnet ID (10.0.2.0/24) - EMQX, Traccar, NATS"
}

output "processing_subnet_id" {
  value       = module.network.processing_subnet_id
  description = "Processing subnet ID (10.0.3.0/24) - L4, TimescaleDB"
}

output "presentation_subnet_id" {
  value       = module.network.presentation_subnet_id
  description = "Presentation subnet ID (10.0.4.0/24) - Odoo"
}

# ====================================
# PUBLIC ENDPOINTS (Device & Fleet Manager Access)
# ====================================

output "emqx_public_ip" {
  value       = module.compute.emqx_public_ip
  description = "EMQX public IP for IoT device connections (port 8883 TLS)"
}

output "emqx_private_ip" {
  value       = module.compute.emqx_private_ip
  description = "EMQX private IP for internal communication"
}

output "odoo_public_ip" {
  value       = module.compute.odoo_public_ip
  description = "Odoo public IP for fleet manager dashboard access (port 443)"
}

output "odoo_access_url" {
  value       = "https://${module.compute.odoo_public_ip}"
  description = "Odoo fleet management dashboard URL"
}

# ====================================
# INTERNAL ENDPOINTS (Ingestion & Processing)
# ====================================

output "traccar_private_ip" {
  value       = module.compute.traccar_private_ip
  description = "Traccar GPS decoder internal IP (port 5055)"
}

output "nats_private_ip" {
  value       = module.compute.nats_private_ip
  description = "NATS JetStream internal IP (port 4222 publish/subscribe)"
}

output "l4_private_ip" {
  value       = module.compute.l4_private_ip
  description = "L4 Node.js processing service internal IP (port 3000 REST, 3001 WebSocket)"
}

output "timescaledb_private_ip" {
  value       = module.compute.timescaledb_private_ip
  description = "TimescaleDB internal IP (port 5432)"
}

# ====================================
# EC2 INSTANCE IDs
# ====================================

output "instance_ids" {
  value = {
    emqx       = module.compute.emqx_instance_id
    traccar    = module.compute.traccar_instance_id
    nats       = module.compute.nats_instance_id
    l4         = module.compute.l4_instance_id
    timescaledb = module.compute.timescaledb_instance_id
    odoo       = module.compute.odoo_instance_id
  }
  description = "EC2 instance IDs by service"
}

# ====================================
# STORAGE OUTPUTS
# ====================================

output "timescaledb_volume_id" {
  value       = module.database.timescaledb_volume_id
  description = "EBS volume ID for TimescaleDB data (500GB gp3, encrypted)"
}

output "backup_bucket_name" {
  value       = module.database.backup_bucket_name
  description = "S3 bucket for service backups"
}

output "backup_bucket_arn" {
  value       = module.database.backup_bucket_arn
  description = "ARN of backup bucket"
}

output "ca_certs_bucket_name" {
  value       = module.tls.ca_certs_bucket_name
  description = "S3 bucket for CA certificates"
}

# ====================================
# TLS/SECURITY OUTPUTS
# ====================================

output "certificate_authority_arn" {
  value       = module.tls.certificate_authority_arn
  description = "AWS ACM-PCA root CA ARN for device certificate issuance"
}

output "device_certificate_validity_days" {
  value       = module.tls.device_certificate_validity_days
  description = "Validity period (days) for issued FMC003 device certificates"
}

# ====================================
# CONNECTION GUIDE
# ====================================

output "architecture_summary" {
  value = <<-EOT

╔═══════════════════════════════════════════════════════════════════════════════╗
║                    FLEET TELEMETRY PLATFORM - AWS DEPLOYMENT                 ║
║                           Terraform Infrastructure                            ║
╚═══════════════════════════════════════════════════════════════════════════════╝

📍 REGION: me-south-1 (Middle East - Bahrain, closest to Saudi Arabia)
🌐 VPC CIDR: 10.0.0.0/16

┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. DEVICE CONNECTIVITY (IoT → Internet → EMQX)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│ Endpoint: ${module.compute.emqx_public_ip}:8883 (TLS MQTT)
│ Protocol: MQTT TLS/SSL
│ Auth: mTLS certificate from AWS PCA
│ Expected Load: 20,000 vehicles @ 30sec intervals
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. TELEMETRY PIPELINE (Device → EMQX → Traccar → NATS → L4 → TimescaleDB)  │
├─────────────────────────────────────────────────────────────────────────────┤
│ EMQX (Ingestion):     ${module.compute.emqx_private_ip}:8883 (public), 1883 (internal)
│ Traccar (Decoder):    ${module.compute.traccar_private_ip}:5055 (internal only)
│ NATS (Queue):         ${module.compute.nats_private_ip}:4222 (internal only)
│ L4 (Processing):      ${module.compute.l4_private_ip}:3000/3001 (internal)
│ TimescaleDB (Store):  ${module.compute.timescaledb_private_ip}:5432 (internal only)
│ Storage: /data/timescaledb (masked on 500GB EBS gp3)
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. FLEET MANAGER DASHBOARD (Bridge → Internet → Odoo)                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ Endpoint: https://${module.compute.odoo_public_ip}
│ Port: 443 (HTTPS)
│ Access: Fleet managers from anywhere
│ Real-time Updates: WebSocket from L4 (port 3001)
│ REST API: L4 (port 3000)
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. SECURITY GROUPS (Strict Network Segmentation)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│ sg-emqx:        8883 (internet) → timescaledb (5055 internal)
│ sg-traccar:     5055 (EMQX) → NATS (4222 internal)
│ sg-nats:        4222 (Traccar, L4) → L4 (3000 internal)
│ sg-l4:          4222 (NATS) ↔ 3000/3001 (Odoo) → TimescaleDB (5432), Odoo
│ sg-timescaledb: 5432 (L4 only)
│ sg-odoo:        443 (internet) ↔ L4 (3000/3001)
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. BACKUP & RECOVERY                                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ Backup Bucket: ${module.database.backup_bucket_name}
│ Retention: 90 days (raw), 730 days (archives)
│ EBS Snapshot: TimescaleDB volume ${module.database.timescaledb_volume_id}
│ Persistence: /data/* on EBS (tolerates EC2 termination)
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. CERTIFICATE AUTHORITY (Device Authentication)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│ CA ARN: ${module.tls.certificate_authority_arn}
│ Validity: 10 years (root), 1 year (devices)
│ Subject: FMC003-<device_imei>
│ Key Algorithm: RSA 2048-bit
│ Certs Bucket: ${module.tls.ca_certs_bucket_name}
└─────────────────────────────────────────────────────────────────────────────┘

NEXT STEPS:
  1. terraform apply -var="key_pair_name=<your-key>" -var="db_password=<secure-pwd>"
  2. Monitor CloudWatch alarms for instance health
  3. SSH to instances: ssh -i <key> ubuntu@<instance-ip>
  4. Check logs: docker logs <container-name>
  5. Validate connectivity: ping NATS from L4 instance
  6. Upload device certificates from S3 bucket to FMC003 devices
  7. Start fleet simulation or connect real devices
  8. Check Odoo dashboard: https://${module.compute.odoo_public_ip}

  EOT
  description = "Architecture summary and deployment guide"
}
