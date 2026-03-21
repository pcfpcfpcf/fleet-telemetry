# Terraform Deployment Checklist

## Pre-Deployment Checklist

- [ ] **AWS Account Ready**
  - [ ] AWS account created
  - [ ] IAM user with EC2, VPC, RDS, S3, IAM permissions
  - [ ] AWS CLI installed and configured: `aws sts get-caller-identity`

- [ ] **Prerequisites Installed**
  - [ ] Terraform >= 1.5: `terraform version`
  - [ ] Git (for cloning repo): `git --version`
  - [ ] SSH client (for instance access)

- [ ] **AWS EC2 Key Pair Created**
  - [ ] Key pair exists in me-south-1: `aws ec2 describe-key-pairs --region me-south-1`
  - [ ] Private key file downloaded and saved locally (e.g., `fleet-telemetry-key.pem`)
  - [ ] Private key permissions set: `chmod 600 fleet-telemetry-key.pem`

- [ ] **Terraform Configuration Ready**
  - [ ] `terraform.tfvars` file created with required variables:
    ```hcl
    key_pair_name = "fleet-telemetry-key"
    db_password = "YourSecurePassword123!"
    ```
  - [ ] terraform.tfvars added to `.gitignore` (don't commit credentials)

- [ ] **Quota Checks**
  - [ ] VPC limit: minimum 1 VPC required
  - [ ] Elastic IPs limit: minimum 2 required (EMQX + Odoo)
  - [ ] On-demand EC2 instances: at least 20 vCPU available

## Deployment Steps

### 1. Initialize Terraform
```bash
cd infra/terraform
terraform init
```
Expected: "Terraform has been successfully initialized!"

### 2. Review Plan
```bash
terraform plan -out=tfplan
```
Expected: Shows 60+ resources to create (6 EC2 + networking + storage + TLS)

### 3. Apply Infrastructure
```bash
terraform apply tfplan
```
Expected: 
- Completes in 5-10 minutes
- Shows all resource creations
- Outputs: emqx_public_ip, odoo_public_ip, etc.

### 4. Capture Outputs
```bash
terraform output -json > infrastructure.json
echo "EMQX Public IP: $(terraform output -raw emqx_public_ip)"
echo "Odoo URL: $(terraform output -raw odoo_access_url)"
```

## Post-Deployment Verification

### 1. Check Instance Status (5 minutes after apply)
```bash
# List instances
aws ec2 describe-instances --region eu-west-1 \
  --filters "Name=tag:Project,Values=fleet-telemetry" \
  --query 'Reservations[].Instances[].{ID:InstanceId,State:State.Name,IP:PrivateIpAddress}'
```
Expected: All instances in "running" state

### 2. Verify Container Startup (5-10 minutes after apply)
```bash
# SSH to EMQX instance
ssh -i fleet-telemetry-key.pem ubuntu@<EMQX-PUBLIC-IP>

# Check Docker containers
docker ps -a
```
Expected: See emqx container running (or other service containers)

### 3. Test NATS Connectivity
```bash
# From L4 instance
ssh -i fleet-telemetry-key.pem ubuntu@<L4-PRIVATE-IP>

# Check NATS JSZ endpoint
curl -s http://10.0.2.30:8222/jsz | jq '.config'
```
Expected: Returns NATS stream configuration

### 4. Test TimescaleDB Connection
```bash
# From L4 instance
docker exec timescaledb psql -U fleet -d fleet -c "SELECT version();"
```
Expected: PostgreSQL/TimescaleDB version output

### 5. Verify Network Segmentation
```bash
# From EMQX, try to reach TimescaleDB (should fail)
ssh -i fleet-telemetry-key.pem ubuntu@<EMQX-IP>
nc -zv 10.0.3.50 5432  # Should timeout (denied by SG)
```
Expected: Connection refused (security group rule working)

### 6. Check CloudWatch Alarms
```bash
aws cloudwatch describe-alarms --region me-south-1 \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue}'
```
Expected: All alarms in "OK" state

## Accessing Services

### EMQX Broker
- **MQTT TLS Endpoint** (for devices): `<EMQX-PUBLIC-IP>:8883`
- **Admin Dashboard** (internal only): `http://<EMQX-PRIVATE-IP>:18083`
- **Default Credentials**: admin/public

### NATS JetStream
- **Internal URL**: `nats://<NATS-PRIVATE-IP>:4222`
- **Monitoring Endpoint**: `http://<NATS-PRIVATE-IP>:8222`

### TimescaleDB
- **Connection String**: `postgresql://fleet:<PASSWORD>@<TIMESCALEDB-PRIVATE-IP>:5432/fleet`
- **Access**: From L4 instance only (internal subnet)

### Odoo Fleet Management
- **Dashboard URL**: `https://<ODOO-PUBLIC-IP>`
- **Port**: 443 (HTTPS)
- **Access**: From any internet connection (fleet managers)

### L4 Node.js Processing Service
- **REST API**: `http://<L4-PRIVATE-IP>:3000`
- **WebSocket**: `ws://<L4-PRIVATE-IP>:3001`

## Troubleshooting

### Instances won't start
```bash
# Check user_data errors
aws ec2 get-console-output --instance-id <INSTANCE-ID> --region me-south-1

# Or via SSH:
cat /var/log/cloud-init-output.log
```

### Containers not running
```bash
# SSH to instance and check logs
docker logs <container-name>
docker inspect <container-name>
df -h  # Check disk space
```

### Security group connectivity failing
```bash
# From EC2 instance, test with netcat
nc -zv <target-ip> <port>

# Review rules
aws ec2 describe-security-groups --group-ids <sg-id> --region me-south-1
```

### Terraform state issues
```bash
# Refresh state (don't modify, just read current state)
terraform refresh

# Show current state
terraform show

# Compare plan with actual
terraform plan -json | jq '.resource_changes[] | select(.change.actions != ["no-op"])'
```

## Rollback Procedure

If deployment fails or you need to roll back:

```bash
# View changes before destroying
terraform plan -destroy

# Destroy all infrastructure (keeps backups)
terraform destroy

# Confirm destruction
aws ec2 describe-instances --region eu-west-1 \
  --filters "Name=tag:Project,Values=fleet-telemetry"  # Should return empty
```

## Monitoring & Maintenance

### Daily Checks
```bash
# Instance health
aws ec2 describe-instance-status --region me-south-1 \
  --query 'InstanceStatuses[].{Instance:InstanceId,Status:InstanceStatus.Status}'

# CloudWatch alarms
aws cloudwatch describe-alarms --state-value ALARM --region me-south-1
```

### Weekly Tasks
- [ ] Review CloudWatch logs for errors
- [ ] Check backup bucket for new backups
- [ ] Verify device certificate issuance pipeline
- [ ] Test disaster recovery (restore from S3 backup)

### Monthly Tasks
- [ ] Review cost estimates
- [ ] Update security group rules if needed
- [ ] Refresh device certificates before expiration
- [ ] Performance tuning (adjust instance types if needed)

## Security Hardening (Optional)

1. **Enable VPC Flow Logs**:
```bash
aws ec2 create-flow-logs --resource-type VPC --resource-ids <VPC-ID> \
  --traffic-type ALL --log-destination-type cloud-watch-logs
```

2. **Enable CloudTrail**:
```bash
aws cloudtrail create-trail --name fleet-telemetry-trail \
  --s3-bucket-name fleet-telemetry-cloudtrail
```

3. **Set up SNS Alerts**:
```bash
aws sns create-topic --name fleet-telemetry-alerts
# Subscribe with email address
```

4. **Enable ALB** (if needing load balancing):
   - Place in front of EMQX for failover
   - Certificate from ACM

## AWS Billing

- Expected monthly cost: ~€290
- Cost breakdown: See README.md
- Set up billing alerts:
```bash
aws ce get-cost-and-usage --time-period Start=2026-03-01,End=2026-03-31 \
  --granularity DAILY --metrics BlendedCost
```

---

**Last Updated**: March 2026  
**Version**: 1.0  
**Status**: Production-Ready
