data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  name_prefix       = "advone-unassign"
  function_name     = "${local.name_prefix}-api"
  deployment_prefix = "${local.name_prefix}-${var.deployment_name}"

  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  # Where each database's run log lives, in the config bucket: the Lambda writes
  # it (lib/run-log.js) and the add-in reads it back through the listRuns action
  # to confirm a scheduled run happened. One constant, so the IAM grant and the
  # environment the code reads cannot drift apart.
  run_log_prefix = "runs/"

  # Built from the name instead of the resource attribute so the environment
  # block does not depend on aws_lambda_function.api (that would be a cycle).
  function_arn = "arn:${local.partition}:lambda:${var.region}:${local.account_id}:function:${local.function_name}"

  # The Lambda Function URL CORS list accepts exact origins or a bare "*"; it has
  # no pattern syntax. When one of the configured origins is a pattern (the
  # add-in's frame is a *.geotab.com host, say) the URL list widens to "*" and the
  # function enforces the real policy — see isOriginAllowed in src/lambda/http.js.
  function_url_origins = length([for origin in var.allowed_origins : origin if strcontains(origin, "*")]) > 0 ? ["*"] : var.allowed_origins

  scheduler_arn_prefix = "arn:${local.partition}:scheduler:${var.region}:${local.account_id}"
  schedules_arn        = "${local.scheduler_arn_prefix}:schedule/${var.schedule_group_prefix}-*/*"
  schedule_groups_arn  = "${local.scheduler_arn_prefix}:schedule-group/${var.schedule_group_prefix}-*"

  seed_config = {
    schemaVersion = 1
    deployment = {
      name         = var.deployment_name
      region       = var.region
      deploymentId = uuidv5("dns", "advone-unassign:${var.deployment_name}:${var.region}")
    }
    addIn = {
      name     = "Scheduled Driver Unassign by Advantage One"
      pageName = "Scheduled Driver Unassign"
      securityId = {
        id   = var.addin_security_id
        name = "ViewSecurityId"
      }
      clearance = {
        requireIsAdd         = true
        allowEverythingGroup = true
        ignoreCatalogGroup   = true
      }
    }
    defaults = { skipDriving = true, graceMinutes = 60 }
    # Staff domains may set a database up from the add-in and are never blocked by
    # licensing; `enforce = false` keeps the license visible to the add-in but
    # stops the service refusing unlicensed callers. Both are data: edit them in
    # config/customers.json, no deploy needed. The Lambda falls back to these same
    # values when the block is absent.
    licensing = {
      staffDomains = ["advtracking.net", "advantageone.tech"]
      enforce      = true
    }
    customers = {}
  }
}

