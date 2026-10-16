terraform {
  required_version = ">= 1.10"

  # Partial backend configuration: filled in by scripts/deploy.sh with
  # -backend-config=infra/backend/us.hcl.
  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
  }
}

provider "aws" {
  region = local.region
}

locals {
  region          = "us-east-2"
  deployment_name = "advone-east-2"
  config_bucket   = "advone-east-2-config"
}

module "unassign" {
  source = "../../modules/unassign"

  region             = local.region
  deployment_name    = local.deployment_name
  config_bucket_name = local.config_bucket

  allowed_origins    = var.allowed_origins
  alarm_email        = var.alarm_email
  log_retention_days = var.log_retention_days
  lambda_zip_path    = var.lambda_zip_path
  lambda_s3_bucket   = local.config_bucket
  lambda_s3_key      = var.lambda_s3_key
  lambda_handler     = var.lambda_handler
  addin_security_id  = var.addin_security_id
}