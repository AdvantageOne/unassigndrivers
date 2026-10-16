#!/usr/bin/env bash
#
# scripts/onboard-customer.sh — add (or update) one tenant.
#
# Brief §7 Step 9: collect the tenant details, prove the Geotab service-account
# credentials with a live Authenticate BEFORE any AWS write, then create/update
# the secret unassign/<database>/serviceaccount and register the customer in
# s3://<config-bucket>/config/customers.json with a conditional (If-Match)
# read-modify-write so two operators onboarding at once cannot clobber each other.
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="scripts/onboard-customer.sh"
# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
LOG_TO_STDERR=1
trap aws_err_cleanup EXIT

REGION_RAW=""
DRY_RUN=0
SELFTEST=0

DATABASE=""
SERVER=""
USER_NAME=""
PASSWORD=""
TIMEZONE=""
NOTES=""
CREATED_BY=""

usage() {
  cat <<'USAGE'
scripts/onboard-customer.sh — add or update one tenant (Geotab database).

Usage:
  scripts/onboard-customer.sh [--region ca|us] [--dry-run]

Options:
  --region ca|us   Which deployment to onboard into: Canada (ca-central-1) or
                   United States (us-east-2). Asked interactively when omitted.
  --dry-run        Print the secret payload keys and the resulting
                   config/customers.json without writing anything.
  --selftest       Run the offline self-tests for the script's pure helpers.
  --help, -h       Show this text.

What it asks for, in order: Geotab database name, server (default
my.geotab.com), service-account user name, password (hidden, confirmed, at
least 16 characters — type "g" to generate a 32-character one), time zone
(default: the deployment's zone), optional notes.

It then (unless --dry-run):
  1. proves the credentials with a live POST to https://<server>/apiv1
     (Authenticate) — a failure exits non-zero with nothing written;
  2. creates or updates the secret unassign/<database>/serviceaccount;
  3. read-modify-writes s3://<config-bucket>/config/customers.json, retrying if
     another operator changed it first.

Examples:
  scripts/onboard-customer.sh --region ca
  scripts/onboard-customer.sh --region us --dry-run
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --region)
      [ "$#" -ge 2 ] || die_fix "--region needs a value" "pass --region ca (Canada) or --region us (United States)"
      REGION_RAW="$2"
      shift 2
      ;;
    --region=*)  REGION_RAW="${1#--region=}"; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    --selftest)  SELFTEST=1; shift ;;
    --help|-h)   usage; exit 0 ;;
    *) die_fix "unknown argument '$1'" "run '$SCRIPT_NAME --help' to see the accepted flags" ;;
  esac
done

