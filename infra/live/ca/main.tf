terraform {
  required_version = ">= 1.10"

  # Partial backend configuration: filled in by scripts/deploy.sh with
  # -backend-config=infra/backend/ca.hcl.
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
  region          = "ca-central-1"
  deployment_name = "advone-ca-central"
  config_bucket   = "advone-ca-central-config"
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