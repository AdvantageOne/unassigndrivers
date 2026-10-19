output "function_url" {
  description = "HTTPS endpoint the MyGeotab add-in posts to."
  value       = module.unassign.function_url
}

output "function_name" {
  value = module.unassign.function_name
}

output "config_bucket" {
  value = module.unassign.config_bucket
}

output "config_key" {
  value = module.unassign.config_key
}

output "deployment_name" {
  value = module.unassign.deployment_name
}

output "region" {
  value = module.unassign.region
}

output "schedule_group_prefix" {
  value = module.unassign.schedule_group_prefix
}

output "alarm_topic_arn" {
  value = module.unassign.alarm_topic_arn
}

output "scheduler_role_arn" {
  value = module.unassign.scheduler_role_arn
}

output "dlq_url" {
  value = module.unassign.dlq_url
}