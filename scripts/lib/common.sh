#!/usr/bin/env bash
# scripts/lib/common.sh — shared helpers for the unassign operator scripts.
#
# Sourced (never executed) by scripts/deploy.sh, scripts/onboard-customer.sh and
# scripts/offboard-customer.sh:
#
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   . "$SCRIPT_DIR/lib/common.sh"
#
# Contents: colour/log helpers, the CA/US deployment mapping (brief §3), argument
# and prompt helpers, dependency preflight, the pure naming/JSON helpers that the
# --selftest modes exercise, and the S3-config / Secrets Manager wrappers used by
# onboarding and offboarding.
#
# Every failure path prints "error: <what>" plus a "fix: <exact command>" line on
# stderr and exits non-zero. Nothing here logs a password or a secret payload.

COMMON_SH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "$COMMON_SH_DIR/../.." && pwd)}"

# The deploy buckets (advone-<region>-deploy) hold more than one service, so
# every object this service owns sits under its own prefix: the OpenTofu state,
# the lock file OpenTofu writes beside it, and this service's ownership marker.
# Changing the slug is a state migration, not a rename.
SERVICE_SLUG="scheduled-driver-unassign"

# Contract constants (frozen): state key, config object key, tenant schedule-group
# prefix, Lambda function name.
STATE_KEY="$SERVICE_SLUG/terraform.tfstate"
LEGACY_STATE_KEY="unassign/terraform.tfstate" # pre-prefix location; deploy.sh refuses to duplicate it
CONFIG_KEY="config/customers.json"
DEPLOYMENT_MARKER_KEY="$SERVICE_SLUG/deployment.json"
SCHEDULE_GROUP_PREFIX="${SCHEDULE_GROUP_PREFIX:-UnassignDriverSchedules}"
LAMBDA_FUNCTION_NAME="advone-unassign-api"

# ---------------------------------------------------------------------------
# Colour + logging
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

# msg <text>: human-facing status line. Scripts that print machine-readable JSON
# on stdout set LOG_TO_STDERR=1 so the log lines go to stderr instead.
msg() {
  if [ "${LOG_TO_STDERR:-0}" = "1" ]; then printf '%s\n' "$*" >&2; else printf '%s\n' "$*"; fi
}
info()  { msg "${C_BLUE}==>${C_RESET} $*"; }
ok()    { msg "${C_GREEN}ok:${C_RESET} $*"; }
step()  { msg ""; msg "${C_BOLD}$*${C_RESET}"; }
warn()  { printf '%s\n' "${C_YELLOW}warning:${C_RESET} $*" >&2; }
error() { printf '%s\n' "${C_RED}error:${C_RESET} $*" >&2; }
hint()  { printf '%s\n' "${C_DIM}       fix: $*${C_RESET}" >&2; }
die_fix() { error "$1"; hint "$2"; exit 1; }

# ---------------------------------------------------------------------------
# Strings
# ---------------------------------------------------------------------------
trim() {
  local s="${1:-}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}
lower() { printf '%s' "${1:-}" | tr 'A-Z' 'a-z'; }
now_iso8601() { date -u +%Y-%m-%dT%H:%M:%SZ; }
is_stdin_tty() { [ -t 0 ]; }

random_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then lower "$(uuidgen)"; return 0; fi
  if command -v openssl >/dev/null 2>&1; then
    local h; h="$(openssl rand -hex 16)"
    printf '%s-%s-%s-%s-%s\n' "${h:0:8}" "${h:8:4}" "${h:12:4}" "${h:16:4}" "${h:20:12}"
    return 0
  fi
  return 1
}

# 32-character alphanumeric password (Geotab service accounts need no symbols).
generate_password() {
  local raw=""
  if command -v openssl >/dev/null 2>&1; then
    raw="$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9')"
  fi
  if [ "${#raw}" -lt 32 ] && command -v node >/dev/null 2>&1; then
    raw="$(node -e 'process.stdout.write(require("crypto").randomBytes(64).toString("base64").replace(/[^A-Za-z0-9]/g,""))')"
  fi
  [ "${#raw}" -ge 32 ] || return 1
  printf '%s' "${raw:0:32}"
}