# ---------------------------------------------------------------------------
# Self-tests (pure helpers only: no AWS, no network)
# ---------------------------------------------------------------------------
run_selftest() {
  local tmp entry merged merged2 count payload group long_db
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/unassign-selftest.XXXXXX")"

  st_eq "region ca -> deployment" "advone-ca-central" "$(region_field ca deployment)"
  st_eq "region ca -> config bucket" "advone-ca-central-config" "$(region_field ca config)"
  st_eq "region ca -> default time zone" "America/Toronto" "$(region_field ca tz)"
  st_eq "region us -> deployment" "advone-east-2" "$(region_field us deployment)"
  st_eq "region us -> config bucket" "advone-east-2-config" "$(region_field us config)"
  st_eq "region us -> default time zone" "America/New_York" "$(region_field us tz)"
  st_false "region 'mars' is rejected" region_code_from_arg mars

  st_true  "database name 'simplot_prod' accepted" valid_database_name "simplot_prod"
  st_true  "database name 'my-fleet.2' accepted" valid_database_name "my-fleet.2"
  st_false "database name 'has space' rejected" valid_database_name "has space"
  st_false "database name 'slash/db' rejected" valid_database_name "slash/db"
  st_false "database name '' rejected" valid_database_name ""
long_db="$(printf 'd%.0s' {1..65})"
  st_false "database name of 65 chars rejected" valid_database_name "$long_db"

  st_eq "dbPrefix lowercases" "simplot_prod" "$(db_prefix "SimPlot_Prod")"
  st_eq "dbPrefix replaces invalid characters" "a-b" "$(db_prefix "a b")"
  st_eq "dbPrefix truncates to 40 characters" "40" "$(printf '%s' "$(db_prefix "$long_db")" | wc -c | tr -d ' ')"
  group="$(schedule_group_name "simplot_prod")"
  st_eq "schedule group name" "UnassignDriverSchedules-simplot_prod" "$group"
  st_true "schedule group name stays within 64 characters for a 64-char database" \
    test "$(printf '%s' "$(schedule_group_name "$long_db")" | wc -c | tr -d ' ')" = "64"

  st_true  "time zone 'America/New_York' accepted" valid_timezone "America/New_York"
  st_false "time zone 'Mars/Olympus' rejected" valid_timezone "Mars/Olympus"
  st_false "time zone '' rejected" valid_timezone ""

  st_eq "normalize_server strips the scheme" "my.geotab.com" "$(normalize_server "https://my.geotab.com/apiv1")"
  st_eq "normalize_server trims" "my.geotab.com" "$(normalize_server "  my.geotab.com  ")"
  st_true "valid_server accepts a hostname" valid_server "my.geotab.com"
  st_false "valid_server rejects a bare word" valid_server "localhost"
  st_false "valid_server rejects spaces" valid_server "my geotab.com"

  payload="$(secret_payload_json "simplot_prod" "my.geotab.com" "svc@advone.io" "0123456789abcdef")"
  st_eq "secret payload keys (exactly the §5.7 four)" "database password server userName" "$(printf '%s' "$payload" | jq -r 'keys | join(" ")')"
  st_eq "secret payload database" "simplot_prod" "$(printf '%s' "$payload" | jq -r .database)"
  st_eq "secret payload server" "my.geotab.com" "$(printf '%s' "$payload" | jq -r .server)"
  st_eq "secret payload userName" "svc@advone.io" "$(printf '%s' "$payload" | jq -r .userName)"
  st_eq "secret payload password" "0123456789abcdef" "$(printf '%s' "$payload" | jq -r .password)"

  entry="$(customer_entry_json "simplot_prod" "my.geotab.com" "America/New_York" "arn:aws:iam::1:user/ops" "pilot tenant" "2026-10-15T00:00:00Z" "svc-unassign@advone.io")"
  st_eq "entry key" "simplot_prod" "$(printf '%s' "$entry" | jq -r .key)"
  st_eq "entry licenses the database" "true" "$(printf '%s' "$entry" | jq -r .license.licensed)"
  st_eq "entry records who licensed it" "onboard-script" "$(printf '%s' "$entry" | jq -r .license.source)"
  st_eq "entry records the worker user name" "svc-unassign@advone.io" "$(printf '%s' "$entry" | jq -r .workerUserName)"
  st_eq "entry secretName" "unassign/simplot_prod/serviceaccount" "$(printf '%s' "$entry" | jq -r .secretName)"
  st_eq "entry geotab.database" "simplot_prod" "$(printf '%s' "$entry" | jq -r .geotab.database)"
  st_true "entry enabled is a boolean true" test "$(printf '%s' "$entry" | jq -r '.enabled | type')" = "boolean"
  st_eq "entry notes" "pilot tenant" "$(printf '%s' "$entry" | jq -r .notes)"
  st_eq "entry createdAt" "2026-10-15T00:00:00Z" "$(printf '%s' "$entry" | jq -r .createdAt)"
  st_false "the customer entry never contains a password" bash -c "printf '%s' '$entry' | grep -q password"
  printf '%s\n' "$entry" > "$tmp/entry.json"

  cat > "$tmp/config.json" <<'JSON'
{
  "schemaVersion": 1,
  "deployment": {"name": "advone-ca-central", "region": "ca-central-1", "deploymentId": "existing-id"},
  "addIn": {"name": "Scheduled Driver Unassign by Advantage One",
            "pageName": "Scheduled Driver Unassign",
            "securityId": {"id": "acP6yyGZ42EmhgOePJfLP7w", "name": "ViewSecurityId"},
            "clearance": {"requireIsAdd": true, "allowEverythingGroup": true, "ignoreCatalogGroup": true}},
  "defaults": {"skipDriving": true, "graceMinutes": 60},
  "customers": {
    "other_db": {"key": "other_db", "geotab": {"database": "other_db", "server": "my.geotab.com"},
                 "secretName": "unassign/other_db/serviceaccount", "enabled": true, "timeZone": "America/Toronto",
                 "createdAt": "2026-01-01T00:00:00Z", "createdBy": "arn:aws:iam::1:user/ops", "notes": ""}
  }
}
JSON

  DEPLOYMENT_NAME="advone-ca-central"
  AWS_REGION="ca-central-1"
  CONFIG_DEPLOYMENT_ID="existing-id"
  merge_onboard_customer "$tmp/config.json" "$tmp/merged.json" "simplot_prod" "$tmp/entry.json"
  merged="$(cat "$tmp/merged.json")"
  st_eq "merge keeps the existing customer" "true" "$(printf '%s' "$merged" | jq -r '.customers.other_db.enabled')"
  st_eq "merge adds the new customer" "UnassignDriverSchedules-simplot_prod" "UnassignDriverSchedules-$(db_prefix "$(printf '%s' "$merged" | jq -r '.customers.simplot_prod.geotab.database')")"
  st_eq "merge keeps addIn.securityId.id" "acP6yyGZ42EmhgOePJfLP7w" "$(printf '%s' "$merged" | jq -r '.addIn.securityId.id')"
  st_eq "merge keeps the schema version" "1" "$(printf '%s' "$merged" | jq -r .schemaVersion)"
  st_eq "merge keeps the deploymentId" "existing-id" "$(printf '%s' "$merged" | jq -r .deployment.deploymentId)"
  st_eq "merge keeps the deployment name" "advone-ca-central" "$(printf '%s' "$merged" | jq -r .deployment.name)"
  st_eq "merge keeps untouched top-level keys" "60" "$(printf '%s' "$merged" | jq -r .defaults.graceMinutes)"

  merge_onboard_customer "$tmp/merged.json" "$tmp/merged2.json" "simplot_prod" "$tmp/entry.json"
  merged2="$(cat "$tmp/merged2.json")"
  count="$(printf '%s' "$merged2" | jq -r '.customers | length')"
  st_eq "re-onboarding is idempotent (still 2 customers)" "2" "$count"
  st_eq "re-onboarding preserves createdAt" "2026-10-15T00:00:00Z" "$(printf '%s' "$merged2" | jq -r '.customers.simplot_prod.createdAt')"

  cat > "$tmp/foreign.json" <<'JSON'
{"schemaVersion": 1,
 "deployment": {"name": "advone-east-2", "region": "us-east-2", "deploymentId": "us-id"},
 "customers": {}}
JSON
  st_false_quiet "merge refuses a config that belongs to the other deployment" \
    merge_onboard_customer "$tmp/foreign.json" "$tmp/foreign-out.json" "simplot_prod" "$tmp/entry.json"

  cat > "$tmp/future.json" <<'JSON'
{"schemaVersion": 2, "deployment": {"name": "advone-ca-central", "region": "ca-central-1"}, "customers": {}}
JSON
  st_false_quiet "merge refuses an unknown schemaVersion" \
    merge_onboard_customer "$tmp/future.json" "$tmp/future-out.json" "simplot_prod" "$tmp/entry.json"

  st_false_quiet "merge refuses to disable a customer that is not there" \
    merge_disable_customer "$tmp/config.json" "$tmp/disabled.json" "ghost_db"

  st_eq "generated password is 32 alphanumeric characters" "32" "$(printf '%s' "$(generate_password)" | wc -c | tr -d ' ')"
  st_false "generated password contains no symbols" \
    bash -c "printf '%s' '$(generate_password)' | grep -q '[^A-Za-z0-9]'"

  rm -rf "$tmp"
  st_done "$SCRIPT_NAME"
}

