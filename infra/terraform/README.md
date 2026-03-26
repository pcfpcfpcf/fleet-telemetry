# Fleet Telemetry Platform — AWS Terraform Infrastructure

Production-ready Terraform code for deploying a complete 6-service microservices platform on AWS that processes real-time telemetry from 20,000 vehicles.

## 📋 Overview

This Terraform configuration deploys:

| Service | Instance | vCPU | RAM | Subnet | Purpose |
|---------|----------|------|-----|--------|---------|
| **EMQX** | t3.medium | 2 | 4GB | ingestion | MQTT broker (1883 internal, 8883 TLS public) |
| **Traccar** | t3.medium | 2 | 4GB | ingestion | GPS data decoder |
| **NATS JetStream** | t3.medium | 2 | 4GB | ingestion | Message queue (4222) |
| **L4 Node.js** | t3.large | 2 | 8GB | processing | Telemetry processor (3000/3001) |
| **TimescaleDB** | r5.xlarge | 4 | 32GB | processing | Time-series database (5432) |
| **Odoo** | t3.xlarge | 4 | 16GB | presentation | Fleet management UI (443) |

**Network Architecture**: 4 isolated subnets with strict security group rules.

```
Device Subnet (10.0.1.0/24)       ← No instances, external device entry point
    ↓
Ingestion Subnet (10.0.2.0/24)    ← EMQX, Traccar, NATS
    ↓
Processing Subnet (10.0.3.0/24)   ← L4 Node.js, TimescaleDB
    ↓
Presentation Subnet (10.0.4.0/24) ← Odoo (fleet managers)
```

## 📁 Folder Structure

```
infra/terraform/
├── main.tf                 # AWS provider, backend, module orchestration
├── variables.tf            # Input variables (environment, region, etc.)
├── outputs.tf              # Exposed endpoints and IDs
│
├── network/
│   ├── main.tf            # VPC, subnets, route tables, IGW
│   └── security.tf        # 6 security groups with strict rules
│
├── compute/
│   ├── main.tf            # EC2 module orchestrator
│   ├── emqx.tf            # EMQX MQTT broker (t3.medium)
│   ├── traccar.tf         # Traccar decoder (t3.medium)
│   ├── nats.tf            # NATS JetStream (t3.medium)
│   ├── l4.tf              # L4 Node.js (t3.large)
│   ├── timescaledb.tf     # TimescaleDB (r5.xlarge)
│   └── odoo.tf            # Odoo ERP (t3.xlarge)
│
├── database/
│   └── main.tf            # EBS volumes (TimescaleDB), S3 backup bucket
│
├── messaging/
│   └── main.tf            # NATS JetStream stream definitions
│
└── tls/
    └── main.tf            # AWS Private CA for device certificates
```

## 🚀 Quick Start

### Prerequisites

1. **AWS Account** with appropriate IAM permissions
2. **Terraform** >= 1.5
3. **AWS CLI** configured with credentials
4. **EC2 Key Pair** created in me-south-1 region

```bash
# Create a key pair if you don't have one
aws ec2 create-key-pair --key-name fleet-telemetry-key --region me-south-1 --query 'KeyMaterial' --output text > fleet-telemetry-key.pem
chmod 600 fleet-telemetry-key.pem
```

### Deploy Infrastructure

1. **Initialize Terraform**:
   ```bash
   cd infra/terraform
   terraform init
   ```

2. **Create tfvars file**:
   ```bash
   cat > terraform.tfvars <<EOF
   key_pair_name = "fleet-telemetry-key"
   db_password = "YourSecurePasswordHere123!"
   environment = "production"
   aws_region = "me-south-1"
   EOF
   ```

3. **Review plan**:
   ```bash
   terraform plan -out=tfplan
   ```

4. **Apply infrastructure**:
   ```bash
   terraform apply tfplan
   ```

5. **Capture outputs**:
   ```bash
   terraform output -json > infrastructure.json
   ```

## 🔐 Security Groups (Network Segmentation)

### Routing Enforcement

```
┌──────────────────────────────────────────────────────┐
│ STRICT INGRESS/EGRESS RULES (No cross-subnet spam)   │
├──────────────────────────────────────────────────────┤
│ • Devices (internet) → EMQX:8883 only                │
│ • EMQX ↔ Traccar:5055 (internal)                     │
│ • Traccar → NATS:4222 only                           │
│ • NATS → L4:3000/3001 only                           │
│ • L4 ↔ TimescaleDB:5432                              │
│ • L4 ↔ Odoo:3000/3001                                │
│ • Odoo port 443 ← Internet (fleet managers)          │
│ • All others: DENIED                                 │
└──────────────────────────────────────────────────────┘
```

## 💾 Storage & Backup

### TimescaleDB Data Volume
- **Size**: 500GB gp3
- **Encryption**: AES-256 (AWS managed)
- **Persistence**: EBS survives instance termination
- **Mount**: `/data/timescaledb` (inside container)

### S3 Backup Bucket
- **Versioning**: Enabled
- **Encryption**: AES-256
- **Lifecycle**:
  - Raw backups: 90 days
  - Archives: 730 days (2 years)
  - WAL logs: 30 days
- **Access**: Private (block all public)

## 🔒 TLS & Device Certificates

### AWS Private Certificate Authority
- **Type**: ROOT CA
- **Key Algorithm**: RSA 2048-bit
- **Signing**: SHA256WITHRSA
- **Validity**: 10 years (CA), 12 months (devices)
- **Subject**: `CN=FMC003-<device_imei>`
- **Purpose**: mTLS for device authentication to EMQX