# ---------------------------------------------------------------------------
# Selftest harness (used by every script's --selftest, pure helpers only)
# ---------------------------------------------------------------------------
SELFTEST_FAILURES=0
st_pass() { printf '%s %s\n' "${C_GREEN}PASS${C_RESET}" "$1"; }
st_fail() { printf '%s %s\n' "${C_RED}FAIL${C_RESET}" "$1"; SELFTEST_FAILURES=$((SELFTEST_FAILURES + 1)); }
st_eq() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then st_pass "$1"; else st_fail "$1 (expected '$2', got '$3')"; fi
}
st_true() { # <label> <command...>
  local label="$1"; shift
  if "$@"; then st_pass "$label"; else st_fail "$label (expected success: $*)"; fi
}
st_false() { # <label> <command...>
  local label="$1"; shift
  if "$@"; then st_fail "$label (expected failure: $*)"; else st_pass "$label"; fi
}
st_false_quiet() { # <label> <command...> — hides the expected error output
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then st_fail "$label (expected failure: $*)"; else st_pass "$label"; fi
}
st_done() { # <script label>
  if [ "$SELFTEST_FAILURES" -eq 0 ]; then
    printf '%s\n' "${C_GREEN}$1: all self-tests passed${C_RESET}"
    exit 0
  fi
  printf '%s\n' "${C_RED}$1: $SELFTEST_FAILURES self-test(s) failed${C_RESET}" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Dependency preflight
# ---------------------------------------------------------------------------
command_fix() {
  case "${1:-}" in
    aws)  printf 'install the AWS CLI v2 (https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) or "brew install awscli", then run "aws configure"' ;;
    tofu) printf 'install OpenTofu >= 1.10 (https://opentofu.org/docs/intro/install/, or "brew install opentofu")' ;;
    jq)   printf 'install jq ("brew install jq")' ;;
    zip)  printf 'install Info-ZIP ("brew install zip")' ;;
    curl) printf 'install curl ("brew install curl")' ;;
    openssl) printf 'install openssl ("brew install openssl") or make sure node is on PATH' ;;
    node) printf 'install Node.js 22+ (https://nodejs.org)' ;;
    *)    printf 'install %s' "${1:-<tool>}" ;;
  esac
}
require_command() { # <tool> [<tool>...]
  local tool
  for tool in "$@"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      die_fix "required command '$tool' is not installed or not on PATH" "$(command_fix "$tool")"
    fi
  done
}
require_openssl_or_node() {
  if ! command -v openssl >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
    die_fix "no random source available to generate a password" "$(command_fix openssl)"
  fi
}

# version_ge <a> <b> -> 0 when a >= b
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    n = split(a, x, "."); split(b, y, ".")
    for (i = 1; i <= 3; i++) {
      xi = (x[i] + 0); yi = (y[i] + 0)
      if (xi > yi) exit 0
      if (xi < yi) exit 1
    }
    exit 0
  }'
}

require_tofu_1_10() {
  require_command tofu
  local json version=""
  json="$(tofu version -json 2>/dev/null || true)"
  if [ -n "$json" ]; then
    version="$(printf '%s' "$json" | jq -r '.terraform_version // empty' 2>/dev/null || true)"
  fi
  if [ -z "$version" ]; then
    version="$(tofu version 2>/dev/null | awk 'NR==1 { print $2 }' | tr -d 'v')"
  fi
  [ -n "$version" ] || die_fix "could not read the OpenTofu version ('tofu version' produced no output)" "run \"tofu version\" yourself and reinstall OpenTofu from https://opentofu.org/docs/intro/install/"
  if ! version_ge "$version" "1.10"; then
    die_fix "OpenTofu $version is too old: this project needs >= 1.10 for S3-native state locking (use_lockfile)" "upgrade OpenTofu, e.g. \"brew upgrade opentofu\" (https://opentofu.org/docs/intro/install/)"
  fi
  TOFU_VERSION="$version"
}

# ---------------------------------------------------------------------------
# Region / deployment mapping (brief §3 + frozen contract)
#
#   code | AWS region   | deployment        | state bucket              | config bucket
#   ca   | ca-central-1 | advone-ca-central | advone-ca-central-deploy  | advone-ca-central-config
#   us   | us-east-2    | advone-east-2     | advone-east-2-deploy      | advone-east-2-config
# ---------------------------------------------------------------------------
region_code_from_arg() { # <raw> -> ca|us, non-zero when unknown
  case "${1:-}" in
    ca|CA|Ca|canada|Canada|ca-central-1) printf 'ca\n' ;;
    us|US|Us|usa|USA|united-states|us-east-2) printf 'us\n' ;;
    *) return 1 ;;
  esac
}

region_field() { # <code> <field> -> value; field: region|country|deployment|state|config|tz|addin
  case "${1:-}:${2:-}" in
    ca:region)     printf 'ca-central-1\n' ;;
    ca:country)    printf 'Canada\n' ;;
    ca:deployment) printf 'advone-ca-central\n' ;;
    ca:state)      printf 'advone-ca-central-deploy\n' ;;
    ca:config)     printf 'advone-ca-central-config\n' ;;
    ca:tz)         printf 'America/Toronto\n' ;;
    ca:addin)      printf 'advone-addin-hosting-ca-central-1\n' ;;
    us:region)     printf 'us-east-2\n' ;;
    us:country)    printf 'United States\n' ;;
    us:deployment) printf 'advone-east-2\n' ;;
    us:state)      printf 'advone-east-2-deploy\n' ;;
    us:config)     printf 'advone-east-2-config\n' ;;
    us:tz)         printf 'America/New_York\n' ;;
    us:addin)      printf 'advone-addinhosting-us-east-2\n' ;;
    *) return 1 ;;
  esac
}

# Backend config lives at infra/backend/<code>.hcl (brief §7 Step 8). The path is
# absolute so it stays valid under `tofu -chdir=<root>`.
backend_hcl_path() { # <code>
  printf '%s\n' "$REPO_ROOT/infra/backend/$1.hcl"
}