# ---------------------------------------------------------------------------
# Input collection
# ---------------------------------------------------------------------------
gather_database() {
  DATABASE="$(prompt_required "Geotab database name")"
  while ! valid_database_name "$DATABASE"; do
    warn "'$DATABASE' is not a valid Geotab database name"
    hint "use up to 64 characters, starting with a letter or digit: letters, digits, dot, dash, underscore (e.g. simplot_prod)"
    DATABASE="$(prompt_required "Geotab database name")"
  done
}

gather_server() {
  local raw
  raw="$(prompt_line "Geotab server" "my.geotab.com")"
  SERVER="$(normalize_server "$raw")"
  if ! valid_server "$SERVER"; then
    die_fix "'$raw' is not a usable Geotab server" "give a hostname such as my.geotab.com (or your reseller's host), without a scheme or path"
  fi
}

gather_user_name() {
  USER_NAME="$(prompt_required "Service-account user name")"
  while ! valid_user_name "$USER_NAME"; do
    warn "'$USER_NAME' is not a usable user name"
    hint "Geotab service accounts look like user@example.com and cannot contain spaces"
    USER_NAME="$(prompt_required "Service-account user name")"
  done
  case "$USER_NAME" in
    *@*) : ;;
    *) warn "'$USER_NAME' does not look like an email address — MyGeotab user names usually are (user@example.com)" ;;
  esac
}

