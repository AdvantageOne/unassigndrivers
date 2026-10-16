variable "allowed_origins" {
  description = "Origins allowed to call the Lambda Function URL. Exact origins, or patterns where * stands for any label (https://*.geotab.com covers the MyGeotab hosts); a pattern makes the URL accept any origin and leaves enforcement to the function."
  type        = list(string)
  default     = ["https://*.geotab.com"]
}

variable "alarm_email" {
  description = "Email address subscribed to the United States alarm topic. Empty string creates no subscription."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the Lambda log group."
  type        = number
  default     = 30
}

variable "lambda_zip_path" {
  description = "Lambda deployment artifact, relative to this root (path.root)."
  type        = string
  default     = "../../../dist/lambda.zip"
}

variable "lambda_handler" {
  description = "Lambda handler entry point inside the deployment artifact."
  type        = string
  default     = "src/lambda/handler.handler"
}

variable "addin_security_id" {
  description = "This add-in's Geotab ViewSecurityId filter id, seeded into config/customers.json (Step 0 of the port brief)."
  type        = string
  default     = ""
}
variable "lambda_s3_key" {
  description = "Key of the Lambda artifact in the config bucket. scripts/deploy.sh passes a content-addressed key."
  type        = string
  default     = "artifacts/lambda.zip"
}