prompt_region_code() { # prints ca|us on stdout; 1 = no tty, 2 = bad answer
  is_stdin_tty || return 1
  printf '\nWhich deployment?\n  1) Canada        (ca-central-1, advone-ca-central)\n  2) United States (us-east-2,    advone-east-2)\n' >&2
  printf 'Select [1/2]: ' >&2
  local answer=""
  IFS= read -r answer || return 1
  case "$(lower "$(trim "$answer")")" in
    1|ca|canada|ca-central-1) printf 'ca\n' ;;
    2|us|usa|united-states|us-east-2) printf 'us\n' ;;
    *) return 2 ;;
  esac
}

# select_region <raw arg|""> — exports the whole deployment contract as globals.
select_region() {
  local raw="${1:-}" code
  if [ -n "$raw" ]; then
    code="$(region_code_from_arg "$raw")" || die_fix "unknown --region '$raw'" "pass --region ca (Canada) or --region us (United States)"
  else
    code="$(prompt_region_code)" || die_fix "no --region given and no terminal to ask on" "pass --region ca or --region us"
  fi

  REGION_CODE="$code"
  AWS_REGION="$(region_field "$code" region)"
  REGION_COUNTRY="$(region_field "$code" country)"
  DEPLOYMENT_NAME="$(region_field "$code" deployment)"
  STATE_BUCKET="$(region_field "$code" state)"
  CONFIG_BUCKET="$(region_field "$code" config)"
  DEFAULT_TIMEZONE="$(region_field "$code" tz)"
  TF_DIR="$REPO_ROOT/infra/live/$code"
  BACKEND_HCL="$(backend_hcl_path "$code")"
  export REGION_CODE AWS_REGION REGION_COUNTRY DEPLOYMENT_NAME STATE_BUCKET CONFIG_BUCKET \
         DEFAULT_TIMEZONE TF_DIR BACKEND_HCL CONFIG_KEY SCHEDULE_GROUP_PREFIX STATE_KEY \
         SERVICE_SLUG LEGACY_STATE_KEY DEPLOYMENT_MARKER_KEY
}

# ---------------------------------------------------------------------------
# Prompts (stdin, so piped input works; required prompts die on EOF)
# ---------------------------------------------------------------------------
prompt_line() { # <label> [default] -> value on stdout
  local label="$1" def="${2:-}" answer
  if [ -n "$def" ]; then printf '%s [%s]: ' "$label" "$def" >&2; else printf '%s: ' "$label" >&2; fi
  IFS= read -r answer || answer=""
  answer="$(trim "$answer")"
  if [ -z "$answer" ]; then printf '%s' "$def"; else printf '%s' "$answer"; fi
}

prompt_required() { # <label> -> non-empty value on stdout
  local label="$1" answer
  while :; do
    printf '%s: ' "$label" >&2
    if ! IFS= read -r answer; then
      die_fix "input ended before '$label' was provided" "run the script interactively, or pipe a value for every prompt"
    fi
    answer="$(trim "$answer")"
    [ -n "$answer" ] && { printf '%s' "$answer"; return 0; }
    warn "'$label' cannot be empty — try again."
  done
}

prompt_yes_no() { # <question> [y|n] -> 0 yes / 1 no
  local q="$1" def="${2:-n}" answer
  case "$def" in y*) printf '%s [Y/n]: ' "$q" >&2 ;; *) printf '%s [y/N]: ' "$q" >&2 ;; esac
  IFS= read -r answer || answer=""
  answer="$(lower "$(trim "$answer")")"
  [ -n "$answer" ] || answer="$def"
  case "$answer" in y|yes|1|true) return 0 ;; *) return 1 ;; esac
}

prompt_typed() { # <instruction> <expected-literal> -> 0 when typed exactly
  local instruction="$1" expected="$2" answer
  printf '%s\n' "$instruction" >&2
  printf 'type "%s" to continue: ' "$expected" >&2
  IFS= read -r answer || answer=""
  printf '\n' >&2
  [ "$answer" = "$expected" ]
}

# read_password_interactive — echoes the chosen password on stdout, never logs
# it. Typing "g" (or pressing enter) generates a 32-character password and sets
# GENERATED_PASSWORD=1 so the caller can show it exactly once.
GENERATED_PASSWORD=0
read_password_interactive() { # [min-length]
  local min="${1:-16}" attempt=0 p1 p2
  require_openssl_or_node
  while [ "$attempt" -lt 3 ]; do
    attempt=$((attempt + 1))
    printf 'Password (min %s chars, hidden; type "g" to generate a 32-char one): ' "$min" >&2
    if ! IFS= read -rs p1; then printf '\n' >&2; die_fix "input ended before a password was provided" "run the script interactively, or pipe a password on stdin"; fi
    printf '\n' >&2
    p1="$(trim "$p1")"
    case "$(lower "$p1")" in
      ""|g|generate)
        local generated=""
        generated="$(generate_password)" || die_fix "could not generate a password" "$(command_fix openssl)"
        GENERATED_PASSWORD=1
        printf '%s' "$generated"
        return 0
        ;;
    esac
    if [ "${#p1}" -lt "$min" ]; then
      warn "the password must be at least $min characters (you entered ${#p1}) — try again."
      continue
    fi
    printf 'Confirm password: ' >&2
    if ! IFS= read -rs p2; then printf '\n' >&2; die_fix "input ended before the password was confirmed" "provide the password twice when piping input"; fi
    printf '\n' >&2
    if [ "$p1" != "$p2" ]; then
      warn "the two passwords did not match — try again."
      continue
    fi
    GENERATED_PASSWORD=0
    printf '%s' "$p1"
    return 0
  done
  die_fix "no usable password after 3 attempts" "use at least $min characters, or type 'g' to have one generated"
}

