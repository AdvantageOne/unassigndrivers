variable "region" {
  description = "AWS region of this deployment. Used to build every resource ARN; never hardcoded in the module."
  type        = string
}

variable "deployment_name" {
  description = "Frozen deployment name, e.g. advone-ca-central. Keeps account-global names (IAM roles) unique per deployment."
  type        = string
}

variable "config_bucket_name" {
  description = "Name of the Terraform-managed config bucket, e.g. advone-ca-central-config."
  type        = string
}

variable "config_key" {
  description = "Object key of the customer registry inside the config bucket."
  type        = string
  default     = "config/customers.json"
}

variable "allowed_origins" {
  description = "Origins allowed to call the Lambda Function URL (the MyGeotab add-in frame origins). Empty list removes CORS access."
  type        = list(string)
}

variable "lambda_zip_path" {
  description = "Path to the Lambda deployment artifact, relative to the root module (path.root)."
  type        = string
  default     = "../../../dist/lambda.zip"
}

variable "lambda_handler" {
  description = "Lambda handler entry point inside the deployment artifact (the archive keeps the src/ prefix)."
  type        = string
  default     = "src/lambda/handler.handler"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the Lambda log group."
  type        = number
  default     = 30
}

variable "alarm_email" {
  description = "Email address subscribed to the alarm topic. Empty string creates no subscription."
  type        = string
  default     = ""
}

variable "metric_namespace" {
  description = "CloudWatch namespace for the custom outcome metrics."
  type        = string
  default     = "AdvoneUnassign"
}

variable "schedule_group_prefix" {
  description = "Prefix of the per-tenant EventBridge Scheduler schedule groups (<prefix>-<dbPrefix>)."
  type        = string
  default     = "UnassignDriverSchedules"
}

variable "schedule_retry_max_attempts" {
  description = "Maximum retry attempts for a scheduled invocation."
  type        = number
  default     = 2
}

variable "schedule_retry_max_age_seconds" {
  description = "Maximum age in seconds of a scheduled event before it is discarded and sent to the DLQ."
  type        = number
  default     = 3600
}

variable "log_level" {
  description = "Structured logger level for the Lambda."
  type        = string
  default     = "info"
}

variable "config_cache_ms" {
  description = "How long the runtime may cache the S3 customer registry, in milliseconds."
  type        = number
  default     = 60000
}

variable "secret_cache_ms" {
  description = "How long a warm container may cache a customer secret, in milliseconds."
  type        = number
  default     = 300000
}

variable "service_version" {
  description = "Version string reported by the Lambda health action."
  type        = string
  default     = "2.0.0"
}

variable "seed_config_object" {
  description = "Write the initial config/customers.json skeleton into the config bucket. Operators onboard customers into it; Terraform never overwrites their writes afterwards."
  type        = bool
  default     = true
}

variable "addin_security_id" {
  description = "This add-in's Geotab ViewSecurityId filter id, used only in the seeded config skeleton (Step 0 of the port brief). Empty means fail-closed until onboarding fills it."
  type        = string
  default     = ""
}