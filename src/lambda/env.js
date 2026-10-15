/*
 * Scheduled Driver Unassign - environment configuration
 * AdvantageOne
 *
 * Every deployment-specific value arrives as an environment variable set by
 * OpenTofu (infra/modules/unassign). Defaults exist so unit tests and local
 * runs work with no environment at all; production always sets the real value.
 */
"use strict";

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readEnv(env) {
  const source = env || process.env;
  return {
    region: source.AWS_REGION || "",
    configBucket: source.CONFIG_BUCKET || "",
    configKey: source.CONFIG_KEY || "config/customers.json",
    deploymentName: source.DEPLOYMENT_NAME || "local",
    allowedOrigins: String(source.ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    scheduleGroupPrefix: source.SCHEDULE_GROUP_PREFIX || "UnassignDriverSchedules",
    targetFunctionArn: source.TARGET_FUNCTION_ARN || "",
    schedulerRoleArn: source.SCHEDULER_ROLE_ARN || "",
    schedulerDlqArn: source.SCHEDULER_DLQ_ARN || "",
    schedulerRetryMaxAttempts: int(source.SCHEDULE_RETRY_MAX_ATTEMPTS, 2),
    schedulerRetryMaxAgeSeconds: int(source.SCHEDULE_RETRY_MAX_AGE_SECONDS, 3600),
    logLevel: source.LOG_LEVEL || "info",
    configCacheMs: int(source.CONFIG_CACHE_MS, 60000),
    secretCacheMs: int(source.SECRET_CACHE_MS, 300000),
    version: source.SERVICE_VERSION || "2.0.0"
  };
}

module.exports = { readEnv };
