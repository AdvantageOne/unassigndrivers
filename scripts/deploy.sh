#!/usr/bin/env bash
#
# scripts/deploy.sh — deploy (or destroy) one regional instance of the unassign
# service: Canada (ca-central-1) or the United States (us-east-2).
#
# Brief §7 Step 8 / R10: preflight, bootstrap the state bucket, build the Lambda
# artifact, plan, summarise the plan, ask, apply, verify. Re-running with nothing
# to do prints "No changes" and exits 0. There is no path to `tofu destroy`
# without --destroy plus typing the deployment name.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="scripts/deploy.sh"
# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

REGION_RAW=""
ASSUME_YES=0
PLAN_ONLY=0
FORCE=0
DESTROY=0
SELFTEST=0

PLAN_DIR=""
PLAN_PATH=""
PLAN_NAME="deploy.tfplan"

usage() {
  cat <<'USAGE'
scripts/deploy.sh — deploy one regional instance of the Scheduled Driver Unassign
service (Lambda + EventBridge Scheduler + S3 config + alarms).

Usage:
  scripts/deploy.sh [--region ca|us] [options]

Options:
  --region ca|us   Canada (ca-central-1) or United States (us-east-2).
                   Asked interactively when omitted.
  --yes, -y        Skip the "apply this plan?" confirmation.
  --plan-only      Plan and print the summary, then stop (no prompt, no apply).
  --force          Adopt an existing state bucket / state key whose deployment
                   marker does not match the current account and region.
  --destroy        Plan and apply a destroy of this deployment's resources.
                   Always requires typing the deployment name to confirm;
                   --yes does NOT skip that.
  --selftest       Run the offline self-tests for the script's pure helpers.
  --help, -h       Show this text.

What it does, in order:
  1. checks aws, tofu (>= 1.10), jq and zip are installed;
  2. checks the AWS credentials and that the environment region matches --region;
  3. creates the state bucket advone-<region>-deploy if missing (versioning,
     SSE, public access blocked, bucket-owner-enforced) and writes or verifies
     this service's ownership marker inside it; every object it owns lives under
     the $SERVICE_SLUG/ prefix, because other services share that bucket;
  4. builds dist/lambda.zip from src/ (zero runtime dependencies);
  5. tofu init -reconfigure against infra/backend/<ca|us>.hcl, then plan;
  6. prints a summary of what will be added, changed and destroyed;
  7. applies, prints the outputs and smoke-tests the health action.

Examples:
  scripts/deploy.sh --region ca
  scripts/deploy.sh --region us --plan-only
  scripts/deploy.sh --region ca --yes
  scripts/deploy.sh --region ca --destroy
USAGE
}

# ---------------------------------------------------------------------------
# Flags
# ---------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --region)
      [ "$#" -ge 2 ] || die_fix "--region needs a value" "pass --region ca (Canada) or --region us (United States)"
      REGION_RAW="$2"
      shift 2
      ;;
    --region=*)
      REGION_RAW="${1#--region=}"
      shift
      ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --plan-only) PLAN_ONLY=1; shift ;;
    --force)    FORCE=1; shift ;;
    --destroy)  DESTROY=1; shift ;;
    --selftest) SELFTEST=1; shift ;;
    --help|-h)  usage; exit 0 ;;
    *) die_fix "unknown argument '$1'" "run '$SCRIPT_NAME --help' to see the accepted flags" ;;
  esac
done

# ---------------------------------------------------------------------------
# Self-tests (pure helpers only: no AWS, no tofu)
# ---------------------------------------------------------------------------
deployment_marker_json() { # <deploymentName> <region> <accountId> <createdAt> <createdBy> <deploymentId>
  jq -n --arg deploymentName "$1" --arg region "$2" --arg accountId "$3" \
        --arg createdAt "$4" --arg createdBy "$5" --arg deploymentId "$6" \
    '{deploymentName: $deploymentName,
      region: $region,
      accountId: $accountId,
      createdAt: $createdAt,
      createdBy: $createdBy,
      deploymentId: $deploymentId}'
}