# ---------------------------------------------------------------------------
# Naming + input validation (brief §5.5)
# ---------------------------------------------------------------------------
valid_database_name() {
  local db="${1:-}"
  [ -n "$db" ] && [ "${#db}" -le 64 ] && printf '%s' "$db" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*$'
}

valid_user_name() {
  local u="${1:-}"
  [ -n "$u" ] && [ "${#u}" -le 128 ] && printf '%s' "$u" | grep -Eq '^[^[:space:]]+$'
}

valid_timezone() {
  local tz="${1:-}"
  [ -n "$tz" ] || return 1
  case "$tz" in /*|*..*) return 1 ;; esac
  if [ -f "/usr/share/zoneinfo/$tz" ]; then return 0; fi
  if command -v node >/dev/null 2>&1; then
    node -e 'try { new Intl.DateTimeFormat("en-US", { timeZone: process.argv[1] }); } catch (e) { process.exit(1); }' "$tz" >/dev/null 2>&1 && return 0
  fi
  return 1
}

normalize_server() { # strip scheme and path
  local s
  s="$(trim "${1:-}")"
  s="${s#http://}"
  s="${s#https://}"
  s="${s%%/*}"
  printf '%s' "$s"
}

valid_server() {
  local s="${1:-}"
  [ -n "$s" ] && [ "${#s}" -le 253 ] && printf '%s' "$s" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' \
    && printf '%s' "$s" | grep -q '\.'
}

db_prefix() { # §5.5: lowercase, non-conforming -> "-", truncate to 40
  printf '%s' "${1:-}" | tr 'A-Z' 'a-z' | LC_ALL=C tr -c 'a-z0-9_.-' '-' | cut -c1-40
}

schedule_group_name() { # <database>
  local name="$SCHEDULE_GROUP_PREFIX-$(db_prefix "${1:-}")"
  if [ "${#name}" -gt 64 ] || printf '%s' "$name" | grep -Eqv '^[0-9a-zA-Z_.-]+$'; then
    return 1
  fi
  printf '%s' "$name"
}

# One secret per database, filed under this service's own prefix so it is never
# mistaken for another system's secret in the shared account:
#   unassign/<database>/serviceaccount
secret_name_for() { printf 'unassign/%s/serviceaccount\n' "${1:-}"; }

# ---------------------------------------------------------------------------
# Add-in hosting (pure; exercised by --selftest)
# ---------------------------------------------------------------------------
# The page customers' MyGeotab loads. One copy per deployment, filed under this
# service's prefix in the region's hosting bucket:
#   s3://<addin bucket>/unassign/unassignDrivers.html
addin_object_key() { printf 'unassign/unassignDrivers.html\n'; }

# The URL MyGeotab is pointed at. The S3 *website* endpoint answers over plain
# HTTP only, which an HTTPS MyGeotab page refuses to load, so this is the REST
# endpoint, kept readable by the bucket policy on /unassign/*.
addin_object_url() { # <bucket> <region> <key>
  printf 'https://%s.s3.%s.amazonaws.com/%s\n' "${1:-}" "${2:-}" "${3:-}"
}

# Lambda publishes its URL with a trailing slash; the add-in joins paths onto it
# ("/license"), so the slash has to go or every request is //license.
strip_trailing_slashes() { # <url>
  local url="${1:-}"
  while [ "${url%/}" != "$url" ]; do url="${url%/}"; done
  printf '%s\n' "$url"
}

# The published page has to name the deployment in the region it is served from,
# so the endpoint is stamped in at upload time rather than shipped in the repo.
# Prints the rendered HTML; 2 = bad input, 3 = the page has no endpoint to
# replace (both mean "do not upload this").
render_addin_html() { # <html file> <function url> -> HTML on stdout
  local src="${1:-}" url escaped rendered
  [ -f "$src" ] || return 2
  url="$(strip_trailing_slashes "${2:-}")"
  [ -n "$url" ] || return 2
  escaped="${url//\\/\\\\}"
  escaped="${escaped//&/\\&}"
  escaped="${escaped//|/\\|}"
  rendered="$(sed -E "s|var SERVER_API_BASE = \"[^\"]*\";|var SERVER_API_BASE = \"${escaped}\";|" "$src")" || return 2
  printf '%s\n' "$rendered" | grep -qF "var SERVER_API_BASE = \"${url}\";" || return 3
  printf '%s\n' "$rendered"
}

# The MyGeotab add-in configuration an operator pastes in, pointing at a
# published copy of the page (same name, service and version as the repo's).
addin_config_json() { # <config.json file> <add-in url> -> JSON on stdout
  local file="${1:-}" url="${2:-}"
  [ -f "$file" ] || return 2
  [ -n "$url" ] || return 2
  jq --arg url "$url" '.items[0].url = $url' "$file"
}

# ---------------------------------------------------------------------------
# Pure JSON assembly (no AWS calls; exercised by --selftest)
# ---------------------------------------------------------------------------
secret_payload_json() { # <database> <server> <userName> <password>
  jq -n --arg database "$1" --arg server "$2" --arg userName "$3" --arg password "$4" \
    '{database: $database, server: $server, userName: $userName, password: $password}'
}

# The record the onboarding script writes for a customer. Someone with AWS
# credentials onboarding a database is licensing it, so the license block is
# written here as licensed; the add-in's staff-only setup panel does the same
# with source "addin-panel".
customer_entry_json() { # <database> <server> <timeZone> <createdBy> <notes> [createdAt] [workerUserName]
  local db="$1" server="$2" tz="$3" createdBy="$4" notes="${5:-}" createdAt="${6:-}" worker="${7:-}"
  [ -n "$createdAt" ] || createdAt="$(now_iso8601)"
  jq -n --arg key "$db" --arg server "$server" --arg tz "$tz" --arg createdBy "$createdBy" \
        --arg notes "$notes" --arg createdAt "$createdAt" --arg worker "$worker" \
    '{key: $key,
      geotab: { database: $key, server: $server },
      secretName: ("unassign/" + $key + "/serviceaccount"),
      enabled: true,
      timeZone: $tz,
      workerUserName: $worker,
      license: { licensed: true, source: "onboard-script", updatedAt: $createdAt, updatedBy: $createdBy, notes: "" },
      createdAt: $createdAt,
      createdBy: $createdBy,
      notes: $notes}'
}

config_skeleton() { # <deploymentName> <region> <deploymentId>
  jq -n --arg name "$1" --arg region "$2" --arg id "$3" \
    '{schemaVersion: 1,
      deployment: { name: $name, region: $region, deploymentId: $id },
      defaults: { skipDriving: true, graceMinutes: 60 },
      customers: {}}'
}

# Canonical addIn block. Deep-merged (jq "*") under any existing block so an
# operator-captured securityId.id is never overwritten and "" stays "" until a
# human fills it in (brief §7 Step 0).
config_addin_defaults_json() {
  jq -n '{name: "Scheduled Driver Unassign by Advantage One",
          pageName: "Scheduled Driver Unassign",
          securityId: {id: "", name: "ViewSecurityId"},
          clearance: {requireIsAdd: true, allowEverythingGroup: true, ignoreCatalogGroup: true}}'
}

config_defaults_json() { jq -n '{skipDriving: true, graceMinutes: 60}'; }

# Shared jq prefix for every config write: keeps every existing top-level key and
# customer entry, fills only what the contract requires, and refuses to write a
# config that belongs to the other deployment or a future schema version.
config_merge_program() { # <jq tail lines>
  cat <<JQ
.schemaVersion = (.schemaVersion // 1)
| (if .schemaVersion != 1 then error("unsupported schemaVersion \(.schemaVersion) in this config: only 1 is understood") else . end)
| .deployment = ({name: \$name, region: \$region} * (.deployment // {}))
| (if .deployment.region != \$region
     then error("this config belongs to region \(.deployment.region), not \( \$region): re-run with --region for that deployment")
     else . end)
| (if (.deployment.deploymentId // "") == "" then .deployment.deploymentId = \$id else . end)
| .defaults = (\$defaults * (.defaults // {}))
| .addIn = (\$addin * (.addIn // {}))
| .customers = (.customers // {})
$1
JQ
}

merge_onboard_customer() { # <config-in> <config-out> <key> <entry-json-file>
  local in="$1" out="$2" key="$3" entry="$4" prog
  prog="$(config_merge_program '| ($entry[0]) as $e
| ($e + ((.customers[$key] // {}) | {createdAt: (.createdAt // $e.createdAt), createdBy: (.createdBy // $e.createdBy)})) as $merged
| .customers[$key] = $merged')"
  jq --arg name "$DEPLOYMENT_NAME" --arg region "$AWS_REGION" --arg id "$CONFIG_DEPLOYMENT_ID" \
     --arg key "$key" --argjson addin "$(config_addin_defaults_json)" --argjson defaults "$(config_defaults_json)" \
     --slurpfile entry "$entry" "$prog" "$in" > "$out"
}

merge_disable_customer() { # <config-in> <config-out> <key>
  local in="$1" out="$2" key="$3" prog
  prog="$(config_merge_program '| if (.customers[$key] // null) == null
     then error("customer \($key) is not in this config: nothing to disable")
     else .customers[$key].enabled = false end')"
  jq --arg name "$DEPLOYMENT_NAME" --arg region "$AWS_REGION" --arg id "$CONFIG_DEPLOYMENT_ID" \
     --arg key "$key" --argjson addin "$(config_addin_defaults_json)" --argjson defaults "$(config_defaults_json)" \
     "$prog" "$in" > "$out"
}

# ---------------------------------------------------------------------------
# AWS wrappers
# ---------------------------------------------------------------------------
AWS_LAST_ERR=""
# aws_try records the CLI's stderr here on failure. The path is fixed at source
# time (never assigned inside the call) so the error survives command
# substitution — which is how most call sites have to run aws_try.
AWS_ERR_FILE="${TMPDIR:-/tmp}/unassign-aws-err.$$"

# aws_last_err -> the stderr of the last failed aws_try (empty if none).
aws_last_err() {
  if [ -s "$AWS_ERR_FILE" ]; then cat "$AWS_ERR_FILE"; fi
}

aws_err_cleanup() { rm -f "$AWS_ERR_FILE"; }

aws_region_cli() { aws --region "$AWS_REGION" "$@"; }

# aws_try <args...> — stdout on success; on failure records the stderr (see
# aws_last_err) and returns the AWS CLI exit status.
aws_try() {
  local out err rc
  out="$(mktemp "${TMPDIR:-/tmp}/unassign-out.XXXXXX")"
  err="$(mktemp "${TMPDIR:-/tmp}/unassign-err.XXXXXX")"
  rc=0
  aws_region_cli "$@" >"$out" 2>"$err" || rc=$?
  AWS_LAST_ERR=""
  if [ "$rc" -ne 0 ]; then
    AWS_LAST_ERR="$(cat "$err")"
    printf '%s' "$AWS_LAST_ERR" > "$AWS_ERR_FILE"
    rm -f "$out" "$err"
    return "$rc"
  fi
  rm -f "$AWS_ERR_FILE"
  if [ -s "$err" ]; then cat "$err" >&2; fi
  cat "$out"
  rm -f "$out" "$err"
  return 0
}

aws_error_reason() { # <stderr text> -> one-line human explanation
  case "${1:-}" in
    *"Unable to locate credentials"*|*NoCredentialProviders*|*NoCredentials*) printf 'no AWS credentials are configured' ;;
    *ExpiredToken*|*"security token included in the request is expired"*|*"The SSO session"*|*InvalidClientTokenId*)
      printf 'the AWS credentials are missing or expired' ;;
    *AccessDenied*|*"not authorized to perform"*) printf 'the AWS principal is not authorized for this call' ;;
    *NoSuchBucket*|*"The specified bucket does not exist"*) printf 'the bucket does not exist' ;;
    *NoSuchKey*|*"The specified key does not exist"*) printf 'the config object does not exist' ;;
    *ResourceNotFoundException*) printf 'the resource does not exist' ;;
    *PreconditionFailed*|*"pre-conditions you specified"*|*"At least one of the pre-conditions"*)
      printf 'a conditional write was rejected because the object changed' ;;
    *"Could not connect to the endpoint URL"*|*EndpointConnectionError*) printf 'the AWS endpoint is unreachable' ;;
    *"Invalid region"*|*CouldNotConnect*) printf 'the region or endpoint is wrong' ;;
    *) printf 'AWS returned an error' ;;
  esac
}

aws_error_first_line() { # <stderr text>
  printf '%s\n' "${1:-}" | awk 'NF { print; exit }'
}

# --- S3 config object ------------------------------------------------------
S3_CONFIG_ETAG=""
S3_CONFIG_ERR=""
S3_GET_ETAG=""
S3_GET_ERR=""

# backend_hcl_key <file> -> the state key declared in an OpenTofu s3 backend config.
backend_hcl_key() {
  # -m1 rather than `| head -1`: head closing the pipe early would hand grep a
  # SIGPIPE, which `set -o pipefail` reports as a failed command substitution.
  grep -m1 -E '^[[:space:]]*key[[:space:]]*=' -- "$1" 2>/dev/null \
    | sed -E 's/^[^=]*=[[:space:]]*"([^"]*)".*$/\1/'
}

# probe_origin_from_pattern <pattern> -> a concrete Origin value for a CORS probe.
# Patterns are an internal convention (see probeOrigin in src/lambda/http.js) and
# are not valid Origin headers, so the first "*" becomes a label.
probe_origin_from_pattern() {
  case "${1:-}" in
    "" | "*") printf '%s' "https://my.geotab.com" ;;
    *) printf '%s' "${1/\*/my}" ;;
  esac
}

