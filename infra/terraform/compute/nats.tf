# EC2 instance for NATS JetStream message queue
# Instance: t3.medium (2vCPU, 4GB RAM)
# Subnet: ingestion-subnet
# Ingress: Port 4222 (from Traccar, L4), 8222 (monitoring from processing)
# Egress: Port 3000 to L4

# EC2 instance for NATS JetStream
resource "aws_instance" "nats" {
  # t3.medium: 2 vCPU, 4 GB RAM
  instance_type           = "t3.medium"
  ami                     = data.aws_ami.ubuntu.id
  key_name                = var.key_pair_name
  subnet_id               = var.ingestion_subnet_id
  vpc_security_group_ids  = [var.sg_nats_id]
  private_ip              = "10.0.2.30"
  monitoring              = var.enable_detailed_monitoring
  disable_api_termination = var.termination_protection

  # Root volume
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 100
    delete_on_termination = true
    encrypted             = true

    tags = {
      Name = "${var.instance_name_prefix}-nats-root"
    }
  }

  # User data to install and start NATS JetStream
  user_data = base64encode(<<-EOF
              #!/bin/bash
              set -e
              
              # Update system packages
              apt-get update -y
              apt-get upgrade -y
              
              # Install Docker
              apt-get install -y docker.io
              
              # Enable and start Docker daemon
              systemctl enable docker
              systemctl start docker
              
              # Create data directory for NATS persistence
              mkdir -p /data/nats
              chmod 755 /data/nats
              
              # Start NATS with JetStream enabled and persistent storage
              docker run -d \
                --name nats \
                --restart=always \
                -p 4222:4222 \
                -p 8222:8222 \
                -v /data/nats:/data \
                ${var.nats_image} \
                -js -sd /data
              
              # Log startup
              echo "NATS JetStream container started at $(date)" >> /var/log/user-data.log
              EOF
  )

  tags = merge(
    var.common_tags,
    {
      Name                = "${var.instance_name_prefix}-nats"
      Service             = "nats"
      InstanceType        = "t3.medium"
      vCPU                = "2"
      RAM                 = "4GB"
    }
  )

  lifecycle {
    ignore_changes = [ami]
  }
}

# CloudWatch alarm for instance status
resource "aws_cloudwatch_metric_alarm" "nats_status_check" {
  alarm_name          = "${var.instance_name_prefix}-nats-status"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = "2"
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = "60"
  statistic           = "Average"
  threshold           = "1"
  alarm_description   = "Alert when NATS instance fails status checks"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.nats.id
  }

  tags = var.common_tags
}