# plan_rows <plan-json-file> — one "action<TAB>address" line per changed resource
# plus "output<TAB>name" lines for changed outputs. Pure jq over a plan document.
plan_rows() {
  jq -r '
    def act:
      (.change.actions // []) as $a
      | if (($a | index("delete")) != null) and (($a | index("create")) != null) then "replace"
        elif ($a | index("create")) != null then "create"
        elif ($a | index("delete")) != null then "destroy"
        elif ($a | index("update")) != null then "update"
        else "no-op" end;
    ((.resource_changes // [])[] | select(act != "no-op") | "\(act)\t\(.address)"),
    ((.output_changes // {}) | to_entries[]
      | select(((.value.actions // []) | index("no-op")) == null)
      | "output\t\(.key)")
  ' "$1"
}

# render_plan_rows <plan_rows output> — human lines, destroys and replaces in red.
render_plan_rows() {
  printf '%s\n' "${1:-}" | while IFS=$'\t' read -r action address; do
    [ -n "$action" ] || continue
    case "$action" in
      create)  printf '%s\n' "  ${C_GREEN}+ create${C_RESET}   $address" ;;
      update)  printf '%s\n' "  ${C_YELLOW}~ change${C_RESET}   $address" ;;
      destroy) printf '%s\n' "  ${C_RED}- DESTROY${C_RESET}  $address" ;;
      replace) printf '%s\n' "  ${C_RED}-/+ REPLACE${C_RESET} $address" ;;
      output)  printf '%s\n' "  ${C_DIM}out      $address${C_RESET}" ;;
      *)       printf '%s\n' "  $action $address" ;;
    esac
  done
}

run_selftest() {
  local code marker rows counts rendered

  for code in ca us; do
    st_eq "region $code -> aws region" "$(case $code in ca) echo ca-central-1 ;; us) echo us-east-2 ;; esac)" "$(region_field "$code" region)"
    st_eq "region $code -> deployment name" "$(case $code in ca) echo advone-ca-central ;; us) echo advone-east-2 ;; esac)" "$(region_field "$code" deployment)"
    st_eq "region $code -> state bucket" "$(case $code in ca) echo advone-ca-central-deploy ;; us) echo advone-east-2-deploy ;; esac)" "$(region_field "$code" state)"
    st_eq "region $code -> config bucket" "$(case $code in ca) echo advone-ca-central-config ;; us) echo advone-east-2-config ;; esac)" "$(region_field "$code" config)"
  done
  st_eq "region arg 'ca' maps to code" "ca" "$(region_code_from_arg ca)"
  st_eq "region arg 'us' maps to code" "us" "$(region_code_from_arg us)"
  st_eq "region arg 'ca-central-1' maps to code" "ca" "$(region_code_from_arg ca-central-1)"
  st_false "region arg 'mars' is rejected" region_code_from_arg mars
  st_false "region arg '' is rejected" region_code_from_arg ""

  st_eq "backend hcl path" "$REPO_ROOT/infra/backend/ca.hcl" "$(backend_hcl_path ca)"
  st_true "OpenTofu 1.12.6 satisfies >= 1.10" version_ge "1.12.6" "1.10"
  st_true "OpenTofu 1.10.0 satisfies >= 1.10" version_ge "1.10.0" "1.10"
  st_false "OpenTofu 1.9.9 does not satisfy >= 1.10" version_ge "1.9.9" "1.10"

  st_eq "tenant schedule-group prefix is the contract default" "UnassignDriverSchedules" "$SCHEDULE_GROUP_PREFIX"

  st_eq "state key lives under the service prefix" "scheduled-driver-unassign/terraform.tfstate" "$STATE_KEY"
  st_eq "ownership marker lives under the same prefix" "scheduled-driver-unassign/deployment.json" "$DEPLOYMENT_MARKER_KEY"
  st_eq "the pre-prefix state key is still tracked for migration" "unassign/terraform.tfstate" "$LEGACY_STATE_KEY"
  st_eq "another service's state is not ours" "scheduled-driver-unassign/terraform.tfstate" \
        "$(printf '%s\n' "other-service/terraform.tfstate" "scheduled-driver-unassign/terraform.tfstate" | filter_our_state_keys)"
  st_eq "unprefixed state is not ours" "" \
        "$(printf '%s\n' "unassign/terraform.tfstate" "other-service/terraform.tfstate" | filter_our_state_keys)"
  st_eq "the state lock file is not counted as state" "scheduled-driver-unassign/terraform.tfstate" \
        "$(printf '%s\n' "scheduled-driver-unassign/terraform.tfstate.tflock" "scheduled-driver-unassign/terraform.tfstate" | filter_our_state_keys)"
  for code in ca us; do
    st_eq "infra/backend/$code.hcl declares the contract state key" "$STATE_KEY" \
          "$(backend_hcl_key "$(backend_hcl_path "$code")")"
  done
  local hcl_fixture="$PLAN_DIR/selftest-backend.hcl"
  printf '%s\n' 'bucket = "somewhere"' 'key    = "other-service/terraform.tfstate"' > "$hcl_fixture"
  st_eq "a backend config naming another service is read correctly" "other-service/terraform.tfstate" "$(backend_hcl_key "$hcl_fixture")"
  st_false "a backend config naming another service is refused" test \
           "$(backend_hcl_key "$hcl_fixture")" = "$STATE_KEY"

  marker="$(deployment_marker_json "advone-ca-central" "ca-central-1" "123456789012" "2026-10-15T00:00:00Z" "arn:aws:iam::123456789012:user/ops" "11111111-2222-3333-4444-555555555555")"
  st_eq "marker: deploymentName" "advone-ca-central" "$(printf '%s' "$marker" | jq -r .deploymentName)"
  st_eq "marker: region" "ca-central-1" "$(printf '%s' "$marker" | jq -r .region)"
  st_eq "marker: accountId" "123456789012" "$(printf '%s' "$marker" | jq -r .accountId)"
  st_true "marker: carries the 6 expected keys" test "$(printf '%s' "$marker" | jq -r 'keys | length')" = "6"
  st_true "marker: createdAt is ISO8601 Z" test "$(printf '%s' "$marker" | jq -r .createdAt)" = "2026-10-15T00:00:00Z"

  local fixture="$PLAN_DIR/selftest-plan.json"
  cat > "$fixture" <<'JSON'
{
  "resource_changes": [
    {"address": "module.lambda.aws_lambda_function.this", "change": {"actions": ["create"]}},
    {"address": "module.lambda.aws_iam_role.this", "change": {"actions": ["create"]}},
    {"address": "aws_s3_bucket.config", "change": {"actions": ["update"]}},
    {"address": "aws_sns_topic.alarms", "change": {"actions": ["delete"]}},
    {"address": "aws_cloudwatch_log_group.this", "change": {"actions": ["delete", "create"], "replace_paths": [["retention_in_days"]]}},
    {"address": "aws_scheduler_schedule.unrelated", "change": {"actions": ["no-op"]}}
  ],
  "output_changes": {
    "function_url": {"actions": ["create"]},
    "config_bucket": {"actions": ["no-op"]}
  }
}
JSON
  rows="$(plan_rows "$fixture")"
  counts="$(printf '%s\n' "$rows" | awk -F'\t' '$1=="create"{a++} $1=="update"{c++} $1=="destroy"{d++} $1=="replace"{r++} END{printf "%d %d %d %d", a+0, c+0, d+0, r+0}')"
  st_eq "plan rows: 2 add / 1 change / 1 destroy / 1 replace" "2 1 1 1" "$counts"
  st_true "plan rows: no-op resource omitted" test "$(printf '%s\n' "$rows" | grep -c 'unrelated' || true)" = "0"
  st_true "plan rows: replace detected from delete+create" test "$(printf '%s\n' "$rows" | grep -c 'replace.aws_cloudwatch_log_group.this')" = "1"
  st_true "plan rows: changed output listed" test "$(printf '%s\n' "$rows" | grep -c 'output.function_url')" = "1"

  rendered="$(render_plan_rows "$rows")"
  st_true "plan rendering marks a destroy" test "$(printf '%s\n' "$rendered" | grep -c 'DESTROY.*aws_sns_topic.alarms')" = "1"
  st_true "plan rendering marks a replace" test "$(printf '%s\n' "$rendered" | grep -c 'REPLACE.*aws_cloudwatch_log_group.this')" = "1"
  st_true "plan rendering marks an add" test "$(printf '%s\n' "$rendered" | grep -c 'create.*module.lambda.aws_lambda_function.this')" = "1"
  st_true "plan rendering marks a one-line output change" test "$(printf '%s\n' "$rendered" | grep -c 'function_url')" = "1"

  local empty="$PLAN_DIR/selftest-plan-empty.json"
  printf '%s\n' '{"resource_changes": [], "output_changes": {}}' > "$empty"
  st_eq "plan rows: empty plan has no rows" "" "$(plan_rows "$empty")"

  st_done "$SCRIPT_NAME"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
AWS_ACCOUNT_ID=""
AWS_CALLER_ARN=""
TOFU_VERSION=""
DEPLOYMENT_ID=""

preflight_commands() {
  require_command aws jq zip
  require_tofu_1_10
  info "OpenTofu $TOFU_VERSION, AWS CLI $(aws --version 2>&1 | awk '{print $1}')"
}

caller_identity() {
  local out
  if ! out="$(aws_try sts get-caller-identity --output json)"; then
    die_fix "$(aws_error_reason "$(aws_last_err)") while calling aws sts get-caller-identity" \
            "run \"aws configure\" (or \"aws sso login\") for the account that owns $DEPLOYMENT_NAME, then re-run $SCRIPT_NAME --region $REGION_CODE"
  fi
  AWS_ACCOUNT_ID="$(printf '%s' "$out" | jq -r '.Account')"
  AWS_CALLER_ARN="$(printf '%s' "$out" | jq -r '.Arn')"
  info "AWS account $AWS_ACCOUNT_ID as $AWS_CALLER_ARN"
}

check_environment_region() {
  local configured="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
  if [ -z "$configured" ]; then
    configured="$(aws configure get region 2>/dev/null || true)"
  fi
  if [ -n "$configured" ] && [ "$configured" != "$AWS_REGION" ]; then
    if [ "$FORCE" -eq 0 ]; then
      die_fix "your AWS environment is configured for region '$configured' but --region $REGION_CODE deploys to $AWS_REGION" \
              "unset AWS_REGION/AWS_DEFAULT_REGION (or run \"aws configure set region $AWS_REGION\"), or re-run with --force"
    fi
    warn "environment region '$configured' differs from $AWS_REGION — continuing because of --force"
  fi
}

check_scheduler_access() {
  if ! aws_try scheduler list-schedule-groups --max-results 1 >/dev/null; then
    die_fix "$(aws_error_reason "$(aws_last_err)") while listing EventBridge Scheduler groups in $AWS_REGION" \
            "grant scheduler:ListScheduleGroups to $AWS_CALLER_ARN, and confirm EventBridge Scheduler is available in $AWS_REGION"
  fi
}

# ---------------------------------------------------------------------------
# State bucket bootstrap
# ---------------------------------------------------------------------------
must_aws() { # <what> <fix> <aws args...>
  local what="$1" fix="$2"; shift 2
  if ! aws_try "$@" >/dev/null; then
    die_fix "$(aws_error_reason "$(aws_last_err)") while trying to $what" "$fix"
  fi
}

state_bucket_exists() { # 0 exists, 1 missing, dies on anything else
  if aws_try s3api head-bucket --bucket "$STATE_BUCKET" >/dev/null; then
    return 0
  fi
  case "$(aws_last_err)" in
    *404*|*NoSuchBucket*|*"Not Found"*) return 1 ;;
    *403*|*Forbidden*|*AccessDenied*)
      die_fix "the state bucket $STATE_BUCKET exists but is not readable by $AWS_CALLER_ARN" \
              "check the bucket owner (aws s3api get-bucket-location --bucket $STATE_BUCKET) — R1 allows exactly one owner per region"
      ;;
    *)
      die_fix "$(aws_error_reason "$(aws_last_err)") while checking the state bucket $STATE_BUCKET" \
              "verify with: aws s3api head-bucket --bucket $STATE_BUCKET --region $AWS_REGION"
      ;;
  esac
}

