# EC2 instance for TimescaleDB time-series database
# Instance: r5.xlarge (4vCPU, 32GB RAM) - memory-optimized for database
# Subnet: processing-subnet
# Ingress: Port 5432 (from L4)
# Egress: None (database only receives)
# EBS: 500GB gp3 encrypted volume for data

# EC2 instance for TimescaleDB
resource "aws_instance" "timescaledb" {
  # r5.xlarge: 4 vCPU, 32 GB RAM (memory-optimized for database workload)
  instance_type           = "r5.xlarge"
  ami                     = data.aws_ami.ubuntu.id
  key_name                = var.key_pair_name
  subnet_id               = var.processing_subnet_id
  vpc_security_group_ids  = [var.sg_timescaledb_id]
  private_ip              = "10.0.3.50"
  monitoring              = var.enable_detailed_monitoring
  disable_api_termination = var.termination_protection

  # Root volume (OS only, smaller)
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 50
    delete_on_termination = true
    encrypted             = true

    tags = {
      Name = "${var.instance_name_prefix}-timescaledb-root"
    }
  }

  # User data to configure EBS volume and start TimescaleDB
  user_data = base64encode(<<-EOF
              #!/bin/bash
              set -e
              
              # Update system packages
              apt-get update -y
              apt-get upgrade -y
              
              # Install Docker and filesystem tools
              apt-get install -y docker.io e2fsprogs
              
              # Enable and start Docker daemon
              systemctl enable docker
              systemctl start docker
              
              # Wait for EBS volume to be attached
              sleep 5
              
              # Format and mount EBS volume if not already formatted
              if ! sudo blkid /dev/sdf; then
                sudo mkfs.ext4 /dev/sdf
              fi
              
              # Create mount point
              mkdir -p /data/timescaledb
              
              # Mount the volume
              mount /dev/sdf /data/timescaledb || true
              
              # Add to fstab for persistence on reboot
              grep -q '/dev/sdf' /etc/fstab || echo '/dev/sdf /data/timescaledb ext4 defaults,nofail 0 2' >> /etc/fstab
              
              # Set permissions
              chown -R 999:999 /data/timescaledb
              chmod 700 /data/timescaledb
              
              # Start TimescaleDB container with persistent data volume
              docker run -d \
                --name timescaledb \
                --restart=always \
                -p 5432:5432 \
                -v /data/timescaledb:/var/lib/postgresql/data \
                -e POSTGRES_DB=fleet \
                -e POSTGRES_USER=fleet \
                -e POSTGRES_PASSWORD=${var.db_password} \
                ${var.timescaledb_image}
              
              # Log startup
              echo "TimescaleDB container started at $(date)" >> /var/log/user-data.log
              EOF
  )

  tags = merge(
    var.common_tags,
    {
      Name                = "${var.instance_name_prefix}-timescaledb"
      Service             = "timescaledb"
      InstanceType        = "r5.xlarge"
      vCPU                = "4"
      RAM                 = "32GB"
      Role                = "database"
    }
  )

  lifecycle {
    ignore_changes = [ami]
  }
}

# Attach the data volume to the TimescaleDB instance
resource "aws_volume_attachment" "timescaledb_data" {
  device_name             = "/dev/sdf"
  volume_id              = var.timescaledb_volume_id
  instance_id            = aws_instance.timescaledb.id
  stop_instance_before_detaching = true
}

# CloudWatch alarm for instance status
resource "aws_cloudwatch_metric_alarm" "timescaledb_status_check" {
  alarm_name          = "${var.instance_name_prefix}-timescaledb-status"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = "2"
  metric_name         = "StatusCheckFailed"
  namespace           = "AWS/EC2"
  period              = "60"
  statistic           = "Average"
  threshold           = "1"
  alarm_description   = "Alert when TimescaleDB instance fails status checks"
  treat_missing_data  = "notBreaching"

  dimensions = {
    InstanceId = aws_instance.timescaledb.id
  }

  tags = var.common_tags
}
