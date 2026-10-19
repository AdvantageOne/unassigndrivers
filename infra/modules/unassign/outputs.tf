output "function_url" {
  description = "HTTPS endpoint the MyGeotab add-in posts to."
  value       = aws_lambda_function_url.api.function_url
}

output "function_name" {
  description = "Name of the unassign Lambda function."
  value       = aws_lambda_function.api.function_name
}

output "config_bucket" {
  description = "Config bucket holding the customer registry."
  value       = aws_s3_bucket.config.id
}

output "config_key" {
  description = "Object key of the customer registry inside the config bucket."
  value       = var.config_key
}

output "deployment_name" {
  description = "Frozen deployment name."
  value       = var.deployment_name
}

output "region" {
  description = "Region of this deployment."
  value       = var.region
}

output "schedule_group_prefix" {
  description = "Prefix of the per-tenant EventBridge Scheduler schedule groups (<prefix>-<dbPrefix>)."
  value       = var.schedule_group_prefix
}

output "alarm_topic_arn" {
  description = "SNS topic that receives every alarm."
  value       = aws_sns_topic.alarms.arn
}

output "scheduler_role_arn" {
  description = "Execution role EventBridge Scheduler assumes to invoke the function."
  value       = aws_iam_role.scheduler.arn
}

output "dlq_url" {
  description = "URL of the SQS dead-letter queue for failed scheduled invocations."
  value       = aws_sqs_queue.dlq.url
}