# ---------------------------------------------------------------------------
# Config bucket (the runtime configuration store; the customer registry lives
# at config/customers.json and is written by the onboarding script).
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "config" {
  bucket        = var.config_bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_versioning" "config" {
  bucket = aws_s3_bucket.config.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "config" {
  bucket = aws_s3_bucket.config.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "config" {
  bucket = aws_s3_bucket.config.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "config" {
  bucket = aws_s3_bucket.config.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Seeds the registry so the onboarding script has an ETag to read-modify-write
# against. ignore_changes keeps Terraform out of the operator-written content.
resource "aws_s3_object" "config" {
  count = var.seed_config_object ? 1 : 0

  bucket       = aws_s3_bucket.config.id
  key          = var.config_key
  content      = jsonencode(local.seed_config)
  content_type = "application/json"

  lifecycle {
    ignore_changes = [content, etag]
  }

  depends_on = [aws_s3_bucket_versioning.config]
}

# ---------------------------------------------------------------------------
# CloudWatch log group (created before the function so Lambda does not create
# an unmanaged/unretained group first).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
}

# ---------------------------------------------------------------------------
# IAM: Lambda execution role
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    sid     = "LambdaAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.deployment_prefix}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "lambda" {
  statement {
    sid       = "ReadDeploymentConfig"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.config.arn}/${var.config_key}"]
  }

  # The staff-only setup action registers a database, which means writing this
  # one object. It is guarded by an ETag (If-Match), so a concurrent write is
  # detected rather than overwritten.
  statement {
    sid       = "WriteDeploymentConfig"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.config.arn}/${var.config_key}"]
  }

  # The run log: one small object per database recording every run attempt, so a
  # scheduled run can be confirmed after the fact and an attempt that never
  # reached Geotab is still visible. Scoped to that prefix only — the tenant
  # registry above is a separate, narrower grant.
  statement {
    sid       = "ReadWriteRunLog"
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.config.arn}/${local.run_log_prefix}*"]
  }

  statement {
    sid       = "ReadCustomerSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:${local.partition}:secretsmanager:${var.region}:${local.account_id}:secret:unassign/*"]
  }

  # Same action, same staff-only path: a caller with a proven session whose email
  # domain is an Advantage One one can seed or rotate a tenant's service account.
  # GetSecretValue above is what every scheduled run uses.
  statement {
    sid    = "ManageCustomerSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
    ]
    resources = ["arn:${local.partition}:secretsmanager:${var.region}:${local.account_id}:secret:unassign/*"]
  }

  statement {
    sid    = "ManageTenantSchedules"
    effect = "Allow"
    actions = [
      "scheduler:CreateSchedule",
      "scheduler:UpdateSchedule",
      "scheduler:DeleteSchedule",
      "scheduler:GetSchedule",
      "scheduler:ListSchedules",
    ]
    resources = [local.schedules_arn]
  }

  statement {
    sid    = "ManageTenantScheduleGroups"
    effect = "Allow"
    actions = [
      "scheduler:CreateScheduleGroup",
      "scheduler:GetScheduleGroup",
      "scheduler:ListScheduleGroups",
    ]
    resources = [local.schedule_groups_arn]
  }

  statement {
    sid       = "PassSchedulerRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.scheduler.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["scheduler.amazonaws.com"]
    }
  }

  statement {
    sid       = "EnqueueSchedulerFailures"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }

  statement {
    sid    = "WriteLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      aws_cloudwatch_log_group.lambda.arn,
      "${aws_cloudwatch_log_group.lambda.arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${local.deployment_prefix}-lambda"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

# ---------------------------------------------------------------------------
# SQS dead-letter queue for failed scheduled invocations
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "dlq" {
  name                       = "${local.deployment_prefix}-dlq"
  message_retention_seconds  = 1209600 # 14 days
  visibility_timeout_seconds = 300
}

data "aws_iam_policy_document" "dlq" {
  statement {
    sid       = "AllowSchedulerToEnqueue"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.schedules_arn]
    }
  }
}

resource "aws_sqs_queue_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id
  policy    = data.aws_iam_policy_document.dlq.json
}