# filter_our_state_keys: stdin = object keys, stdout = this service's tfstate
# keys. Other services share the deploy bucket, so their state must never be
# counted as ours (and vice versa).
filter_our_state_keys() {
  grep -F -- "$SERVICE_SLUG/" | grep -E '\.tfstate$' || true
}

# s3_object_exists <bucket> <key> -> exit 0 when the object is there.
s3_object_exists() {
  aws_try s3api head-object --bucket "$1" --key "$2" >/dev/null 2>&1
}

# s3_get_object <bucket> <key> <outfile> -> 0 ok (sets S3_GET_ETAG), 1 absent, 2 error
s3_get_object() {
  local bucket="$1" key="$2" out="$3" meta err rc
  meta="$(mktemp "${TMPDIR:-/tmp}/unassign-meta.XXXXXX")"
  err="$(mktemp "${TMPDIR:-/tmp}/unassign-err.XXXXXX")"
  S3_GET_ETAG=""; S3_GET_ERR=""
  rc=0
  aws_region_cli s3api get-object --bucket "$bucket" --key "$key" "$out" >"$meta" 2>"$err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    S3_GET_ERR="$(cat "$err")"
    rm -f "$meta" "$err" "$out"
    case "$S3_GET_ERR" in
      *NoSuchKey*|*"The specified key does not exist"*) return 1 ;;
      *) return 2 ;;
    esac
  fi
  S3_GET_ETAG="$(jq -r '.ETag // empty' "$meta" 2>/dev/null || true)"
  rm -f "$meta" "$err"
  if [ -z "$S3_GET_ETAG" ]; then
    S3_GET_ERR="could not read the ETag from the get-object response"
    return 2
  fi
  return 0
}