create_state_bucket() {
  info "creating state bucket s3://$STATE_BUCKET in $AWS_REGION"
  must_aws "create s3://$STATE_BUCKET" \
           "grant s3:CreateBucket (and check the bucket name is free) then re-run" \
           s3api create-bucket --bucket "$STATE_BUCKET" \
           --create-bucket-configuration "LocationConstraint=$AWS_REGION"
  local i=0
  while [ "$i" -lt 30 ]; do
    if aws_try s3api head-bucket --bucket "$STATE_BUCKET" >/dev/null; then return 0; fi
    i=$((i + 1))
    sleep 1
  done
  die_fix "s3://$STATE_BUCKET was created but is not yet visible" "wait a few seconds and re-run $SCRIPT_NAME --region $REGION_CODE"
}

configure_state_bucket() {
  local location
  location="$(aws_try s3api get-bucket-location --bucket "$STATE_BUCKET" --query 'LocationConstraint' --output text || true)"
  if [ -n "$location" ] && [ "$location" != "None" ] && [ "$location" != "$AWS_REGION" ]; then
    die_fix "the state bucket $STATE_BUCKET lives in '$location', not $AWS_REGION" \
            "a deployment is one bucket in one region (R1): use the deployment that owns that bucket, or pass --force only after moving the state by hand"
  fi

  must_aws "enable versioning on s3://$STATE_BUCKET" \
           "grant s3:PutBucketVersioning on arn:aws:s3:::$STATE_BUCKET" \
           s3api put-bucket-versioning --bucket "$STATE_BUCKET" --versioning-configuration Status=Enabled
  must_aws "encrypt s3://$STATE_BUCKET" \
           "grant s3:PutEncryptionConfiguration on arn:aws:s3:::$STATE_BUCKET" \
           s3api put-bucket-encryption --bucket "$STATE_BUCKET" \
           --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
  must_aws "block public access on s3://$STATE_BUCKET" \
           "grant s3:PutBucketPublicAccessBlock on arn:aws:s3:::$STATE_BUCKET" \
           s3api put-public-access-block --bucket "$STATE_BUCKET" \
           --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  must_aws "set bucket-owner-enforced ownership on s3://$STATE_BUCKET" \
           "grant s3:PutBucketOwnershipControls on arn:aws:s3:::$STATE_BUCKET" \
           s3api put-bucket-ownership-controls --bucket "$STATE_BUCKET" \
           --ownership-controls '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}'
}