# ---------------------------------------------------------------------------
# IAM: EventBridge Scheduler execution role
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "scheduler_assume_role" {
  statement {
    sid     = "SchedulerAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.deployment_prefix}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume_role.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    sid       = "InvokeUnassignFunction"
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.function_arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "${local.deployment_prefix}-scheduler"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

# ---------------------------------------------------------------------------
# Lambda function + Function URL
# ---------------------------------------------------------------------------

resource "aws_lambda_function" "api" {
  function_name = local.function_name
  role          = aws_iam_role.lambda.arn
  runtime       = "nodejs22.x"
  handler       = var.lambda_handler
  architectures = ["arm64"]
  # Deployed from S3, not from `filename`: the provider inlines a local archive
  # as a base64 ZipFile, and the SDK refuses a request whose single line exceeds
  # 64 KiB — which is a 48 KiB archive, and this service is past it. Uploading
  # first (scripts/deploy.sh) removes the ceiling entirely. `source_code_hash`
  # still comes from the local file, so a changed artifact is still planned.
  s3_bucket        = var.lambda_s3_bucket
  s3_key           = var.lambda_s3_key
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  memory_size      = 256
  timeout          = 300

  environment {
    variables = {
      CONFIG_BUCKET                  = var.config_bucket_name
      CONFIG_KEY                     = var.config_key
      RUN_LOG_PREFIX                 = local.run_log_prefix
      DEPLOYMENT_NAME                = var.deployment_name
      ALLOWED_ORIGINS                = join(",", var.allowed_origins)
      SCHEDULE_GROUP_PREFIX          = var.schedule_group_prefix
      TARGET_FUNCTION_ARN            = local.function_arn
      SCHEDULER_ROLE_ARN             = aws_iam_role.scheduler.arn
      SCHEDULER_DLQ_ARN              = aws_sqs_queue.dlq.arn
      SCHEDULE_RETRY_MAX_ATTEMPTS    = tostring(var.schedule_retry_max_attempts)
      SCHEDULE_RETRY_MAX_AGE_SECONDS = tostring(var.schedule_retry_max_age_seconds)
      LOG_LEVEL                      = var.log_level
      CONFIG_CACHE_MS                = tostring(var.config_cache_ms)
      SECRET_CACHE_MS                = tostring(var.secret_cache_ms)
      SERVICE_VERSION                = var.service_version
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda,
  ]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"

  cors {
    allow_credentials = false
    allow_headers     = ["content-type"]
    # "OPTIONS" is rejected here: AllowMethods members are capped at six
    # characters by the Lambda API, and Lambda answers the preflight itself when
    # CORS is configured on the function URL. Only the real request method goes
    # in this list.
    allow_methods = ["POST"]
    allow_origins = local.function_url_origins
    max_age       = 600
  }
}

# ---------------------------------------------------------------------------
# Alarms: SNS topic, log metric filters, alarms
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alarms" {
  name = "${local.deployment_prefix}-alarms"
}

resource "aws_sns_topic_subscription" "alarms_email" {
  for_each = toset(var.alarm_email == "" ? [] : [var.alarm_email])

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_cloudwatch_log_metric_filter" "outcome_failed" {
  name           = "${local.function_name}-outcome-failed"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "{ $.outcome = \"failed\" }"

  metric_transformation {
    name          = "UnassignFailed"
    namespace     = var.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "outcome_denied" {
  name           = "${local.function_name}-outcome-denied"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "{ $.outcome = \"denied\" }"

  metric_transformation {
    name          = "UnassignDenied"
    namespace     = var.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "still_assigned" {
  name           = "${local.function_name}-still-assigned"
  log_group_name = aws_cloudwatch_log_group.lambda.name
  pattern        = "{ $.stillAssigned > 0 }"

  metric_transformation {
    name          = "UnassignStillAssigned"
    namespace     = var.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${local.deployment_prefix}-lambda-errors"
  alarm_description   = "The unassign Lambda returned an error."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = local.function_name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  alarm_name          = "${local.deployment_prefix}-lambda-throttles"
  alarm_description   = "The unassign Lambda was throttled."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = local.function_name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name          = "${local.deployment_prefix}-dlq-depth"
  alarm_description   = "A scheduled invocation was dropped into the dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "outcome_failed" {
  alarm_name          = "${local.deployment_prefix}-outcome-failed"
  alarm_description   = "An unassign run failed (outcome=failed)."
  namespace           = var.metric_namespace
  metric_name         = "UnassignFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "outcome_denied" {
  alarm_name          = "${local.deployment_prefix}-outcome-denied"
  alarm_description   = "Requests were denied by the authorization check (outcome=denied)."
  namespace           = var.metric_namespace
  metric_name         = "UnassignDenied"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "outcome_still_assigned" {
  alarm_name          = "${local.deployment_prefix}-outcome-still-assigned"
  alarm_description   = "Assets were still assigned after an unassign run (stillAssigned > 0)."
  namespace           = var.metric_namespace
  metric_name         = "UnassignStillAssigned"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}