### Certificate Issuance Workflow
1. Generate device CSR on FMC003
2. Sign via AWS ACM-PCA console/CLI
3. Download certificate + private key
4. Deploy to device
5. Device connects to EMQX:8883 with mTLS

## 🎯 Deployment Flow

```
1. terraform init       ← Download providers
2. terraform plan       ← Preview changes
3. terraform apply      ← Create VPC, subnets, SGs, EBS, S3, CA
4. EC2 instances boot   ← User data scripts install Docker
5. Containers start     ← Each service ready in 2-3 minutes
6. Health checks pass   ← CloudWatch confirms all running
7. Devices connect      ← EMQX receives MQTT @ 20k/min baseline
8. Data flows end-to-end← Device → EMQX → Traccar → NATS → L4 → TimescaleDB
9. Odoo dashboard ready← Fleet managers access https://<EIP>
```

## 📊 CloudWatch & Monitoring

Each EC2 instance has:
- **Status Check Alarms**: Alert on failed health checks
- **Detailed Monitoring**: CPU, network, disk (if configured)
- **Custom Metrics**: Can be added per service

Enable detailed monitoring:
```bash
terraform apply -var="enable_detailed_monitoring=true"
```

## 🔧 Configuration & Variables

### Required Variables
| Variable | Description | Example |
|----------|-------------|---------|
| `key_pair_name` | EC2 key pair for SSH | `fleet-telemetry-key` |
| `db_password` | TimescaleDB root password | `YourSecurePassword123!` |

### Optional Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `environment` | `production` | Deployment environment tag |
| `aws_region` | `me-south-1` | AWS region (Middle East - Bahrain, closest to Saudi Arabia) |
| `project_name` | `fleet-telemetry` | Project name prefix |
| `backup_retention_days` | `90` | Raw backup retention |
| `backup_archive_retention_days` | `730` | Archive retention (2 years) |
| `instance_termination_protection_enabled` | `true` | Prevent accidental shutdown |
| `enable_detailed_monitoring` | `true` | CloudWatch detailed metrics |

## 🚪 SSH Access

```bash
# Get instance IPs
terraform output instance_ids

# SSH to EMQX
ssh -i fleet-telemetry-key.pem ubuntu@<EMQX-IP>

# Check Docker containers
docker ps -a

# View logs
docker logs emqx
docker logs nats
docker logs timescaledb
```

## 🔍 Health Checks

### Verify Connectivity

```bash
# From L4 instance → NATS
curl -s http://10.0.2.30:8222/jsz | jq

# From L4 instance → TimescaleDB
psql -h 10.0.3.50 -U fleet -d fleet -c "SELECT version();"

# Odoo dashboard
curl -k https://<ODOO-EIP>
```

### Container Logs
```bash
# SSH to any instance
docker logs -f <service-name>

# Example: Check EMQX broker status
docker exec emqx emqx ctl status
```

## 💰 Cost Estimation

**Monthly cost estimate** (me-south-1, 730 hours):
- EMQX (t3.medium): ~€15
- Traccar (t3.medium): ~€15
- NATS (t3.medium): ~€15
- L4 (t3.large): ~€30
- TimescaleDB (r5.xlarge, memory-optimized): ~€100
- Odoo (t3.xlarge): ~€60
- EBS (500GB gp3): ~€40
- S3 backups: ~€5
- Data transfer: ~€10
- **Total**: ~€290/month

## 🧹 Cleanup

```bash
# Destroy infrastructure (keeps S3 backups and EBS snapshots)
terraform destroy

# Remove everything including backups
terraform destroy && \
  aws s3 rm s3://fleet-telemetry-backups-production-$(aws sts get-caller-identity --query Account --output text) --recursive
```

## 🛠️ Troubleshooting

### Instance fails to start
- Check user_data script: `aws ec2 get-launch-template-data --launch-template-id <id>`
- Verify Docker image availability
- Check CloudWatch logs

### Containers won't stay running
- Check volume permissions: `docker inspect <container>`
- Verify environment variables passed to container
- Check disk space: `docker system df`

### Network connectivity issues
- Verify security group rules: `aws ec2 describe-security-groups --group-ids <sg-id>`
- Check route tables: `aws ec2 describe-route-tables`
- Test with `ncat` from EC2 instances

## 📝 Tags Applied

All resources are tagged with:
```hcl
tags = {
  Project     = "fleet-telemetry"
  Environment = var.environment
  ManagedBy   = "terraform"
  Owner       = "cloud-engineer"
  Client      = "mobily-fleet-operations"
}
```

## 📚 Additional Resources

- [AWS VPC Documentation](https://docs.aws.amazon.com/vpc/)
- [EC2 Instance Types](https://aws.amazon.com/ec2/instance-types/)
- [Terraform AWS Provider](https://registry.terraform.io/providers/hashicorp/aws/latest)
- [EMQX Docker Image](https://hub.docker.com/r/emqx/emqx)
- [TimescaleDB Documentation](https://docs.timescale.com/)
- [NATS JetStream Guide](https://docs.nats.io/nats-concepts/jetstream)

## 🤝 Support

For infrastructure issues:
1. Check CloudWatch logs and alarms
2. Verify SSH access to instances
3. Review Terraform state: `terraform show`
4. Compare running instances with plan: `terraform plan`

---

**Last Updated**: March 2026  
**Terraform Version**: >= 1.5  
**AWS Provider**: >= 5.40
