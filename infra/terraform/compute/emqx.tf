# EC2 instance for EMQX MQTT broker
# Instance: t3.medium (2vCPU, 4GB RAM)
# Subnet: ingestion-subnet
# Ingress: Port 8883 (TLS) from internet, 1883 (internal) from Traccar, 18083 (dashboard) from processing
# Egress: Port 5055 to Traccar

# Elastic IP for EMQX (so devices can reach on port 8883)
resource "aws_eip" "emqx" {
  domain   = "vpc"
  instance = aws_instance.emqx.id

  tags = merge(
    var.common_tags,
    {
      Name = "${var.instance_name_prefix}-emqx-eip"
    }
  )

  depends_on = [aws_instance.emqx]
}

# EC2 instance for EMQX
resource "aws_instance" "emqx" {
  # t3.medium: 2 vCPU, 4 GB RAM
  instance_type           = "t3.medium"
  ami                     = data.aws_ami.ubuntu.id
  key_name                = var.key_pair_name
  subnet_id               = var.ingestion_subnet_id
  vpc_security_group_ids  = [var.sg_emqx_id]
  private_ip              = "10.0.2.10"
  monitoring              = var.enable_detailed_monitoring
  disable_api_termination = var.termination_protection

  # Root volume
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 50
    delete_on_termination = true
    encrypted             = true

    tags = {
      Name = "${var.instance_name_prefix}-emqx-root"
    }
  }

  # User data to install and start EMQX
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
              
              # Create data directory
              mkdir -p /data/emqx
              
              # Start EMQX container with persistent volume
              docker run -d \
                --name emqx \
                --restart=always \
                -p 1883:1883 \
                -p 8883:8883 \
                -p 18083:18083 \
                -v /data/emqx:/opt/emqx/data \
                ${var.emqx_image}
              
              # Log startup
              echo "EMQX container started at $(date)" >> /var/log/user-data.log
              EOF
  )

  tags = merge(
    var.common_tags,
    {
      Name                = "${var.instance_name_prefix}-emqx"
      Service             = "emqx"
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
resource "aws_cloudwatch_metric_alarm" "emqx_status_check" {
  alarm_name          = "${var.instance_name_prefix}-emqx-status"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = "2"
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = "60"
  statistic           = "Average"
  threshold           = "1"
  alarm_description   = "Alert when EMQX instance fails status checks"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.emqx.id
  }

  tags = var.common_tags
}
