# EC2 instance for Traccar GPS decoder
# Instance: t3.medium (2vCPU, 4GB RAM)
# Subnet: ingestion-subnet
# Ingress: Port 5055 (from EMQX), 8082 (web UI from processing)
# Egress: Port 4222 to NATS

# EC2 instance for Traccar
resource "aws_instance" "traccar" {
  # t3.medium: 2 vCPU, 4 GB RAM
  instance_type           = "t3.medium"
  ami                     = data.aws_ami.ubuntu.id
  key_name                = var.key_pair_name
  subnet_id               = var.ingestion_subnet_id
  vpc_security_group_ids  = [var.sg_traccar_id]
  private_ip              = "10.0.2.20"
  monitoring              = var.enable_detailed_monitoring
  disable_api_termination = var.termination_protection

  # Root volume
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 50
    delete_on_termination = true
    encrypted             = true

    tags = {
      Name = "${var.instance_name_prefix}-traccar-root"
    }
  }

  # User data to install and start Traccar
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
              
              # Create data directories
              mkdir -p /data/traccar/logs
              mkdir -p /data/traccar/conf
              
              # Start Traccar container
              docker run -d \
                --name traccar \
                --restart=always \
                -p 5055:5055 \
                -p 8082:8082 \
                -v /data/traccar:/opt/traccar/data \
                ${var.traccar_image}
              
              # Log startup
              echo "Traccar container started at $(date)" >> /var/log/user-data.log
              EOF
  )

  tags = merge(
    var.common_tags,
    {
      Name                = "${var.instance_name_prefix}-traccar"
      Service             = "traccar"
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
resource "aws_cloudwatch_metric_alarm" "traccar_status_check" {
  alarm_name          = "${var.instance_name_prefix}-traccar-status"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = "2"
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = "60"
  statistic           = "Average"
  threshold           = "1"
  alarm_description   = "Alert when Traccar instance fails status checks"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.traccar.id
  }

  tags = var.common_tags
}