gather_password() {
  PASSWORD="$(read_password_interactive 16)"
  if [ "$GENERATED_PASSWORD" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      info "a 32-character password was generated (not shown in --dry-run; run without --dry-run and it is printed once)"
    else
      step "Generated password for $USER_NAME — store it now"
      printf '%s\n' "$PASSWORD"
      warn "this is the only time the generated password is displayed"
    fi
  fi
}

gather_timezone() {
  TIMEZONE="$(prompt_line "Time zone" "$DEFAULT_TIMEZONE")"
  while ! valid_timezone "$TIMEZONE"; do
    warn "'$TIMEZONE' is not a known IANA time zone"
    hint "use a zone such as $DEFAULT_TIMEZONE (the list lives in /usr/share/zoneinfo)"
    TIMEZONE="$(prompt_line "Time zone" "$DEFAULT_TIMEZONE")"
  done
}

gather_inputs() {
  step "Customer details for $DEPLOYMENT_NAME ($AWS_REGION)"
  gather_database
  gather_server
  gather_user_name
  gather_password
  gather_timezone
  NOTES="$(prompt_line "Notes (optional)" "")"
}

# ---------------------------------------------------------------------------
# Credential verification (before any AWS write)
# ---------------------------------------------------------------------------
MYGEOTAB_SESSION_ID=""
MYGEOTAB_PATH=""

rpc_call() { # <json-body-file> -> response on stdout, dies with an actionable message
  local body="$1" err response rc
  err="$(mktemp "${TMPDIR:-/tmp}/unassign-curl.XXXXXX")"
  rc=0
  response="$(curl -sS --max-time 30 -X POST "https://$SERVER/apiv1" \
                  -H 'Content-Type: application/json' --data-binary "@$body" 2>"$err")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    local detail
    detail="$(aws_error_first_line "$(cat "$err")")"
    rm -f "$err"
    die_fix "could not reach https://$SERVER/apiv1 ($detail)" "check the server name (server: $SERVER) and that this machine has internet access, then re-run"
  fi
  rm -f "$err"
  if ! printf '%s' "$response" | jq -e . >/dev/null 2>&1; then
    die_fix "https://$SERVER/apiv1 did not answer with JSON (first 200 bytes: $(printf '%s' "$response" | head -c 200))" \
            "confirm the server hostname for database $DATABASE and that MyGeotab is reachable, then re-run"
  fi
  printf '%s' "$response"
}

verify_credentials() {
  local body response err_code err_message session path
  step "Verifying the service account against https://$SERVER/apiv1"
  body="$(mktemp "${TMPDIR:-/tmp}/unassign-rpc.XXXXXX")"
  jq -n --arg database "$DATABASE" --arg userName "$USER_NAME" --arg password "$PASSWORD" \
    '{method: "Authenticate", params: {database: $database, userName: $userName, password: $password}}' > "$body"
  response="$(rpc_call "$body")"
  rm -f "$body"

  err_code="$(printf '%s' "$response" | jq -r '.error.code // empty')"
  if [ -n "$err_code" ]; then
    err_message="$(printf '%s' "$response" | jq -r '.error.message // empty')"
    die_fix "MyGeotab refused the credentials for database '$DATABASE' as user '$USER_NAME' ($err_code: $err_message)" \
            "check the database name, the service-account user name and the password (and that the account is not locked or expired), then re-run — nothing was written"
  fi

  session="$(printf '%s' "$response" | jq -r '.result.credentials.sessionId // empty')"
  if [ -z "$session" ]; then
    die_fix "MyGeotab accepted the call but returned no session for '$DATABASE' as '$USER_NAME'" \
            "confirm the account is an enabled MyGeotab user with a service-account license, then re-run — nothing was written"
  fi
  MYGEOTAB_SESSION_ID="$session"
  path="$(printf '%s' "$response" | jq -r '.result.path // empty')"
  if [ -n "$path" ] && [ "$path" != "ThisServer" ]; then
    MYGEOTAB_PATH="$(normalize_server "$path")"
    info "MyGeotab answered from $SERVER; this database lives on $MYGEOTAB_PATH"
  fi
  ok "Authenticate succeeded for $USER_NAME@$DATABASE"
}

