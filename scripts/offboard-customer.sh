#!/usr/bin/env bash
#
# scripts/offboard-customer.sh — remove one tenant.
#
# Brief §7 Step 9, in reverse: disable the customer in the S3 config (the entry
# and the tenant's Geotab run history stay), delete the tenant's EventBridge
# Scheduler schedules after confirmation, and optionally delete the secret.
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="scripts/offboard-customer.sh"
# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
LOG_TO_STDERR=1
trap aws_err_cleanup EXIT

REGION_RAW=""
DELETE_SECRET=0
ASSUME_YES=0
SELFTEST=0

DATABASE=""
SECRET_NAME=""
GROUP_NAME=""

usage() {
  cat <<'USAGE'
scripts/offboard-customer.sh — remove one tenant (Geotab database).

Usage:
  scripts/offboard-customer.sh [--region ca|us] [--delete-secret] [--yes]

Options:
  --region ca|us    Which deployment the tenant lives in: Canada (ca-central-1)
                    or United States (us-east-2). Asked interactively when omitted.
  --delete-secret   Also delete the Secrets Manager secret unassign/<database>
                    (30-day recovery window; recovery is reversible).
  --yes, -y         Answer "yes" to every confirmation prompt.
  --selftest        Run the offline self-tests for the script's pure helpers.
  --help, -h        Show this text.

What it does:
  1. asks for the Geotab database name and refuses an unknown or missing tenant;
  2. sets "enabled": false in s3://<config-bucket>/config/customers.json
     (conditional write, retried if another operator writes at the same time) —
     the entry itself is kept, so the tenant's run history survives;
  3. lists the tenant's schedules in the
     UnassignDriverSchedules-<dbPrefix> group and deletes them after
     confirmation;
  4. with --delete-secret, deletes the secret after confirmation.

Prompt defaults: disabling the customer defaults to yes (reversible, the entry
and its history stay); deleting schedules or the secret defaults to no.

To bring a tenant back, re-run scripts/onboard-customer.sh --region <ca|us>:
it rewrites the entry with enabled: true and the same secret name.

Examples:
  scripts/offboard-customer.sh --region ca
  scripts/offboard-customer.sh --region ca --delete-secret --yes
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --region)
      [ "$#" -ge 2 ] || die_fix "--region needs a value" "pass --region ca (Canada) or --region us (United States)"
      REGION_RAW="$2"
      shift 2
      ;;
    --region=*)      REGION_RAW="${1#--region=}"; shift ;;
    --delete-secret) DELETE_SECRET=1; shift ;;
    --yes|-y)        ASSUME_YES=1; shift ;;
    --selftest)      SELFTEST=1; shift ;;
    --help|-h)       usage; exit 0 ;;
    *) die_fix "unknown argument '$1'" "run '$SCRIPT_NAME --help' to see the accepted flags" ;;
  esac
done