# s3_config_get <bucket> <outfile> -> 0 ok (sets S3_CONFIG_ETAG), 1 absent, 2 error
s3_config_get() {
  local rc
  rc=0
  s3_get_object "$1" "$CONFIG_KEY" "$2" || rc=$?
  S3_CONFIG_ETAG="$S3_GET_ETAG"
  S3_CONFIG_ERR="$S3_GET_ERR"
  return "$rc"
}

# s3_config_put <bucket> <file> <etag|-> -> 0 ok, 1 precondition failed, 2 error
s3_config_put() {
  local bucket="$1" file="$2" etag="$3" err rc
  local args=(s3api put-object --bucket "$bucket" --key "$CONFIG_KEY" --body "$file" --content-type application/json)
  if [ "$etag" = "-" ]; then
    args+=(--if-none-match '*')
  else
    args+=(--if-match "$etag")
  fi
  err="$(mktemp "${TMPDIR:-/tmp}/unassign-err.XXXXXX")"
  S3_CONFIG_ERR=""
  rc=0
  aws_region_cli "${args[@]}" --output json >/dev/null 2>"$err" || rc=$?
  S3_CONFIG_ERR="$(cat "$err")"
  rm -f "$err"
  if [ "$rc" -ne 0 ]; then
    case "$S3_CONFIG_ERR" in
      *PreconditionFailed*|*"pre-conditions you specified"*|*"At least one of the pre-conditions"*) return 1 ;;
      *) return 2 ;;
    esac
  fi
  return 0
}