# This service's tfstate object keys in the state bucket, one per line. The
# listing is prefixed, so another Advantage One service storing its state in the
# same bucket is neither counted nor touched.
state_keys() {
  aws_try s3api list-objects-v2 --bucket "$STATE_BUCKET" --prefix "$SERVICE_SLUG/" \
          --query 'Contents[].Key' --output json 2>/dev/null \
    | jq -r '.[]?' 2>/dev/null \
    | filter_our_state_keys || true
}

check_state_keys() {
  local keys extra
  keys="$(state_keys)"
  extra="$(printf '%s\n' "$keys" | grep -v -x "$STATE_KEY" | grep -v '^$' || true)"
  if [ -z "$extra" ]; then
    return 0
  fi
  if [ "$FORCE" -eq 0 ]; then
    die_fix "s3://$STATE_BUCKET already holds other state for this service: $(printf '%s' "$extra" | tr '\n' ' ')" \
            "this deployment owns exactly one state key ($STATE_KEY) under the $SERVICE_SLUG/ prefix; use the project that owns that state, or delete it deliberately and re-run with --force"
  fi
  warn "s3://$STATE_BUCKET holds other state keys for this service ($(printf '%s' "$extra" | tr '\n' ' ')) — continuing because of --force"
}

# The state key moved under the service prefix when the deploy buckets started
# hosting more than one service. Without this check an older deployment would
# look empty here and be created a second time.
check_legacy_state_key() {
  [ "$LEGACY_STATE_KEY" = "$STATE_KEY" ] && return 0
  s3_object_exists "$STATE_BUCKET" "$LEGACY_STATE_KEY" || return 0
  if s3_object_exists "$STATE_BUCKET" "$STATE_KEY"; then
    warn "s3://$STATE_BUCKET holds state at both $LEGACY_STATE_KEY and $STATE_KEY — using $STATE_KEY"
    return 0
  fi
  die_fix "s3://$STATE_BUCKET/$LEGACY_STATE_KEY holds this service's state from before the service prefix" \
          "move it under the prefix and re-run: aws s3 mv s3://$STATE_BUCKET/$LEGACY_STATE_KEY s3://$STATE_BUCKET/$STATE_KEY --region $AWS_REGION"
}