probe_user_read() {
  local body response err_code
  body="$(mktemp "${TMPDIR:-/tmp}/unassign-rpc.XXXXXX")"
  jq -n --arg database "$DATABASE" --arg userName "$USER_NAME" --arg sessionId "$MYGEOTAB_SESSION_ID" \
    '{method: "Get",
      params: {typeName: "User", search: {name: $userName},
               credentials: {database: $database, userName: $userName, sessionId: $sessionId}}}' > "$body"
  response="$(rpc_call "$body")"
  rm -f "$body"
  err_code="$(printf '%s' "$response" | jq -r '.error.code // empty')"
  if [ -n "$err_code" ]; then
    warn "Get User failed for $USER_NAME ($err_code: $(printf '%s' "$response" | jq -r '.error.message // empty'))"
    hint "continuing: the service account only needs DriverChange and AddInData rights, not user administration"
    return 0
  fi
  ok "Get User returned $(printf '%s' "$response" | jq -r '(.result // []) | length') record(s)"
}

# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------
SECRET_NAME=""

write_secret_value() {
  local payload
  payload="$(mktemp "${TMPDIR:-/tmp}/unassign-secret.XXXXXX")"
  secret_payload_json "$DATABASE" "$SERVER" "$USER_NAME" "$PASSWORD" > "$payload"
  step "Secret $SECRET_NAME"
  write_secret "$SECRET_NAME" "$payload"
  rm -f "$payload"
  ok "secret $SECRET_NAME holds the service-account credentials for $SERVER/$DATABASE"
}

register_customer() {
  local entry in out
  entry="$(mktemp "${TMPDIR:-/tmp}/unassign-entry.XXXXXX")"
  customer_entry_json "$DATABASE" "$SERVER" "$TIMEZONE" "$CREATED_BY" "$NOTES" "" "$USER_NAME" > "$entry"
  step "Registering $DATABASE in s3://$CONFIG_BUCKET/$CONFIG_KEY"
  config_update "$CONFIG_BUCKET" merge_onboard_customer "$DATABASE" "$entry"
  rm -f "$entry"
  ok "customer $DATABASE registered (enabled)"
}

verify_registration() {
  local file rc addin_id
  file="$(mktemp "${TMPDIR:-/tmp}/unassign-config.XXXXXX")"
  rc=0
  s3_config_get "$CONFIG_BUCKET" "$file" || rc=$?
  if [ "$rc" -ne 0 ]; then
    rm -f "$file"
    warn "could not re-read the config to verify the write ($(aws_error_reason "$S3_CONFIG_ERR"))"
    hint "check it later with: aws s3 cp s3://$CONFIG_BUCKET/$CONFIG_KEY - | jq '.customers.\"$DATABASE\"'"
    return 0
  fi
  if ! jq -e --arg k "$DATABASE" '.customers[$k] != null' "$file" >/dev/null 2>&1; then
    rm -f "$file"
    die_fix "the write to s3://$CONFIG_BUCKET/$CONFIG_KEY did not stick: customer '$DATABASE' is missing" \
            "re-run $SCRIPT_NAME --region $REGION_CODE, and check the bucket versioning/retention policy"
  fi
  ok "config contains: $(jq -c --arg k "$DATABASE" '.customers[$k] | {key, secretName, enabled, timeZone, licensed: .license.licensed, server: .geotab.server}' "$file")"
  addin_id="$(jq -r '.addIn.securityId.id // ""' "$file")"
  if [ -z "$addin_id" ]; then
    warn "addIn.securityId.id is still empty in this config: the Lambda denies every user until this add-in's Geotab ViewSecurityId is captured (brief §7 Step 0)"
    hint "capture the filter id from a database where the add-in is installed, then set it: run scripts/deploy.sh --region $REGION_CODE with -var addin_security_id=<id>"
  fi
  rm -f "$file"
}