# read_deploy_marker <state-bucket> <outfile> -> 0 ok, 1 absent, 2 error (soft:
# callers that only want the deploymentId treat anything non-zero as "no marker").
read_deploy_marker() {
  local rc
  rc=0
  s3_get_object "$1" "$DEPLOYMENT_MARKER_KEY" "$2" || rc=$?
  MARKER_ETAG="$S3_GET_ETAG"
  MARKER_ERR="$S3_GET_ERR"
  return "$rc"
}

CONFIG_DEPLOYMENT_ID=""

# resolve_deployment_id <config-file|"">
#   deploymentId is owned by the deploy marker (scripts/deploy.sh writes it into
#   the state bucket at deployment.json). An id already present in the config
#   always wins, so a config written before the marker changed keeps its identity.
resolve_deployment_id() {
  local cfg="${1:-}" id="" marker rc
  if [ -n "$cfg" ] && [ -s "$cfg" ]; then
    id="$(jq -r '.deployment.deploymentId // empty' "$cfg" 2>/dev/null || true)"
  fi
  if [ -z "$id" ]; then
    marker="$(mktemp "${TMPDIR:-/tmp}/unassign-marker.XXXXXX")"
    rc=0
    read_deploy_marker "$STATE_BUCKET" "$marker" || rc=$?
    if [ "$rc" -eq 0 ]; then
      id="$(jq -r '.deploymentId // empty' "$marker" 2>/dev/null || true)"
    fi
    rm -f "$marker"
  fi
  if [ -z "$id" ]; then
    id="$(random_uuid)" || id="deployment-$(date -u +%Y%m%d%H%M%S)"
    if [ -n "$cfg" ]; then
      warn "no deploymentId found in the config or the deployment marker — using a generated one ($id)"
    fi
  fi
  printf '%s' "$id"
}