# The backend config decides where OpenTofu reads and writes state; the scripts
# decide where the ownership marker and the guards look. If they disagree, the
# deployment would plan against an empty state.
check_backend_key() {
  local declared
  declared="$(backend_hcl_key "$BACKEND_HCL")"
  if [ -z "$declared" ]; then
    die_fix "could not read the state key from $BACKEND_HCL" "it must contain: key = \"$STATE_KEY\""
  fi
  if [ "$declared" != "$STATE_KEY" ]; then
    die_fix "$BACKEND_HCL declares the state key \"$declared\" but the scripts use \"$STATE_KEY\"" \
            "point both at the same key (this service's prefix in the deploy bucket is $SERVICE_SLUG/)"
  fi
  info "state key: s3://$STATE_BUCKET/$STATE_KEY"
}

write_deployment_marker() {
  local file rc
  file="$(mktemp "${TMPDIR:-/tmp}/unassign-marker.XXXXXX")"
  deployment_marker_json "$DEPLOYMENT_NAME" "$AWS_REGION" "$AWS_ACCOUNT_ID" \
                         "$(now_iso8601)" "$AWS_CALLER_ARN" "$DEPLOYMENT_ID" > "$file"
  rc=0
  aws_try s3api put-object --bucket "$STATE_BUCKET" --key "$DEPLOYMENT_MARKER_KEY" \
          --body "$file" --content-type application/json >/dev/null || rc=$?
  rm -f "$file"
  if [ "$rc" -ne 0 ]; then
    die_fix "$(aws_error_reason "$(aws_last_err)") while writing s3://$STATE_BUCKET/$DEPLOYMENT_MARKER_KEY" \
            "grant s3:PutObject on arn:aws:s3:::$STATE_BUCKET/* to $AWS_CALLER_ARN"
  fi
  info "wrote s3://$STATE_BUCKET/$DEPLOYMENT_MARKER_KEY"
}

