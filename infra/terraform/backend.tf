# Terraform Backend Configuration (S3 + DynamoDB)
# Uncomment and update to enable remote state management

# terraform {
#   backend "s3" {
#     bucket         = "fleet-telemetry-terraform-state"
#     key            = "production/terraform.tfstate"
#     region         = "eu-west-1"
#     encrypt        = true
#     dynamodb_table = "terraform-locks"
#   }
# }
#
# SETUP INSTRUCTIONS:
#
# 1. Create S3 bucket for state:
#    aws s3api create-bucket \
#      --bucket fleet-telemetry-terraform-state \
#      --region eu-west-1 \
#      --create-bucket-configuration LocationConstraint=eu-west-1
#
# 2. Enable versioning:
#    aws s3api put-bucket-versioning \
#      --bucket fleet-telemetry-terraform-state \
#      --versioning-configuration Status=Enabled
#
# 3. Enable encryption:
#    aws s3api put-bucket-encryption \
#      --bucket fleet-telemetry-terraform-state \
#      --server-side-encryption-configuration '{
#        "Rules": [{
#          "ApplyServerSideEncryptionByDefault": {
#            "SSEAlgorithm": "AES256"
#          }
#        }]
#      }'
#
# 4. Block public access:
#    aws s3api put-public-access-block \
#      --bucket fleet-telemetry-terraform-state \
#      --public-access-block-configuration \
#        "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
#
# 5. Create DynamoDB table for locking:
#    aws dynamodb create-table \
#      --table-name terraform-locks \
#      --attribute-definitions AttributeName=LockID,AttributeType=S \
#      --key-schema AttributeName=LockID,KeyType=HASH \
#      --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 \
#      --region eu-west-1
#
# 6. Uncomment the backend block above
#
# 7. Reinitialize:
#    terraform init