# ---------------------------------------------------------------------------
# Self-tests (pure helpers only: no AWS, no tofu)
# ---------------------------------------------------------------------------
run_selftest() {
  local tmp merged long_db
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/unassign-selftest.XXXXXX")"

  st_eq "region ca -> aws region" "ca-central-1" "$(region_field ca region)"
  st_eq "region ca -> state bucket" "advone-ca-central-deploy" "$(region_field ca state)"
  st_eq "region us -> aws region" "us-east-2" "$(region_field us region)"
  st_eq "region us -> deployment" "advone-east-2" "$(region_field us deployment)"
  st_eq "region arg 'united-states' maps to code" "us" "$(region_code_from_arg united-states)"
  st_false "region 'mars' is rejected" region_code_from_arg mars

  st_eq "secret name pattern" "unassign/simplot_prod" "$(secret_name_for "simplot_prod")"
  st_eq "tenant schedule group for a mixed-case database" \
    "UnassignDriverSchedules-simplot_prod" "$(schedule_group_name "Simplot_Prod")"
  long_db="$(printf 'd%.0s' {1..64})"
  st_true "tenant schedule group fits the 64-character limit" \
    test "$(printf '%s' "$(schedule_group_name "$long_db")" | wc -c | tr -d ' ')" = "64"
  st_false "database name with a slash is rejected" valid_database_name "slash/db"

  cat > "$tmp/config.json" <<'JSON'
{
  "schemaVersion": 1,
  "deployment": {"name": "advone-ca-central", "region": "ca-central-1", "deploymentId": "existing-id"},
  "addIn": {"securityId": {"id": "acP6yyGZ42EmhgOePJfLP7w", "name": "ViewSecurityId"}},
  "customers": {
    "simplot_prod": {"key": "simplot_prod", "geotab": {"database": "simplot_prod", "server": "my.geotab.com"},
                     "secretName": "unassign/simplot_prod", "enabled": true, "timeZone": "America/New_York",
                     "createdAt": "2026-10-15T00:00:00Z", "createdBy": "arn:aws:iam::1:user/ops",
                     "notes": "pilot tenant"},
    "other_db": {"key": "other_db", "geotab": {"database": "other_db", "server": "my.geotab.com"},
                 "secretName": "unassign/other_db", "enabled": true, "timeZone": "America/Toronto",
                 "createdAt": "2026-01-01T00:00:00Z", "createdBy": "arn:aws:iam::1:user/ops", "notes": ""}
  }
}
JSON

  DEPLOYMENT_NAME="advone-ca-central"
  AWS_REGION="ca-central-1"
  CONFIG_DEPLOYMENT_ID="existing-id"
  merge_disable_customer "$tmp/config.json" "$tmp/disabled.json" "simplot_prod"
  merged="$(cat "$tmp/disabled.json")"
  st_eq "disable sets enabled false" "false" "$(printf '%s' "$merged" | jq -r '.customers.simplot_prod.enabled')"
  st_eq "disable keeps the entry (history survives)" "simplot_prod" "$(printf '%s' "$merged" | jq -r '.customers.simplot_prod.key')"
  st_eq "disable keeps createdAt" "2026-10-15T00:00:00Z" "$(printf '%s' "$merged" | jq -r '.customers.simplot_prod.createdAt')"
  st_eq "disable keeps notes" "pilot tenant" "$(printf '%s' "$merged" | jq -r '.customers.simplot_prod.notes')"
  st_eq "disable keeps the secret reference" "unassign/simplot_prod" "$(printf '%s' "$merged" | jq -r '.customers.simplot_prod.secretName')"
  st_eq "disable leaves other tenants alone" "true" "$(printf '%s' "$merged" | jq -r '.customers.other_db.enabled')"
  st_eq "disable keeps the addIn block" "acP6yyGZ42EmhgOePJfLP7w" "$(printf '%s' "$merged" | jq -r '.addIn.securityId.id')"
  st_eq "disable is idempotent" "false" "$(merge_disable_customer "$tmp/disabled.json" "$tmp/disabled2.json" "simplot_prod" && jq -r '.customers.simplot_prod.enabled' "$tmp/disabled2.json")"

  st_false_quiet "disable refuses an unknown tenant" \
    merge_disable_customer "$tmp/config.json" "$tmp/ghost.json" "ghost_db"

  cat > "$tmp/foreign.json" <<'JSON'
{"schemaVersion": 1, "deployment": {"name": "advone-east-2", "region": "us-east-2", "deploymentId": "us-id"},
 "customers": {"simplot_prod": {"key": "simplot_prod", "enabled": true}}}
JSON
  st_false_quiet "disable refuses a config owned by the other deployment" \
    merge_disable_customer "$tmp/foreign.json" "$tmp/foreign-out.json" "simplot_prod"

  rm -rf "$tmp"
  st_done "$SCRIPT_NAME"
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------
ask_database() {
  DATABASE="$(prompt_required "Geotab database name to offboard")"
  while ! valid_database_name "$DATABASE"; do
    warn "'$DATABASE' is not a valid Geotab database name"
    hint "use the database name exactly as it was onboarded (e.g. simplot_prod)"
    DATABASE="$(prompt_required "Geotab database name to offboard")"
  done
}

load_config() { # -> config on stdout; dies with the exact fix otherwise
  local file rc
  file="$(mktemp "${TMPDIR:-/tmp}/unassign-config.XXXXXX")"
  rc=0
  s3_config_get "$CONFIG_BUCKET" "$file" || rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f "$file"
    s3_config_die "$CONFIG_BUCKET"
  fi
  cat "$file"
  rm -f "$file"
}

require_known_customer() { # <config-json>
  if ! printf '%s' "$1" | jq -e --arg k "$DATABASE" '.customers[$k] != null' >/dev/null 2>&1; then
    die_fix "customer '$DATABASE' is not in s3://$CONFIG_BUCKET/$CONFIG_KEY" \
            "check the name (case matters) or onboard it with scripts/onboard-customer.sh --region $REGION_CODE; list the tenants with: aws s3 cp s3://$CONFIG_BUCKET/$CONFIG_KEY - | jq -r '.customers | keys[]'"
  fi
}

disable_customer() { # <config-json>
  local state
  state="$(printf '%s' "$1" | jq -r --arg k "$DATABASE" '.customers[$k].enabled | tostring')"
  if [ "$state" = "false" ]; then
    warn "customer '$DATABASE' is already disabled — refreshing it anyway"
  fi
  if [ "$ASSUME_YES" -eq 0 ]; then
    if ! prompt_yes_no "Disable customer '$DATABASE' in $CONFIG_KEY (the entry and its run history are kept)?" y; then
      die_fix "offboard cancelled at the confirmation prompt — nothing was changed" "re-run $SCRIPT_NAME --region $REGION_CODE when you are ready, or pass --yes"
    fi
  fi
  step "Disabling $DATABASE in s3://$CONFIG_BUCKET/$CONFIG_KEY"
  config_update "$CONFIG_BUCKET" merge_disable_customer "$DATABASE"
  ok "customer $DATABASE is now disabled (new schedules are refused; a schedule that fires is skipped)"
}

LIST_GROUP_MISSING=0

list_tenant_schedules() { # <group> -> "name<TAB>state<TAB>expression" lines
  local token="" resp rc
  local args
  while :; do
    args=(scheduler list-schedules --group-name "$1" --max-results 100 --output json)
    if [ -n "$token" ]; then
      args+=(--next-token "$token")
    fi
    rc=0
    resp="$(aws_try "${args[@]}")" || rc=$?
    if [ "$rc" -ne 0 ]; then
      case "$(aws_last_err)" in
        *ResourceNotFoundException*)
          LIST_GROUP_MISSING=1
          return 0
          ;;
        *)
          die_fix "$(aws_error_reason "$(aws_last_err)") while listing schedules in group $1" \
                  "grant scheduler:ListSchedules on arn:aws:scheduler:$AWS_REGION:*:schedule-group/$1* to your principal"
          ;;
      esac
    fi
    printf '%s' "$resp" | jq -r '.Schedules[]? | [.Name, (.State // "-"), (.ScheduleExpression // "-"), (.Target.Arn // "-")] | @tsv'
    token="$(printf '%s' "$resp" | jq -r '.NextToken // empty')"
    if [ -z "$token" ]; then
      return 0
    fi
  done
}