bootstrap_state_bucket() {
  local marker rc m_account m_region m_name m_id
  if state_bucket_exists; then
    info "state bucket s3://$STATE_BUCKET exists"
  else
    create_state_bucket
  fi
  configure_state_bucket
  check_legacy_state_key

  marker="$(mktemp "${TMPDIR:-/tmp}/unassign-marker.XXXXXX")"
  rc=0
  read_deploy_marker "$STATE_BUCKET" "$marker" || rc=$?

  case "$rc" in
    0)
      m_account="$(jq -r '.accountId // empty' "$marker")"
      m_region="$(jq -r '.region // empty' "$marker")"
      m_name="$(jq -r '.deploymentName // empty' "$marker")"
      m_id="$(jq -r '.deploymentId // empty' "$marker")"
      rm -f "$marker"
      if [ "$m_account" != "$AWS_ACCOUNT_ID" ] || [ "$m_region" != "$AWS_REGION" ] || [ "$m_name" != "$DEPLOYMENT_NAME" ]; then
        if [ "$FORCE" -eq 0 ]; then
          die_fix "s3://$STATE_BUCKET belongs to $m_name ($m_region, account $m_account), but you are deploying $DEPLOYMENT_NAME ($AWS_REGION, account $AWS_ACCOUNT_ID)" \
                  "deploy with the account/region that owns it, or re-run with --force to adopt the bucket"
        fi
        warn "adopting s3://$STATE_BUCKET from $m_name ($m_region, account $m_account) because of --force"
        DEPLOYMENT_ID="$m_id"
        write_deployment_marker
      else
        DEPLOYMENT_ID="$m_id"
        info "deployment marker verified ($DEPLOYMENT_NAME, $AWS_REGION, account $AWS_ACCOUNT_ID)"
      fi
      ;;
    1)
      rm -f "$marker"
      if [ -n "$(state_keys)" ] && [ "$FORCE" -eq 0 ]; then
        die_fix "s3://$STATE_BUCKET already holds OpenTofu state for this service but no $DEPLOYMENT_MARKER_KEY ownership marker" \
                "inspect it with: aws s3 ls s3://$STATE_BUCKET/$SERVICE_SLUG/ --recursive — then re-run with --force if it really is this deployment's state"
      fi
      DEPLOYMENT_ID="$(random_uuid)" || die_fix "could not generate a deploymentId" "install uuidgen (macOS) or openssl, then re-run"
      write_deployment_marker
      ;;
    *)
      rm -f "$marker"
      die_fix "$(aws_error_reason "$MARKER_ERR") while reading s3://$STATE_BUCKET/$DEPLOYMENT_MARKER_KEY" \
              "grant s3:GetObject on arn:aws:s3:::$STATE_BUCKET/* to $AWS_CALLER_ARN"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Lambda artifact (zero runtime dependencies: the runtime provides SDK v3)
# ---------------------------------------------------------------------------
# build_lambda_zip <strict|allow-missing>
#   strict: this run applies code, so src/ must be present and the archive must
#           keep the src/ prefix (the handler is src/lambda/handler.handler).
#   allow-missing: a destroy plan only hashes the archive, so an absent checkout
#           (or a missing src/) is tolerated — reuse an existing archive or write
#           a throwaway one rather than blocking the destroy.
build_lambda_zip() {
  local mode="$1" tmp
  local zip="$REPO_ROOT/dist/lambda.zip"
  mkdir -p "$REPO_ROOT/dist"

  if [ ! -f "$REPO_ROOT/src/lambda/handler.js" ]; then
    if [ "$mode" = "strict" ]; then
      die_fix "the Lambda source src/lambda/handler.js is missing from this checkout" \
              "check out the full branch ($SCRIPT_NAME needs src/ to build dist/lambda.zip): git status"
    fi
    if [ -s "$zip" ]; then
      warn "src/ is missing; reusing the existing dist/lambda.zip for this destroy plan"
      info "artifact dist/lambda.zip: $(wc -c < "$zip" | tr -d ' ') bytes"
      return 0
    fi
    warn "src/ and dist/lambda.zip are both missing; writing a throwaway archive so the destroy plan can hash one"
    tmp="$(mktemp -d)"
    printf '%s\n' "placeholder artifact so the destroy plan can hash dist/lambda.zip" > "$tmp/placeholder.txt"
    rm -f "$zip"
    ( cd "$tmp" && zip -qr "$zip" placeholder.txt )
    rm -rf "$tmp"
  else
    info "building dist/lambda.zip from src/"
    rm -f "$zip"
    ( cd "$REPO_ROOT" && zip -qr dist/lambda.zip src -x '*.DS_Store' -x '*node_modules*' -x 'test/*' )
  fi

  if [ ! -s "$zip" ]; then
    die_fix "dist/lambda.zip was not produced" "run the build by hand to see why: (cd $REPO_ROOT && zip -qr dist/lambda.zip src)"
  fi
  if [ "$mode" = "strict" ] && command -v unzip >/dev/null 2>&1; then
    if ! unzip -l "$zip" | grep -q 'src/lambda/handler.js'; then
      die_fix "dist/lambda.zip does not contain src/lambda/handler.js (Terraform expects handler src/lambda/handler.handler)" \
              "build it from the repo root so the src/ prefix is kept: (cd $REPO_ROOT && zip -qr dist/lambda.zip src)"
    fi
  fi
  info "artifact dist/lambda.zip: $(wc -c < "$zip" | tr -d ' ') bytes"
}

# ---------------------------------------------------------------------------
# OpenTofu
# ---------------------------------------------------------------------------
tofu_init() {
  if [ ! -d "$TF_DIR" ]; then
    die_fix "the OpenTofu root $TF_DIR does not exist" "restore infra/live/$REGION_CODE (brief §7 Step 8) before deploying"
  fi
  if [ ! -f "$BACKEND_HCL" ]; then
    die_fix "the backend config $BACKEND_HCL does not exist" "restore infra/backend/$REGION_CODE.hcl (state bucket $STATE_BUCKET, key $STATE_KEY, use_lockfile = true)"
  fi
  check_backend_key
  info "tofu init -reconfigure ($BACKEND_HCL)"
  local rc=0
  tofu -chdir="$TF_DIR" init -reconfigure -backend-config="$BACKEND_HCL" -input=false || rc=$?
  if [ "$rc" -ne 0 ]; then
    die_fix "tofu init failed in $TF_DIR" "fix what the output above reports (credentials for s3://$STATE_BUCKET, provider download, or $BACKEND_HCL), then re-run $SCRIPT_NAME --region $REGION_CODE"
  fi
}

