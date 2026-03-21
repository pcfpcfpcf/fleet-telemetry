# EC2 instance for L4 Node.js Processing Service
# Instance: t3.large (2vCPU, 8GB RAM) - upgraded for processing workload
# Subnet: processing-subnet
# Ingress: Port 4222 (from NATS), 3000 (REST from Odoo), 3001 (WebSocket from Odoo)
# Egress: Port 5432 to TimescaleDB, 3000/3001 to Odoo

# EC2 instance for L4 Node.js
resource "aws_instance" "l4" {
  # t3.large: 2 vCPU, 8 GB RAM (upgraded from t3.medium for processing)
  instance_type           = "t3.large"
  ami                     = data.aws_ami.ubuntu.id
  key_name                = var.key_pair_name
  subnet_id               = var.processing_subnet_id
  vpc_security_group_ids  = [var.sg_l4_id]
  private_ip              = "10.0.3.40"
  monitoring              = var.enable_detailed_monitoring
  disable_api_termination = var.termination_protection

  # Root volume
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 100
    delete_on_termination = true
    encrypted             = true

    tags = {
      Name = "${var.instance_name_prefix}-l4-root"
    }
  }

  # User data to install Docker and prepare for L4 service
  user_data = base64encode(<<-EOF
              #!/bin/bash
              set -e
              
              # Update system packages
              apt-get update -y
              apt-get upgrade -y
              
              # Install Docker and Node.js build tools
              apt-get install -y docker.io curl
              
              # Enable and start Docker daemon
              systemctl enable docker
              systemctl start docker
              
              # Create app directory
              mkdir -p /app/l4
              cd /app/l4
              
              # L4 image will be pulled from ECR by Software Engineer
              # This is a placeholder; the actual deployment will use:
              # docker run -d \
              #   --name l4 \
              #   --restart=always \
              #   -p 3000:3000 \
              #   -p 3001:3001 \
              #   -e NATS_URL=nats://10.0.2.30:4222 \
              #   -e DB_HOST=10.0.3.50 \
              #   -e DB_USER=fleet \
              #   -e DB_PASSWORD=<password> \
              #   -e DB_NAME=fleet \
              #   <ecr-account>.dkr.ecr.eu-west-1.amazonaws.com/l4:latest
              
              # Log that instance is ready
              echo "L4 instance ready at $(date)" >> /var/log/user-data.log
              echo "Awaiting L4 Docker image from Software Engineer" >> /var/log/user-data.log
              EOF
  )

  tags = merge(
    var.common_tags,
    {
      Name                = "${var.instance_name_prefix}-l4"
      Service             = "l4"
      InstanceType        = "t3.large"
      vCPU                = "2"
      RAM                 = "8GB"
      Role                = "processing"
    }
  )

  lifecycle {
    ignore_changes = [ami]
  }
}

# CloudWatch alarm for instance status
resource "aws_cloudwatch_metric_alarm" "l4_status_check" {
  alarm_name          = "${var.instance_name_prefix}-l4-status"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = "2"
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = "60"
  statistic           = "Average"
  threshold           = "1"
  alarm_description   = "Alert when L4 instance fails status checks"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.l4.id
  }

  tags = var.common_tags
}