delete_tenant_schedule() { # <group> <name>
  local rc
  rc=0
  aws_try scheduler delete-schedule --group-name "$1" --name "$2" >/dev/null || rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$(aws_last_err)" in
      *ResourceNotFoundException*)
        warn "schedule $2 was already gone (no-op)"
        return 0
        ;;
      *)
        die_fix "$(aws_error_reason "$(aws_last_err)") while deleting schedule $2 in group $1" \
                "grant scheduler:DeleteSchedule on arn:aws:scheduler:$AWS_REGION:*:schedule/$1/$2"
        ;;
    esac
  fi
  ok "deleted schedule $2"
}

delete_tenant_schedules() {
  local schedules count
  step "Tenant schedules in group $GROUP_NAME"
  schedules="$(list_tenant_schedules "$GROUP_NAME")"
  if [ "$LIST_GROUP_MISSING" -eq 1 ]; then
    ok "no schedule group $GROUP_NAME exists — nothing to delete"
    return 0
  fi
  count="$(printf '%s\n' "$schedules" | grep -c . || true)"
  if [ "$count" -eq 0 ]; then
    ok "group $GROUP_NAME has no schedules — nothing to delete"
    return 0
  fi
  printf '%s\n' "$schedules" | awk -F'\t' '{ printf "  %s  (%s, %s)\n", $1, $2, $3 }' >&2
  if [ "$ASSUME_YES" -eq 0 ]; then
    if ! prompt_yes_no "Delete these $count schedule(s) in $GROUP_NAME?" n; then
      warn "keeping the $count schedule(s) in $GROUP_NAME"
      hint "delete them later with: aws scheduler list-schedules --group-name $GROUP_NAME --region $AWS_REGION"
      return 0
    fi
  fi
  printf '%s\n' "$schedules" | while IFS=$'\t' read -r name _state _expr _arn; do
    [ -n "$name" ] || continue
    delete_tenant_schedule "$GROUP_NAME" "$name"
  done
}

