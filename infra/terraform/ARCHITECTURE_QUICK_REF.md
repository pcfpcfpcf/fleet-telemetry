# AWS Infrastructure Architecture — Quick Reference

## 🎯 What Was Built

Complete microservices platform for real-time fleet telemetry processing on AWS.

```
┌─────────────────────────────────────────────────────────────────┐
│              FLEET TELEMETRY PLATFORM - AWS DEPLOYMENT           │
│                    Production-Ready Terraform Code               │
└─────────────────────────────────────────────────────────────────┘

REGION: me-south-1 (Middle East - Bahrain) - closest to Saudi Arabia

┌────────────┐
│ 20,000     │      EMQX (t3.medium)         Traccar (t3.medium)
│ vehicles   │─◆────┬────────────────────────┬────────────────────◆
│ (internet) │      │ MQTT TLS:8883          │ GPS Decoder:5055
│            │      │ Internal:1883           │ Web UI:8082
│            │      ◄─────────────────────────┘
│            │
│            └──► Ingestion Subnet (10.0.2.0/24)
│                 ├─ EMQX: 10.0.2.10
│                 ├─ Traccar: 10.0.2.20
│                 └─ NATS: 10.0.2.30
│
│                 NATS JetStream (t3.medium)
│                 ├─ Publish: 4222
│                 └─ Monitor: 8222
│
│       Processing Subnet (10.0.3.0/24)
│       ├─ L4 Node.js (t3.large): 10.0.3.40
│       │  ├─ REST API: 3000
│       │  └─ WebSocket: 3001
│       │
│       └─ TimescaleDB (r5.xlarge): 10.0.3.50
│          ├─ Port: 5432
│          └─ Storage: 500GB EBS gp3 encrypted
│
│       Presentation Subnet (10.0.4.0/24)
│       └─ Odoo (t3.xlarge): 10.0.4.60
│          ├─ HTTPS: 443 (public)
│          └─ Internal: 8069


```

## 📊 Instance Summary

| Service | Type | vCPU | RAM | Network | Ports |
|---------|------|------|-----|---------|-------|
| EMQX | t3.medium | 2 | 4GB | ingestion | 1883, 8883, 18083 |
| Traccar | t3.medium | 2 | 4GB | ingestion | 5055, 8082 |
| NATS | t3.medium | 2 | 4GB | ingestion | 4222, 8222 |
| L4 Node.js | t3.large | 2 | 8GB | processing | 3000, 3001 |
| TimescaleDB | r5.xlarge | 4 | 32GB | processing | 5432 |
| Odoo | t3.xlarge | 4 | 16GB | presentation | 443, 8069 |
| **TOTAL** | - | **18** | **68GB** | - | - |

## 🔐 Security Groups (Network Segmentation)

**sg-emqx** (MQTT Broker)
- `→ 8883` Internet (devices with TLS)
- `→ 1883` Ingestion subnet (internal)
- `→ 18083` Processing subnet (dashboard)
- `← 5055` Traccar (forward decoded data)

**sg-traccar** (GPS Decoder)
- `→ 5055` EMQX (from MQTT)
- `→ 8082` Processing subnet (web UI)
- `← 4222` NATS (publish)

**sg-nats** (JetStream Queue)
- `→ 4222` Traccar, L4 (streams)
- `→ 8222` Processing subnet (monitoring)
- `← 3000` L4 (push processed)

**sg-l4** (Node.js Processor)
- `→ 4222` NATS (subscribe)
- `→ 3000/3001` Odoo (REST/WS)
- `← 5432` TimescaleDB (writes)
- `← 3000/3001` Odoo (REST/WS)

**sg-timescaledb** (Time-Series DB)
- `→ 5432` L4 only (writes)

**sg-odoo** (Fleet Management UI)
- `→ 443` Internet (fleet managers)
- `→ 3000/3001` L4 (REST/WS)
- `← 3000/3001` L4 (data pushes)

## 💾 Storage

**EBS Volume** (TimescaleDB Data)
- Size: 500GB gp3
- Encryption: AES-256 (AWS managed)
- Mount: `/data/timescaledb` (inside container)
- Persistence: Survives EC2 termination

**S3 Backup Bucket**
- Name: `fleet-telemetry-backups-production-<account-id>`
- Versioning: Enabled
- Lifecycle:
  - Raw backups: 90 days
  - Archives: 730 days (2 years)
  - WAL logs: 30 days
- Access: Private (block all public)

## 🔒 Certificates & TLS

**AWS Private CA (ACM PCA)**
- Type: ROOT CA
- Key: RSA 2048-bit
- Signing: SHA256WITHRSA
- Validity: 10 years (CA), 12 months (devices)
- Purpose: mTLS for device authentication