run_plan() {
  PLAN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/unassign-plan.XXXXXX")"
  if [ "$DESTROY" -eq 1 ]; then
    PLAN_NAME="destroy.tfplan"
  else
    PLAN_NAME="deploy.tfplan"
  fi
  PLAN_PATH="$PLAN_DIR/$PLAN_NAME"
  local rc
  if [ "$DESTROY" -eq 1 ]; then
    info "tofu plan -destroy"
  else
    info "tofu plan"
  fi
  rc=0
  if [ "$DESTROY" -eq 1 ]; then
    tofu -chdir="$TF_DIR" plan -destroy -input=false -out="$PLAN_PATH" || rc=$?
  else
    tofu -chdir="$TF_DIR" plan -input=false -out="$PLAN_PATH" || rc=$?
  fi
  if [ "$rc" -ne 0 ] || [ ! -s "$PLAN_PATH" ]; then
    die_fix "tofu plan failed in $TF_DIR" "fix the error reported above, then re-run $SCRIPT_NAME --region $REGION_CODE"
  fi
}

print_plan_summary() {
  local rows adds changes destroys replaces
  rows="$(plan_rows "$PLAN_PATH")"
  adds="$(printf '%s\n' "$rows" | awk -F'\t' '$1=="create"{n++} END{print n+0}')"
  changes="$(printf '%s\n' "$rows" | awk -F'\t' '$1=="update"{n++} END{print n+0}')"
  destroys="$(printf '%s\n' "$rows" | awk -F'\t' '$1=="destroy"{n++} END{print n+0}')"
  replaces="$(printf '%s\n' "$rows" | awk -F'\t' '$1=="replace"{n++} END{print n+0}')"
  PLAN_ADDS="$adds"; PLAN_CHANGES="$changes"; PLAN_DESTROYS="$destroys"; PLAN_REPLACES="$replaces"

  step "Plan for $DEPLOYMENT_NAME ($AWS_REGION)"
  if [ "$((adds + changes + destroys + replaces))" -eq 0 ]; then
    printf '%s\n' "  no resource changes"
  else
    render_plan_rows "$rows"
  fi
  step "Summary"
  if [ "$destroys" -gt 0 ] || [ "$replaces" -gt 0 ]; then
    printf '%s\n' "  ${C_RED}$adds to add, $changes to change, $destroys to destroy, $replaces to replace${C_RESET}"
  else
    printf '%s\n' "  $adds to add, $changes to change, 0 to destroy"
  fi
}

print_outputs() {
  local outs
  outs="$(tofu -chdir="$TF_DIR" output -json 2>/dev/null || printf '{}')"
  {
    step "Outputs"
    printf '%s' "$outs" | jq -r '
      to_entries[]
      | select(.value.value != null and .value.value != "")
      | "  \(.key) = \(.value.value | if type == "string" then . else tojson end)"
    ' || true
  } >&2
  printf '%s' "$outs"
}

output_value() { # <json output doc> <name>
  printf '%s' "$2" | jq -r --arg n "$1" '.[$n].value // empty' 2>/dev/null || true
}

smoke_test() { # <function-name>
  local fn="$1" out rc body
  out="$(mktemp "${TMPDIR:-/tmp}/unassign-health.XXXXXX")"
  info "smoke test: invoking $fn with {\"action\":\"health\"}"
  rc=0
  aws_try lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out \
          --payload '{"action":"health"}' "$out" >/dev/null || rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f "$out"
    warn "health invoke failed: $(aws_error_reason "$(aws_last_err)")"
    hint "check the function name and logs: aws logs tail /aws/lambda/$fn --region $AWS_REGION --since 10m"
    return 0
  fi
  body="$(head -c 2000 "$out" 2>/dev/null || true)"
  rm -f "$out"
  if printf '%s' "$body" | jq -e '.ok == true' >/dev/null 2>&1; then
    ok "health: $(printf '%s' "$body" | jq -c '.')"
  else
    warn "the health action answered: $(printf '%s' "$body" | head -c 400)"
    hint "see the logs: aws logs tail /aws/lambda/$fn --region $AWS_REGION --since 10m"
  fi
}