delete_secret_if_requested() {
  local rc
  [ "$DELETE_SECRET" -eq 1 ] || return 0
  step "Secret $SECRET_NAME"
  rc=0
  aws_try secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null || rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$(aws_last_err)" in
      *ResourceNotFoundException*)
        warn "secret $SECRET_NAME does not exist — nothing to delete"
        return 0
        ;;
      *)
        die_fix "$(aws_error_reason "$(aws_last_err)") while reading the secret $SECRET_NAME" \
                "grant secretsmanager:DescribeSecret on arn:aws:secretsmanager:$AWS_REGION:*:secret:$SECRET_NAME-*"
        ;;
    esac
  fi
  if [ "$ASSUME_YES" -eq 0 ]; then
    if ! prompt_yes_no "Delete the secret $SECRET_NAME (30-day recovery window)?" n; then
      warn "keeping the secret $SECRET_NAME"
      hint "delete it later with: aws secretsmanager delete-secret --secret-id $SECRET_NAME --recovery-window-in-days 30 --region $AWS_REGION"
      return 0
    fi
  fi
  rc=0
  aws_try secretsmanager delete-secret --secret-id "$SECRET_NAME" --recovery-window-in-days 30 >/dev/null || rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$(aws_last_err)" in
      *ResourceNotFoundException*)
        warn "secret $SECRET_NAME disappeared concurrently — nothing to delete"
        return 0
        ;;
      *)
        die_fix "$(aws_error_reason "$(aws_last_err)") while deleting the secret $SECRET_NAME" \
                "grant secretsmanager:DeleteSecret on arn:aws:secretsmanager:$AWS_REGION:*:secret:$SECRET_NAME-*"
        ;;
    esac
  fi
  ok "secret $SECRET_NAME is scheduled for deletion (recover within 30 days: aws secretsmanager restore-secret --secret-id $SECRET_NAME --region $AWS_REGION)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if [ "$SELFTEST" -eq 1 ]; then
  run_selftest
fi

select_region "$REGION_RAW"
require_command aws jq

info "Target: $DEPLOYMENT_NAME ($AWS_REGION), config s3://$CONFIG_BUCKET/$CONFIG_KEY"
step "Which tenant?"
ask_database
SECRET_NAME="$(secret_name_for "$DATABASE")"
GROUP_NAME="$(schedule_group_name "$DATABASE")" || die_fix "cannot derive a schedule-group name from '$DATABASE'" "rename the database or onboard it as a conforming name (letters, digits, dot, dash, underscore)"

CONFIG_JSON="$(load_config)"
require_known_customer "$CONFIG_JSON"
disable_customer "$CONFIG_JSON"
delete_tenant_schedules
delete_secret_if_requested

step "Offboarded $DATABASE"
msg "  customer key  : $DATABASE (entry kept, enabled: false)"
msg "  secret name   : $SECRET_NAME"
msg "  schedule group: $GROUP_NAME"
msg ""
msg "Bring the tenant back with: scripts/onboard-customer.sh --region $REGION_CODE"
ok "offboarding complete."