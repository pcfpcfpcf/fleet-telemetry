# EC2 instance for Odoo fleet management ERP
# Instance: t3.xlarge (4vCPU, 16GB RAM)
# Subnet: presentation-subnet
# Ingress: Port 443 (from internet - fleet managers), 3000/3001 (from L4)
# Egress: Port 3000/3001 to L4, HTTPS to internet

# Elastic IP for Odoo (public access)
resource "aws_eip" "odoo" {
  domain   = "vpc"
  instance = aws_instance.odoo.id

  tags = merge(
    var.common_tags,
    {
      Name = "${var.instance_name_prefix}-odoo-eip"
    }
  )

  depends_on = [aws_instance.odoo]
}

# EC2 instance for Odoo
resource "aws_instance" "odoo" {
  # t3.xlarge: 4 vCPU, 16 GB RAM
  instance_type           = "t3.xlarge"
  ami                     = data.aws_ami.ubuntu.id
  key_name                = var.key_pair_name
  subnet_id               = var.presentation_subnet_id
  vpc_security_group_ids  = [var.sg_odoo_id]
  private_ip              = "10.0.4.60"
  monitoring              = var.enable_detailed_monitoring
  disable_api_termination = var.termination_protection

  # Root volume
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 100
    delete_on_termination = true
    encrypted             = true

    tags = {
      Name = "${var.instance_name_prefix}-odoo-root"
    }
  }

  # User data to install and start Odoo
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
              mkdir -p /data/odoo
              
              # Start Odoo container
              # Port 8069 is mapped to 443 for fleet manager access
              docker run -d \
                --name odoo \
                --restart=always \
                -p 443:8069 \
                -p 8069:8069 \
                -v /data/odoo:/var/lib/odoo \
                -e PGHOST=10.0.3.50 \
                -e PGPORT=5432 \
                -e PGUSER=fleet \
                -e PGPASSWORD=<password> \
                -e PGDATABASE=fleet \
                ${var.odoo_image}
              
              # Log startup
              echo "Odoo container started at $(date)" >> /var/log/user-data.log
              EOF
  )

  tags = merge(
    var.common_tags,
    {
      Name                = "${var.instance_name_prefix}-odoo"
      Service             = "odoo"
      InstanceType        = "t3.xlarge"
      vCPU                = "4"
      RAM                 = "16GB"
      Role                = "presentation"
      PublicFacing        = "true"
    }
  )

  lifecycle {
    ignore_changes = [ami]
  }
}

# CloudWatch alarm for instance status
resource "aws_cloudwatch_metric_alarm" "odoo_status_check" {
  alarm_name          = "${var.instance_name_prefix}-odoo-status"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = "2"
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = "60"
  statistic           = "Average"
  threshold           = "1"
  alarm_description   = "Alert when Odoo instance fails status checks"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.odoo.id
  }

  tags = var.common_tags
}