cleanup() {
  aws_err_cleanup
  if [ -n "$PLAN_DIR" ] && [ -d "$PLAN_DIR" ]; then
    rm -rf "$PLAN_DIR"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
PLAN_ADDS=0; PLAN_CHANGES=0; PLAN_DESTROYS=0; PLAN_REPLACES=0
trap cleanup EXIT

if [ "$SELFTEST" -eq 1 ]; then
  PLAN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/unassign-plan.XXXXXX")"
  run_selftest
fi

select_region "$REGION_RAW"

if [ "$ASSUME_YES" -eq 1 ] && [ "$DESTROY" -eq 1 ]; then
  warn "--yes does not skip the destroy confirmation; you will still type the deployment name"
fi

step "Preflight ($DEPLOYMENT_NAME, $AWS_REGION)"
preflight_commands
caller_identity
check_environment_region
check_scheduler_access

step "State bucket s3://$STATE_BUCKET"
bootstrap_state_bucket

step "Lambda artifact"
if [ "$DESTROY" -eq 1 ]; then
  build_lambda_zip allow-missing
else
  build_lambda_zip strict
fi

check_state_keys

step "OpenTofu"
tofu_init
run_plan
print_plan_summary

if [ "$((PLAN_ADDS + PLAN_CHANGES + PLAN_DESTROYS + PLAN_REPLACES))" -eq 0 ]; then
  if [ "$DESTROY" -eq 1 ]; then
    ok "Nothing to destroy: $DEPLOYMENT_NAME has no managed resources left."
  else
    ok "No changes: $DEPLOYMENT_NAME in $AWS_REGION is already up to date (state and config in s3://$STATE_BUCKET)."
  fi
  exit 0
fi

if [ "$PLAN_ONLY" -eq 1 ]; then
  info "--plan-only: stopping after the plan. Apply it with: $SCRIPT_NAME --region $REGION_CODE${DESTROY:+ --destroy}"
  exit 0
fi

if [ "$DESTROY" -eq 1 ]; then
  if ! is_stdin_tty; then
    die_fix "destroy requires an interactive terminal (the deployment name must be typed)" \
            "run $SCRIPT_NAME --region $REGION_CODE --destroy from a terminal"
  fi
  warn "a destroy removes only what Terraform manages. Tenant secrets and tenant schedule groups created at runtime survive it — offboard the tenants first if you want them gone: scripts/offboard-customer.sh --region $REGION_CODE"
  if ! prompt_typed "This DESTROYS $PLAN_DESTROYS resource(s) (and replaces $PLAN_REPLACES) of the $DEPLOYMENT_NAME deployment in $AWS_REGION: the config bucket, the Lambda function and its URL, the IAM roles, the DLQ, the log group and the alarms. The state bucket s3://$STATE_BUCKET is kept." "$DEPLOYMENT_NAME"; then
    die_fix "destroy cancelled: the typed name did not match '$DEPLOYMENT_NAME'" "re-run $SCRIPT_NAME --region $REGION_CODE --destroy and type the deployment name exactly as shown"
  fi
else
  if [ "$ASSUME_YES" -eq 0 ]; then
    if ! prompt_yes_no "Apply this plan to $DEPLOYMENT_NAME ($AWS_REGION)?" n; then
      die_fix "deploy aborted at the confirmation prompt — nothing was applied" "re-run $SCRIPT_NAME --region $REGION_CODE when you are ready, or pass --yes to skip the prompt"
    fi
  else
    info "--yes: applying without asking"
  fi
fi

step "Apply"
rc=0
tofu -chdir="$TF_DIR" apply -input=false "$PLAN_PATH" || rc=$?
if [ "$rc" -ne 0 ]; then
  die_fix "tofu apply failed in $TF_DIR — the deployment is only partly applied" "read the error above, fix it, then re-run $SCRIPT_NAME --region $REGION_CODE: a re-run plans the remainder and applies nothing twice"
fi

if [ "$DESTROY" -eq 1 ]; then
  ok "destroyed $DEPLOYMENT_NAME. The state bucket s3://$STATE_BUCKET and its deployment marker were left in place on purpose."
  info "to remove the state bucket itself (types the bucket name): aws s3 rb s3://$STATE_BUCKET --force --region $AWS_REGION"
  exit 0
fi

OUTS="$(print_outputs)"
FN_NAME="$(output_value function_name "$OUTS")"
[ -n "$FN_NAME" ] || FN_NAME="$LAMBDA_FUNCTION_NAME"
smoke_test "$FN_NAME"

step "Next steps"
printf '%s\n' "  endpoint    : $(output_value function_url "$OUTS")"
printf '%s\n' "  config      : s3://$(output_value config_bucket "$OUTS")/$(output_value config_key "$OUTS")"
printf '%s\n' "  group prefix: $(output_value schedule_group_prefix "$OUTS")"
printf '%s\n' "  alarms      : $(output_value alarm_topic_arn "$OUTS")"
printf '%s\n' "  dlq         : $(output_value dlq_url "$OUTS")"
printf '\n'
printf '%s\n' "Onboard a customer:  scripts/onboard-customer.sh --region $REGION_CODE"
ok "$DEPLOYMENT_NAME deployed in $AWS_REGION (account $AWS_ACCOUNT_ID)."