**Device Certificates**
- Subject: `CN=FMC003-<device_imei>`
- Extended Key Usage: Client Authentication
- Issued by: AWS ACM-PCA
- Storage: S3 bucket (fleet-telemetry-ca-certs-\*)

## 📈 Data Flow

```
Device (20,000 vehicles)
  ↓ (MQTT TLS)
EMQX (t3.medium, 10.0.2.10)
  │ ├─ Listen: 8883 (public), 1883 (internal)
  │ └─ 100k+ msgs/min baseline
  ↓ (MQTT forward)
Traccar (t3.medium, 10.0.2.20)
  │ ├─ Decode GPS frames
  │ └─ 5055 internal only
  ↓ (NATS publish)
NATS JetStream (t3.medium, 10.0.2.30)
  │ ├─ Topics: telemetry.raw.*, processed.*, alerts.*
  │ └─ 4222 internal, 8222 monitoring
  ↓ (NATS subscribe)
L4 Node.js (t3.large, 10.0.3.40)
  │ ├─ Process, normalize, validate
  │ ├─ REST API: 3000
  │ └─ WebSocket: 3001
  ↓ (SQL INSERT)
TimescaleDB (r5.xlarge, 10.0.3.50)
  │ ├─ Hypertables: telemetry, alerts
  │ ├─ Retention: 24h (telemetry), 7d (alerts)
  │ └─ 5432 internal only
  ↓ (REST/WS)
Odoo (t3.xlarge, 10.0.4.60)
  │ ├─ Dashboard for fleet managers
  │ ├─ Real-time map + alerts
  │ └─ 443 public HTTPS
  ↓
Fleet Managers (Internet)
```

## 🚀 Quick Start Commands

```bash
# Setup
cd infra/terraform
terraform init

# Configure
cat > terraform.tfvars <<EOF
key_pair_name = "your-key"
db_password = "SecurePassword123!"
EOF

# Deploy
terraform plan -out=tfplan
terraform apply tfplan

# Verify
terraform output emqx_public_ip
terraform output odoo_access_url

# Get all outputs
terraform output -json > infra.json

# Cleanup
terraform destroy
```

## 🔍 Validate Deployment

```bash
# SSH into instances
ssh -i your-key.pem ubuntu@<EMQX-IP>
ssh -i your-key.pem ubuntu@<L4-IP>
ssh -i your-key.pem ubuntu@<ODOO-IP>

# Check containers
docker ps -a
docker logs -f emqx

# Test NATS (from L4)
curl http://10.0.2.30:8222/jsz | jq

# Test TimescaleDB (from L4)
psql -h 10.0.3.50 -U fleet -d fleet -c "SELECT version();"

# Check backups
aws s3 ls s3://fleet-telemetry-backups-production-<account-id>/

# View Odoo
open https://<ODOO-PUBLIC-IP>
```

## 💰 Cost Estimate

Monthly estimate (730 hours):
- EC2 instances: ~€145
- EBS volume (500GB gp3): ~€40
- S3 backups: ~€5
- Data transfer: ~€10
- Backup bucket: ~€5
- ACM PCA: ~€5
- CloudWatch: ~€5
- **Total**: ~€215/month

## 🛠️ Configuration Files

**Root Level**
- `main.tf` — Provider, backend, modules
- `variables.tf` — Input variables
- `outputs.tf` — Exposed endpoints
- `terraform.tfvars.example` — Variable template

**Modules**
- `network/main.tf` — VPC, subnets, route tables
- `network/security.tf` — Security groups
- `compute/main.tf` — Orchestrator
- `compute/{emqx,traccar,nats,l4,timescaledb,odoo}.tf` — EC2 instances
- `database/main.tf` — EBS + S3
- `messaging/main.tf` — NATS streams
- `tls/main.tf` — AWS Private CA

**Documentation**
- `README.md` — Complete guide
- `DEPLOYMENT.md` — Deployment checklist
- `ARCHITECTURE_QUICK_REF.md` — This file

## 📞 Support & Troubleshooting

**Instance won't start**
```bash
aws ec2 get-console-output --instance-id <id> --region eu-west-1
ssh ubuntu@<ip> cat /var/log/cloud-init-output.log
```

**Container not running**
```bash
docker logs <container>
docker inspect <container> | grep -i error
```

**Network connectivity**
```bash
nc -zv <target-ip> <port>
aws ec2 describe-security-groups --group-ids <sg-id>
```

**State conflicts**
```bash
terraform refresh
terraform plan
```

---

**Last Updated**: March 2026  
**Terraform Version**: >= 1.5  
**Status**: Production-Ready