# config_update <bucket> <merge-fn> [merge args...]
#   Read-modify-write of config/customers.json with If-Match on the ETag and a
#   retry when another operator wins the race. A missing object is created with
#   If-None-Match: * so a concurrent first writer cannot be clobbered either.
config_update() {
  local bucket="$1" fn="$2"; shift 2
  local attempt=1 max=5 in out rc etag jqerr detail
  while [ "$attempt" -le "$max" ]; do
    in="$(mktemp "${TMPDIR:-/tmp}/unassign-config.XXXXXX")"
    out="$(mktemp "${TMPDIR:-/tmp}/unassign-config-out.XXXXXX")"
    jqerr="$(mktemp "${TMPDIR:-/tmp}/unassign-jq.XXXXXX")"
    etag="-"

    rc=0
    s3_config_get "$bucket" "$in" || rc=$?
    if [ "$rc" -eq 0 ]; then
      etag="$S3_CONFIG_ETAG"
      CONFIG_DEPLOYMENT_ID="$(resolve_deployment_id "$in")"
    elif [ "$rc" -eq 1 ]; then
      info "s3://$bucket/$CONFIG_KEY is absent — creating it"
      CONFIG_DEPLOYMENT_ID="$(resolve_deployment_id "")"
      config_skeleton "$DEPLOYMENT_NAME" "$AWS_REGION" "$CONFIG_DEPLOYMENT_ID" > "$in"
    else
      rm -f "$in" "$out" "$jqerr"
      s3_config_die "$bucket"
    fi

    rc=0
    "$fn" "$in" "$out" "$@" 2>"$jqerr" || rc=$?
    if [ "$rc" -ne 0 ]; then
      detail="$(aws_error_first_line "$(cat "$jqerr")")"
      rm -f "$in" "$out" "$jqerr"
      die_fix "refusing to write $CONFIG_KEY: ${detail:-the new config could not be assembled}" \
              "fix s3://$bucket/$CONFIG_KEY (or re-run with the --region that owns that bucket) and try again"
    fi
    rm -f "$jqerr"

    rc=0
    s3_config_put "$bucket" "$out" "$etag" || rc=$?
    rm -f "$in" "$out"
    case "$rc" in
      0) return 0 ;;
      1)
        if [ "$attempt" -eq "$max" ]; then
          die_fix "the config object in s3://$bucket/$CONFIG_KEY kept changing under us ($max attempts)" "another operator is writing the same object: wait a moment and re-run"
        fi
        warn "$CONFIG_KEY changed between read and write (HTTP 412) — re-reading and retrying (attempt $((attempt + 1))/$max)"
        attempt=$((attempt + 1))
        ;;
      *) s3_config_die "$bucket" ;;
    esac
  done
}

s3_config_die() { # <bucket>
  local bucket="$1" reason
  reason="$(aws_error_reason "$S3_CONFIG_ERR")"
  case "$reason" in
    "the bucket does not exist")
      die_fix "the config bucket $bucket does not exist" "deploy this region first: scripts/deploy.sh --region $REGION_CODE"
      ;;
    "the config object does not exist")
      die_fix "s3://$bucket/$CONFIG_KEY does not exist" "run scripts/deploy.sh --region $REGION_CODE to seed it, then retry"
      ;;
    "no AWS credentials are configured"|"the AWS credentials are missing or expired")
      die_fix "$reason" "run \"aws configure\" (or \"aws sso login\") and confirm AWS_REGION=$AWS_REGION, then retry"
      ;;
    "the AWS principal is not authorized for this call")
      die_fix "your AWS principal cannot read/write s3://$bucket/$CONFIG_KEY" "ask for s3:GetObject + s3:PutObject on arn:aws:s3:::$bucket/config/*"
      ;;
    *)
      die_fix "$reason while accessing s3://$bucket/$CONFIG_KEY" "raw error: $(aws_error_first_line "$S3_CONFIG_ERR")"
      ;;
  esac
}

# --- Secrets Manager ------------------------------------------------------
# write_secret <secret-name> <payload-json-file>
write_secret() {
  local name="$1" file="$2" rc
  rc=0
  aws_try secretsmanager describe-secret --secret-id "$name" >/dev/null || rc=$?
  if [ "$rc" -eq 0 ]; then
    info "updating existing secret $name"
    rc=0
    aws_try secretsmanager update-secret --secret-id "$name" --secret-string "file://$file" >/dev/null || rc=$?
  else
    info "creating secret $name"
    rc=0
    aws_try secretsmanager create-secret --name "$name" --secret-string "file://$file" --description "Geotab service account for the unassign service" >/dev/null || rc=$?
    if [ "$rc" -ne 0 ]; then
      case "$(aws_last_err)" in
        *ResourceExistsException*)
          info "secret $name appeared concurrently — updating it instead"
          rc=0
          aws_try secretsmanager update-secret --secret-id "$name" --secret-string "file://$file" >/dev/null || rc=$?
          ;;
      esac
    fi
  fi
  if [ "$rc" -ne 0 ]; then
    local reason
    reason="$(aws_error_reason "$(aws_last_err)")"
    case "$reason" in
      "no AWS credentials are configured"|"the AWS credentials are missing or expired")
        die_fix "$reason" "run \"aws configure\" (or \"aws sso login\") and retry" ;;
      "the AWS principal is not authorized for this call")
        die_fix "your AWS principal cannot write the secret $name" "ask for secretsmanager:CreateSecret + UpdateSecret + DescribeSecret on arn:aws:secretsmanager:$AWS_REGION:*:secret:$name-*" ;;
      *)
        die_fix "$reason while writing the secret $name" "raw error: $(aws_error_first_line "$(aws_last_err)")" ;;
    esac
  fi
  return 0
}