dry_run_preview() {
  local payload entry in out rc
  payload="$(secret_payload_json "$DATABASE" "$SERVER" "$USER_NAME" "$PASSWORD")"
  entry="$(customer_entry_json "$DATABASE" "$SERVER" "$TIMEZONE" "$CREATED_BY" "$NOTES" "" "$USER_NAME")"

  step "Dry run — nothing is written"
  info "secret payload for $SECRET_NAME (value of 'password' redacted):"
  printf '%s' "$payload" | jq '{keys: (keys | sort), database, server, userName, password: "<redacted>"}' >&2
  info "customer entry for config/customers.json:"
  printf '%s' "$entry" | jq . >&2

  in="$(mktemp "${TMPDIR:-/tmp}/unassign-config.XXXXXX")"
  out="$(mktemp "${TMPDIR:-/tmp}/unassign-config-out.XXXXXX")"
  rc=0
  s3_config_get "$CONFIG_BUCKET" "$in" || rc=$?
  if [ "$rc" -eq 0 ]; then
    CONFIG_DEPLOYMENT_ID="$(resolve_deployment_id "$in")"
    info "merging into the live config (ETag $S3_CONFIG_ETAG)"
  else
    warn "skipping the live config read: $(aws_error_reason "$S3_CONFIG_ERR")"
    hint "nothing is written in --dry-run; deploy first if this region has no config bucket yet: scripts/deploy.sh --region $REGION_CODE"
    CONFIG_DEPLOYMENT_ID="$(resolve_deployment_id "")"
    config_skeleton "$DEPLOYMENT_NAME" "$AWS_REGION" "$CONFIG_DEPLOYMENT_ID" > "$in"
  fi

  local entryfile
  entryfile="$(mktemp "${TMPDIR:-/tmp}/unassign-entry.XXXXXX")"
  printf '%s' "$entry" > "$entryfile"
  merge_onboard_customer "$in" "$out" "$DATABASE" "$entryfile"
  rm -f "$in" "$entryfile"
  info "resulting config/customers.json:"
  jq . "$out"
  rm -f "$out"

  step "Summary"
  msg "  secret name   : $SECRET_NAME"
  msg "  customer key  : $DATABASE"
  msg "  schedule group: $(schedule_group_name "$DATABASE")"
  msg "  config        : s3://$CONFIG_BUCKET/$CONFIG_KEY"
  ok "dry run complete: no secret written, no config written. Re-run without --dry-run to apply."
}

caller_arn_soft() {
  local out
  if out="$(aws_try sts get-caller-identity --output json 2>/dev/null)"; then
    printf '%s' "$out" | jq -r '.Arn'
    return 0
  fi
  printf 'unresolved (aws sts get-caller-identity: %s)' "$(aws_error_reason "$(aws_last_err)")"
}

caller_arn_required() {
  local out
  if ! out="$(aws_try sts get-caller-identity --output json)"; then
    die_fix "$(aws_error_reason "$(aws_last_err)") while calling aws sts get-caller-identity" \
            "run \"aws configure\" (or \"aws sso login\") for the account that owns $DEPLOYMENT_NAME, then re-run"
  fi
  printf '%s' "$out" | jq -r '.Arn'
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if [ "$SELFTEST" -eq 1 ]; then
  run_selftest
fi

select_region "$REGION_RAW"
require_command aws jq
if [ "$DRY_RUN" -eq 0 ]; then
  require_command curl
fi

info "Target: $DEPLOYMENT_NAME ($AWS_REGION), config s3://$CONFIG_BUCKET/$CONFIG_KEY"
gather_inputs

SECRET_NAME="$(secret_name_for "$DATABASE")"

if [ "$DRY_RUN" -eq 1 ]; then
  CREATED_BY="$(caller_arn_soft)"
  dry_run_preview
  exit 0
fi

CREATED_BY="$(caller_arn_required)"
verify_credentials
probe_user_read
write_secret_value
PASSWORD=""
unset PASSWORD
register_customer
verify_registration

step "Onboarded $DATABASE"
msg "  secret name   : $SECRET_NAME"
msg "  customer key  : $DATABASE"
msg "  schedule group: $(schedule_group_name "$DATABASE")"
msg "  config        : s3://$CONFIG_BUCKET/$CONFIG_KEY"
msg ""
msg "The add-in can now create schedules for $DATABASE against the $DEPLOYMENT_NAME Function URL."
msg "To remove the tenant again: scripts/offboard-customer.sh --region $REGION_CODE"
ok "onboarding complete."