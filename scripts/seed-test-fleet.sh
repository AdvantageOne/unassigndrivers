#!/usr/bin/env bash
#
# scripts/seed-test-fleet.sh — put a test fleet into a MyGeotab database and
# assign its drivers to its assets, so the scheduled unassign has something to
# clear.
#
# It is a *test fixture* tool: everything it creates is named with one batch id
# (A1SEED-<UTC stamp>-…), it writes only to the database whose name you type
# back at the prompt, and `--cleanup` removes that batch again.
#
# MyGeotab has no "assign this driver to this asset" endpoint: an assignment is
# a DriverChange record, which is exactly what the scheduling service writes
# (with driver UnknownDriverId) when it clears a fleet. This script writes the
# other direction — driver = the person — so a seeded fleet looks like a real
# one to the service's own reads.
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="scripts/seed-test-fleet.sh"
# shellcheck source=scripts/lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

DATABASE=""
USER_NAME=""
PASSWORD=""
SERVER="my.geotab.com"
API_BASE=""
COUNT=10
DRY_RUN=0
CLEANUP=0
SELFTEST=0

SEED_PREFIX_BASE="A1SEED"
ADMIN_GROUP_ID="GroupEverythingSecurityId"
# MyGeotab's built-in root group, the same id src/core/unassign-core.js uses for
# its AddInData writes. A driver or an asset has to belong to a group: a bare
# `Add User` is refused with "-32000: User's CompanyGroups cannot be null or
# empty", so every record this script creates is put in the Company group. A
# driver additionally needs a security *clearance* ("-32000: User's
# SecurityGroups cannot be null or empty").
COMPANY_GROUP_ID="GroupCompanyId"
# MyGeotab files a new asset in its built-in Vehicle group (its own add-asset
# request does), which is also the group a schedule is likely scoped to. Checked
# against the database before use, falling back to the company group.
ASSET_GROUP_ID="GroupVehicleId"
# The built-in clearances are named Group<Role>SecurityId (this repo already
# relies on GroupEverythingSecurityId), so a Driver one is found by shape, not by
# a name that is translated. When a database does not expose one, the clearance
# the script's own account carries is used: it is valid by construction, and the
# seeded drivers have no password, so nobody can sign in as them.
DRIVER_SECURITY_GROUP_PATTERN="^Group[A-Za-z]*Driver[A-Za-z]*SecurityId$"
SECURITY_GROUP_ID=""
SECURITY_GROUP_SOURCE=""
CALLER_SECURITY_GROUP_IDS=""
COMPANY_GROUP_NAME=""
ASSET_GROUP_NAME=""
SEED_GROUPS="[]"

usage() {
  cat <<'USAGE'
scripts/seed-test-fleet.sh — seed a test fleet and assign it, in one MyGeotab
database, to check that scheduled unassign clears real assignments.

Usage:
  scripts/seed-test-fleet.sh [--database DB] [--user USER] [--server HOST]
                             [--count N] [--dry-run]
  scripts/seed-test-fleet.sh --cleanup        # remove a seeded batch again

Options:
  --database DB    MyGeotab database to write to. Asked for when omitted.
  --user USER      A MyGeotab user with Administrator clearance (adding users,
                   assets and assignments needs it). Asked for when omitted.
  --server HOST    MyGeotab server (default my.geotab.com; regional servers like
                   myg.geotab.com or a US server work the same way).
  --count N        Drivers and assets to create (default 10; same number each).
  --security-group ID
                   Security clearance for the seeded drivers. Discovered from
                   the database by default (its built-in Driver group), falling
                   back to an account-level one; pass an id to be explicit.
  --dry-run        Sign in, print what would be created, write nothing.
  --cleanup        Remove every record this script created in a previous run
                   (names starting A1SEED-). The database name must be typed
                   back to confirm.
  --api-base URL   Override the JSON-RPC endpoint (default https://<server>/apiv1).
                   For pointing at a mock in tests, not for normal use.
  --selftest       Run the offline self-tests for the script's pure helpers.
  --help, -h       Show this text.

The password is read from the terminal with echo off, or from standard input
when this script is not interactive; it is never passed as an argument and
never written to a file or a log.

What it creates (all names carry one batch id):
  <N> drivers   Add User   { isDriver: true, name: A1SEED-<stamp>-Driver-NN }
  <N> assets    Add Device { name: A1SEED-<stamp>-Asset-NN, serialNumber: "",
                            groups: [Vehicle], activeFrom/activeTo }
                (blank serial number, as MyGeotab's own add-asset sends: it
                validates serial numbers and refused an invented one)
  <N> assignments  Add DriverChange { device, driver, dateTime, type: "Driver" }

Then it reads the assignments back the way the service does (a DriverChange
search per asset, latest change wins) and reports how many landed.

Examples:
  scripts/seed-test-fleet.sh --database advone_matt_dev1 --user matt@example.com
  scripts/seed-test-fleet.sh --database advone_matt_dev1 --user matt@example.com --dry-run
  scripts/seed-test-fleet.sh --database advone_matt_dev1 --user matt@example.com --cleanup
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --database)   [ "$#" -ge 2 ] || die_fix "--database needs a value" "pass --database <name>"; DATABASE="$2"; shift 2 ;;
    --database=*) DATABASE="${1#--database=}"; shift ;;
    --user)       [ "$#" -ge 2 ] || die_fix "--user needs a value" "pass --user <mygeotab user name>"; USER_NAME="$2"; shift 2 ;;
    --user=*)     USER_NAME="${1#--user=}"; shift ;;
    --server)     [ "$#" -ge 2 ] || die_fix "--server needs a value" "pass --server my.geotab.com"; SERVER="$2"; shift 2 ;;
    --server=*)   SERVER="${1#--server=}"; shift ;;
    --count)      [ "$#" -ge 2 ] || die_fix "--count needs a value" "pass --count 10"; COUNT="$2"; shift 2 ;;
    --count=*)    COUNT="${1#--count=}"; shift ;;
    --api-base)   [ "$#" -ge 2 ] || die_fix "--api-base needs a value" "pass --api-base https://host/apiv1"; API_BASE="$2"; shift 2 ;;
    --api-base=*) API_BASE="${1#--api-base=}"; shift ;;
    --security-group)   [ "$#" -ge 2 ] || die_fix "--security-group needs a value" "pass --security-group <group id>"; SECURITY_GROUP_ID="$2"; shift 2 ;;
    --security-group=*) SECURITY_GROUP_ID="${1#--security-group=}"; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --cleanup)    CLEANUP=1; shift ;;
    --selftest)   SELFTEST=1; shift ;;
    --help|-h)    usage; exit 0 ;;
    *) die_fix "unknown argument: $1" "run $SCRIPT_NAME --help" ;;
  esac
done

# ---------------------------------------------------------------------------
# Pure helpers (exercised by --selftest)
# ---------------------------------------------------------------------------

# One name for the whole batch, so a run is identifiable and removable.
seed_batch_id() { # <iso8601 utc> -> A1SEED-20261016T133045Z
  local iso="${1:-}" compact
  compact="$(printf '%s' "$iso" | sed -E 's/\.[0-9]+//; s/Z$//; s/[-:]//g')"
  printf '%s-%sZ\n' "$SEED_PREFIX_BASE" "$compact"
}

seed_name() { # <batch> <Kind> <index> -> A1SEED-…-Driver-03
  local batch="${1:-}" kind="${2:-}" index="${3:-0}"
  printf '%s-%s-%02d\n' "$batch" "$kind" "$((10#$index))"
}

# How many non-empty lines a captured list has (grep -c exits 1 on no match).
seed_count() { # <text>
  printf '%s\n' "${1:-}" | grep -c . || true
}

# A driver needs a password ("-32000: Value cannot be null. (Parameter
# 'Password')") that satisfies the database's policy, which may require a symbol.
# Built to satisfy any such policy by construction — 29 random alphanumerics from
# the repo's own generator plus one of each class — rather than drawing from a
# mixed alphabet and hoping: with a mixed alphabet a symbol lands about 2% of the
# time, which failed one run in sixteen.
# One password per driver, never printed and never logged: nobody signs in as
# these records, and an admin can reset one if that ever changes.
seed_password() {
  local base symbols symbol
  base="$(generate_password)" || return 1 # 32 alphanumerics, openssl or node
  [ "${#base}" -ge 32 ] || return 1
  # Which symbol is not the secret here: the strength is in `base`.
  symbols='!@#%^*_+=?-'
  symbol="${symbols:$((RANDOM % ${#symbols})):1}"
  printf '%s%saA1\n' "${base:0:29}" "$symbol"
}

# Does the database actually have this group? Never send an id that was guessed:
# MyGeotab rejects the whole Add.
seed_group_exists() { # <groups json> <id>
  local groups="${1:-}" id="${2:-}"
  [ -n "$id" ] || return 1
  printf '%s' "$groups" | jq -e --arg id "$id" 'any(.[]; .id == $id)' >/dev/null 2>&1
}

seed_group_name() { # <groups json> <id>
  printf '%s' "${1:-}" | jq -r --arg id "${2:-}" '[.[] | select(.id == $id) | .name] | first // empty'
}

# For the error message when an id is not in the database: show what is.
# (Joined in jq: `paste -d', '` cycles its delimiter list, so it would alternate
# between a comma and a space.)
seed_group_list() { # <groups json>
  printf '%s' "${1:-}" | jq -r '[.[] | "\(.id) (\(.name))"] | join(", ")' 2>/dev/null || true
}

# Every clearance id this database has shown us: the security groups Get Group
# happens to expose, plus the ones the script's own account carries. Nothing else
# is a safe source — an id MyGeotab does not know refuses the whole Add.
seed_known_clearance_ids() { # <groups json> <caller's ids, newline>
  { printf '%s' "${1:-}" | jq -r --arg pattern "$DRIVER_SECURITY_GROUP_PATTERN" \
      '.[] | select((.id // "") | test("^Group[A-Za-z]*SecurityId$")) | .id' 2>/dev/null
    printf '%s\n' "${2:-}"
  } | grep . | sort -u
}

# Where an asset is filed: MyGeotab's own add-asset request uses its built-in
# Vehicle group, but a database without that group still needs somewhere.
seed_asset_group_id() { # <groups json>
  if seed_group_exists "${1:-}" "$ASSET_GROUP_ID"; then
    printf '%s\n' "$ASSET_GROUP_ID"
  else
    printf '%s\n' "$COMPANY_GROUP_ID"
  fi
}

# Which clearance the seeded drivers get, and where it came from:
#   <requested>            the operator's --security-group, if the database has it
#   a built-in Driver one  Get Group exposed it (the semantically right choice)
#   <caller id>            this script's own clearance, valid by construction
# 1 = nothing usable.
seed_choose_clearance() { # <requested> <known ids newline> <caller's first id>
  local requested="${1:-}" known="${2:-}" caller="${3:-}" driver
  if [ -n "$requested" ]; then
    if printf '%s\n' "$known" | grep -qx -- "$requested"; then
      printf '%s\t--security-group\n' "$requested"
    else
      # MyGeotab is the authority on its own clearances and does not list them
      # all: take the operator's id and let the Add be the judge, rather than
      # refusing something that may well be right.
      printf '%s\t--security-group (not one this database showed us)\n' "$requested"
    fi
    return 0
  fi
  driver="$(printf '%s\n' "$known" | grep -m1 -E "$DRIVER_SECURITY_GROUP_PATTERN" || true)"
  if [ -n "$driver" ]; then
    printf '%s\tthis database has a Driver clearance\n' "$driver"
    return 0
  fi
  [ -n "$caller" ] || return 1
  printf '%s\t%s\n' "$caller" "this script's own account"
}

# A driver is a User with isDriver set; only fields MyGeotab needs are sent, and
# both memberships are among them (a driver with neither cannot be created).
seed_user_json() { # <name> <index> <company group id> <security group id> <password>
  jq -n --arg name "${1:-}" --arg index "${2:-}" --arg company "${3:-}" --arg security "${4:-}" \
        --arg password "${5:-}" \
    '{name: $name, firstName: "Test", lastName: ("Driver " + $index), isDriver: true,
      companyGroups: [{id: $company}], securityGroups: [{id: $security}], password: $password}'
}

# The same for an asset, shaped like MyGeotab's own add-asset request (captured
# from the UI): a group, a blank serial number — MyGeotab validates serial
# numbers and refused an invented one, and blank is what the UI sends when the
# field is left empty — and the active window, so the asset is active now (the
# service only looks at assets active as of the run).
seed_device_json() { # <name> <group id> <active from iso8601>
  jq -n --arg name "${1:-}" --arg group "${2:-}" --arg activeFrom "${3:-}" \
    '{name: $name, serialNumber: "", groups: [{id: $group}],
      activeFrom: $activeFrom, activeTo: "2050-01-01T00:00:00.000Z"}'
}

# The assignment itself — the same entity the service writes to clear a fleet,
# with the driver instead of UnknownDriverId.
seed_driverchange_json() { # <device id> <driver id> <iso8601>
  jq -n --arg device "${1:-}" --arg driver "${2:-}" --arg dateTime "${3:-}" \
    '{device: {id: $device}, driver: {id: $driver}, dateTime: $dateTime, type: "Driver"}'
}

# How the service reads an asset's current assignment, for one device.
seed_driverchange_search_json() { # <device id> <from iso8601>
  jq -n --arg device "${1:-}" --arg from "${2:-}" \
    '{typeName: "DriverChange", search: {deviceSearch: {id: $device}, fromDate: $from, includeOverlappedChanges: true}}'
}

# The new id out of an Add's answer. MyGeotab answers [{id}] for a single Add and
# the bare id on some paths, so every shape is accepted rather than guessed at.
# The first id is picked inside jq on purpose: `… | head -1` races the writer,
# and a lost id would silently leave drivers unassigned.
rpc_first_id() { # <response or result json on stdin> -> the id, or nothing
  jq -r '
    def flat_ids:
      if type == "string" then .
      elif type == "object" then (.id // empty)
      elif type == "array" then (.[] | flat_ids)
      else empty end;
    # Either the JSON-RPC envelope ({result: …}) or the result itself.
    [ (if type == "object" then (.result // empty) else . end) | flat_ids ] | first // empty
  ' 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# MyGeotab JSON-RPC
# ---------------------------------------------------------------------------
CREDENTIALS=""

api_url() { # the endpoint, overridable for tests
  if [ -n "$API_BASE" ]; then printf '%s\n' "$API_BASE"; else printf 'https://%s/apiv1\n' "$SERVER"; fi
}

# The request body is piped in (`--data-binary @-`) rather than passed as an
# argument, so a password is never visible in the process list. curl's stderr
# goes to a private temp file (this process owns it: umask 077 above).
rpc() { # <method> <params json> -> response on stdout
  local method="${1:-}" params="${2:-}" url err response rc=0
  url="$(api_url)"
  err="$(mktemp "${TMPDIR:-/tmp}/a1seed-curl.XXXXXX")"
  response="$(jq -n --arg method "$method" --argjson params "$params" '{method: $method, params: $params}' \
    | curl -sS --max-time 60 -X POST "$url" -H 'Content-Type: application/json' --data-binary @- 2>"$err")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    local detail
    detail="$(head -c 200 "$err" 2>/dev/null || true)"
    rm -f "$err"
    die_fix "could not reach $url (curl exit $rc: $detail)" \
            "check the server name (--server $SERVER) and that this machine has internet access, then re-run — nothing was written"
  fi
  rm -f "$err"
  printf '%s' "$response"
}

rpc_result() { # <method> <params json> [<what, for the error message>] -> result on stdout
  local method="${1:-}" params="${2:-}" what="${3:-$1}" response code message
  response="$(rpc "$method" "$params")"
  if ! printf '%s' "$response" | jq -e . >/dev/null 2>&1; then
    die_fix "$(api_url) did not answer with JSON (first 200 bytes: $(printf '%s' "$response" | head -c 200))" \
            "confirm the server hostname for database $DATABASE and that MyGeotab is reachable, then re-run"
  fi
  code="$(printf '%s' "$response" | jq -r '.error.code // empty')"
  if [ -n "$code" ]; then
    message="$(printf '%s' "$response" | jq -r '.error.message // empty')"
    die_fix "MyGeotab refused $method for $what ($code: $message)" \
            "records written before this one stay in $DATABASE (re-run with --cleanup to remove them). Check the account's clearance and that the database name is right, then re-run"
  fi
  printf '%s' "$response" | jq -c '.result'
}

# One record per call, in the documented single-call shapes: ExecuteMultiCall
# accepts both [method, params] tuples and {method, params} objects depending on
# who you ask, and a seeding run of 30 calls does not need to bet on which.
# A refused write must stop the run, so the result is captured first and the id
# is pulled out of it afterwards: a single pipeline would hide the failure behind
# the id extractor's own (always successful) exit status.
add_one() { # <typeName> <entity json> <what> -> the new id
  local type="${1:-}" entity="${2:-}" what="${3:-$1}"
  local params result
  params="$(jq -n --argjson credentials "$CREDENTIALS" --arg typeName "$type" --argjson entity "$entity" \
    '{credentials: $credentials, typeName: $typeName, entity: $entity}')"
  result="$(rpc_result "Add" "$params" "$what")" || return 1
  local id
  id="$(printf '%s' "$result" | rpc_first_id)"
  if [ -z "$id" ]; then
    die_fix "MyGeotab accepted the Add for $what but returned no id" \
            "the record may exist without an assignment: re-run with --cleanup to remove the batch, then try again"
  fi
  printf '%s\n' "$id"
}

remove_one() { # <typeName> <id> <what>
  local type="${1:-}" id="${2:-}" what="${3:-$1}"
  local params
  params="$(jq -n --argjson credentials "$CREDENTIALS" --arg typeName "$type" --arg id "$id" \
    '{credentials: $credentials, typeName: $typeName, entity: {id: $id}}')"
  rpc_result "Remove" "$params" "$what" >/dev/null
}

get_all() { # <typeName> -> records
  local type="${1:-}" params
  params="$(jq -n --argjson credentials "$CREDENTIALS" --arg typeName "$type" '{credentials: $credentials, typeName: $typeName}')"
  rpc_result "Get" "$params" "$type records"
}

MYGEOTAB_IDENTITY=""

authenticate() {
  local params response code message credentials
  params="$(jq -n --arg database "$DATABASE" --arg userName "$USER_NAME" --arg password "$PASSWORD" \
    '{database: $database, userName: $userName, password: $password}')"
  response="$(rpc "Authenticate" "$params")"
  if ! printf '%s' "$response" | jq -e . >/dev/null 2>&1; then
    die_fix "$(api_url) did not answer with JSON" "confirm the server hostname and that MyGeotab is reachable, then re-run"
  fi
  code="$(printf '%s' "$response" | jq -r '.error.code // empty')"
  if [ -n "$code" ]; then
    message="$(printf '%s' "$response" | jq -r '.error.message // empty')"
    die_fix "MyGeotab refused the credentials for database '$DATABASE' as user '$USER_NAME' ($code: $message)" \
            "check the database name, the user name and the password (and that the account is not locked), then re-run — nothing was written"
  fi
  credentials="$(printf '%s' "$response" | jq -c '.result.credentials // empty')"
  if [ -z "$credentials" ] || [ "$credentials" = "null" ]; then
    die_fix "MyGeotab did not return a session for database '$DATABASE'" "confirm the database name, then re-run — nothing was written"
  fi
  CREDENTIALS="$credentials"

  # Who MyGeotab thinks we are, and whether that is enough for the writes. The
  # caller's own securityGroups matter twice over: they say what clearance this
  # account has, and they are a clearance id this database certainly has (Get
  # Group does not expose security groups — a live run returned only company
  # groups — so a user record is the reliable source).
  local me groups
  me="$(rpc_result "Get" "$(jq -n --argjson credentials "$CREDENTIALS" --arg name "$USER_NAME" \
        '{credentials: $credentials, typeName: "User", search: {name: $name}}')")"
  CALLER_SECURITY_GROUP_IDS="$(printf '%s' "$me" | jq -r '.[0].securityGroups[]?.id // empty')"
  groups="$(printf '%s\n' "$CALLER_SECURITY_GROUP_IDS" | paste -sd, -)"
  if printf '%s' "$groups" | grep -q "$ADMIN_GROUP_ID"; then
    MYGEOTAB_IDENTITY="Administrator clearance"
  else
    MYGEOTAB_IDENTITY="clearance ${groups:-unknown} (adding users and assets needs Administrator)"
  fi
}

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
gather_credentials() {
  while [ -z "$DATABASE" ]; do
    DATABASE="$(prompt_required "MyGeotab database to write to")"
  done
  while [ -z "$USER_NAME" ]; do
    USER_NAME="$(prompt_required "MyGeotab user name (needs Administrator clearance)")"
  done
  # The server has a working default and is shown in the confirmation block, so
  # it is only ever taken from --server (asking for it would just be a third
  # prompt between the password and the confirmation).
  SERVER="$(normalize_server "$SERVER")"
  valid_server "$SERVER" || die_fix "'$SERVER' does not look like a MyGeotab server" "use a hostname such as my.geotab.com"
  if [ -z "$PASSWORD" ]; then
    printf 'Password for %s (hidden): ' "$USER_NAME" >&2
    if ! IFS= read -rs PASSWORD; then printf '\n' >&2; die_fix "input ended before a password was provided" "run this script from a terminal"; fi
    printf '\n' >&2
  fi
  [ -n "$PASSWORD" ] || die_fix "no password provided" "run this script from a terminal, or pipe the password on stdin"
}

# The one gate between a typed script and a live fleet.
confirm_write() { # <action description> <what it creates>
  local action="$1" creates="$2"
  printf '\n' >&2
  printf '%s\n' "=====================================================================" >&2
  printf '%s\n' "  ${C_BOLD}LIVE MyGeotab WRITE${C_RESET}" >&2
  printf '%s\n' "  database    : ${C_BOLD}$DATABASE${C_RESET}" >&2
  printf '%s\n' "  server      : $SERVER" >&2
  printf '%s\n' "  signed in as: $USER_NAME ($MYGEOTAB_IDENTITY)" >&2
  printf '%s\n' "  action      : $action" >&2
  printf '%s\n' "  records     : $creates" >&2
  printf '%s\n' "  batch       : $BATCH (every record is named $BATCH-…)" >&2
  printf '%s\n' "=====================================================================" >&2
  if ! prompt_typed "This writes to the database named above. Any other database is untouched." "$DATABASE"; then
    die_fix "the database name typed back did not match '$DATABASE' — nothing was written" \
            "re-run $SCRIPT_NAME --database $DATABASE when you are sure, or use --dry-run to look first"
  fi
}

# ---------------------------------------------------------------------------
# Work
# ---------------------------------------------------------------------------
BATCH=""
SEED_FROM=""

build_batch() {
  BATCH="$(seed_batch_id "$(now_iso8601)")"
  # Assignments are stamped at minute precision, so they read as "just now" in
  # the past rather than possibly in the future for a service whose clock is a
  # second behind this machine.
  SEED_FROM="$(date -u +%Y-%m-%dT%H:%M:00.000Z)"
}

# Both memberships a driver needs come from the database itself, so nothing is
# guessed: the requested id (--security-group), else a built-in Driver clearance
# the database exposes, else the clearance this script's own account carries.
resolve_groups() {
  local known chosen caller
  SEED_GROUPS="$(get_all "Group")"
  caller="${CALLER_SECURITY_GROUP_IDS%%$'\n'*}"
  known="$(seed_known_clearance_ids "$SEED_GROUPS" "$CALLER_SECURITY_GROUP_IDS")"
  if ! seed_group_exists "$SEED_GROUPS" "$COMPANY_GROUP_ID"; then
    die_fix "$DATABASE has no group '$COMPANY_GROUP_ID', so a driver would be refused" \
            "this database's groups are: $(seed_group_list "$SEED_GROUPS")"
  fi
  if ! chosen="$(seed_choose_clearance "$SECURITY_GROUP_ID" "$known" "$caller")"; then
    die_fix "no clearance id in $DATABASE could be used for the seeded drivers" \
            "pass --security-group <id>; clearances seen in this database: $(printf '%s\n' "$known" | paste -sd, -)"
  fi
  SECURITY_GROUP_ID="$(printf '%s' "$chosen" | cut -f1)"
  SECURITY_GROUP_SOURCE="$(printf '%s' "$chosen" | cut -f2)"
  COMPANY_GROUP_NAME="$(seed_group_name "$SEED_GROUPS" "$COMPANY_GROUP_ID")"
  ASSET_GROUP_ID="$(seed_asset_group_id "$SEED_GROUPS")"
  ASSET_GROUP_NAME="$(seed_group_name "$SEED_GROUPS" "$ASSET_GROUP_ID")"
  ok "drivers get the clearance $SECURITY_GROUP_ID (from $SECURITY_GROUP_SOURCE)"
  info "drivers belong to the '$COMPANY_GROUP_NAME' group ($COMPANY_GROUP_ID)"
  info "assets belong to the '$ASSET_GROUP_NAME' group ($ASSET_GROUP_ID)"
}

# Every entity goes through the pure builders above, so what is sent is exactly
# what --selftest pins — no second copy of the naming rules in a jq string.
add_users() { # -> ids on stdout, one per line
  local i name id password
  for ((i = 1; i <= COUNT; i++)); do
    name="$(seed_name "$BATCH" Driver "$i")"
    password="$(seed_password)" || die_fix "could not generate a password for $name" "install openssl or node, then re-run"
    id="$(add_one "User" "$(seed_user_json "$name" "$i" "$COMPANY_GROUP_ID" "$SECURITY_GROUP_ID" "$password")" "driver $name")" || return 1
    printf '%s\n' "$id"
  done
}

add_devices() { # -> ids on stdout, one per line
  local i name id
  for ((i = 1; i <= COUNT; i++)); do
    name="$(seed_name "$BATCH" Asset "$i")"
    id="$(add_one "Device" "$(seed_device_json "$name" "$ASSET_GROUP_ID" "$SEED_FROM")" "asset $name")" || return 1
    printf '%s\n' "$id"
  done
}

assign_drivers() { # <driver ids newline list> <device ids newline list>
  local drivers="$1" devices="$2" driver device
  while IFS=$'\t' read -r driver device; do
    [ -n "$driver" ] && [ -n "$device" ] || continue
    # The assignment's own id is of no use here: the verification below reads
    # each asset's assignment back the way the service does.
    add_one "DriverChange" "$(seed_driverchange_json "$device" "$driver" "$SEED_FROM")" "the assignment on asset $device" >/dev/null || return 1
  done < <(paste <(printf '%s\n' "$drivers") <(printf '%s\n' "$devices"))
}

# Reads back what the service reads: the latest DriverChange per asset, asked
# per device exactly as src/core/unassign-core.js asks for it.
verify_assignments() { # <driver ids> <device ids> -> "index<TAB>driverId<TAB>expected"
  local drivers="$1" devices="$2" device changes latest got index=0
  local driver_list; driver_list="$(printf '%s\n' "$drivers")"
  while read -r device; do
    [ -n "$device" ] || continue
    changes="$(rpc_result "Get" "$(seed_driverchange_search_json "$device" "$SEED_FROM")" "the assignment on asset $device")" || return 1
    latest="$(printf '%s' "$changes" | jq -r 'sort_by(.dateTime) | last | .driver.id // "none"')"
    got="$(printf '%s\n' "$driver_list" | sed -n "$((index + 1))p")"
    printf '%s\t%s\t%s\n' "$index" "$latest" "$got"
    index=$((index + 1))
  done <<< "$devices"
}

seed_fleet() {
  local drivers devices listed
  step "Creating $COUNT drivers in $DATABASE"
  info "each driver gets its own random password, never printed: nobody signs in as these records (an admin can reset one if that ever changes)"
  drivers="$(add_users)"
  info "added $(seed_count "$drivers") drivers (Add User, isDriver: true)"
  step "Creating $COUNT assets in $DATABASE"
  devices="$(add_devices)"
  info "added $(seed_count "$devices") assets (Add Device)"
  step "Assigning each driver to an asset (Add DriverChange)"
  assign_drivers "$drivers" "$devices"
  info "added assignments at $SEED_FROM"

  step "Reading the assignments back, the way the service reads them"
  listed="$(verify_assignments "$drivers" "$devices")"
  local assigned=0 total=0 index got want
  while IFS=$'\t' read -r index got want; do
    [ -n "$index" ] || continue
    total=$((total + 1))
    if [ -n "$got" ] && [ "$got" = "$want" ]; then
      assigned=$((assigned + 1))
      ok "asset $((index + 1)): driver $got assigned"
    else
      warn "asset $((index + 1)): expected driver $want, MyGeotab reports ${got:-none}"
    fi
  done <<< "$listed"

  printf '\n'
  if [ "$assigned" -eq "$total" ] && [ "$total" -gt 0 ]; then
    ok "$assigned of $total assets now have a driver assigned — the scheduled unassign has something to clear"
  else
    warn "$assigned of $total assets show the driver we assigned"
    hint "re-run with --dry-run to look, or check the account's clearance: adding DriverChange records needs access to those assets"
  fi
  printf '\n'
  info "batch $BATCH: to remove all of it later, run $SCRIPT_NAME --database $DATABASE --user $USER_NAME --cleanup"
}

cleanup_batch() { # removes everything named A1SEED-…
  local users devices removed=0 id
  step "Looking for records this script created (names starting $SEED_PREFIX_BASE-)"
  users="$(get_all "User")"
  devices="$(get_all "Device")"
  local user_ids device_ids
  user_ids="$(printf '%s' "$users" | jq -r --arg p "$SEED_PREFIX_BASE" '.[] | select((.name // "") | startswith($p)) | .id')"
  device_ids="$(printf '%s' "$devices" | jq -r --arg p "$SEED_PREFIX_BASE" '.[] | select((.name // "") | startswith($p)) | .id')"
  printf '%s\n' "$users" | jq -r --arg p "$SEED_PREFIX_BASE" '.[] | select((.name // "") | startswith($p)) | "  driver: \(.name)"' >&2
  printf '%s\n' "$devices" | jq -r --arg p "$SEED_PREFIX_BASE" '.[] | select((.name // "") | startswith($p)) | "  asset : \(.name)"' >&2
  if [ -z "$user_ids" ] && [ -z "$device_ids" ]; then
    ok "nothing to remove: no record in $DATABASE is named $SEED_PREFIX_BASE-…"
    return 0
  fi
  local device_count user_count
  device_count="$(seed_count "$device_ids")"
  user_count="$(seed_count "$user_ids")"
  info "$device_count assets and $user_count drivers to remove"
  # Which batches these are, so the confirmation names them (a database could
  # hold more than one seeded run).
  BATCH="$(printf '%s\n%s\n' \
            "$(printf '%s' "$devices" | jq -r --arg p "$SEED_PREFIX_BASE" '.[] | select((.name // "") | startswith($p)) | .name | split("-")[0:2] | join("-")')" \
            "$(printf '%s' "$users" | jq -r --arg p "$SEED_PREFIX_BASE" '.[] | select((.name // "") | startswith($p)) | .name | split("-")[0:2] | join("-")')" \
          | grep . | sort -u | paste -sd, -)"
  confirm_write "remove the seeded records listed above (assets first, then drivers)" \
                "$device_count assets + $user_count drivers"

  # Assets first: a device's assignments go with it, and a driver still
  # referenced by an assignment is the one removal MyGeotab may refuse.
  while read -r id; do
    [ -n "$id" ] || continue
    remove_one "Device" "$id" "seeded asset $id" || return 1
    removed=$((removed + 1))
  done <<< "$device_ids"
  while read -r id; do
    [ -n "$id" ] || continue
    remove_one "User" "$id" "seeded driver $id" || return 1
    removed=$((removed + 1))
  done <<< "$user_ids"
  ok "removed $removed seeded record(s) from $DATABASE"
  info "the DriverChange history stays in MyGeotab (it is a log); it is harmless and ages out on its own"
}

# ---------------------------------------------------------------------------
# Self-tests (offline: no network, no Geotab account)
# ---------------------------------------------------------------------------
run_selftest() {
  st_eq "batch id from an ISO stamp" "A1SEED-20261016T133045Z" "$(seed_batch_id "2026-10-16T13:30:45.123Z")"
  st_eq "batch id drops the offset formatting" "A1SEED-20261016T133045Z" "$(seed_batch_id "2026-10-16T13:30:45Z")"
  st_eq "driver name is zero padded" "A1SEED-x-Driver-03" "$(seed_name "A1SEED-x" "Driver" 3)"
  st_eq "asset name is zero padded" "A1SEED-x-Asset-10" "$(seed_name "A1SEED-x" "Asset" 10)"

  st_eq "counting a captured list" "3" "$(seed_count "$(printf 'a\nb\nc\n')")"
  st_eq "counting nothing is zero, not an error" "0" "$(seed_count "")"

  # A database's groups, as Get Group returns them: the built-ins this repo relies
  # on, plus a customer group that happens to have "Driver" in its name.
  local groups='[
    {"id":"GroupCompanyId","name":"Company Group"},
    {"id":"GroupEverythingSecurityId","name":"Everything"},
    {"id":"GroupDriverSecurityId","name":"Driver"},
    {"id":"GroupVehicleId","name":"Vehicle"},
    {"id":"b42","name":"Drivers - Toronto"}
  ]'
  st_true "an id in the database is accepted" seed_group_exists "$groups" "GroupCompanyId"
  st_false "an id that is not there is refused" seed_group_exists "$groups" "GroupNopeSecurityId"
  st_eq "the group list names what is there" "GroupCompanyId (Company Group), GroupDriverSecurityId (Driver)" \
        "$(seed_group_list '[{"id":"GroupCompanyId","name":"Company Group"},{"id":"GroupDriverSecurityId","name":"Driver"}]')"

  # Which clearance the drivers get. Get Group does not always expose security
  # groups (a live database returned only company groups), so the clearance the
  # script's own account carries is the fallback — an id that database certainly
  # has, because MyGeotab handed it over with the session.
  local known_driver="GroupDriverSecurityId"$'\n'"GroupEverythingSecurityId"$'\n'
  local known_company_only="GroupEverythingSecurityId"$'\n'
  st_eq "a built-in Driver clearance is preferred when the database exposes one" \
        "GroupDriverSecurityId:this database has a Driver clearance" \
        "$(seed_choose_clearance "" "$known_driver" "GroupEverythingSecurityId" | tr '\t' ':')"
  st_eq "otherwise the script's own clearance is used" \
        "GroupEverythingSecurityId:this script's own account" \
        "$(seed_choose_clearance "" "$known_company_only" "GroupEverythingSecurityId" | tr '\t' ':')"
  st_eq "an explicit --security-group wins when the database has it" \
        "GroupEverythingSecurityId:--security-group" \
        "$(seed_choose_clearance "GroupEverythingSecurityId" "$known_driver" "GroupEverythingSecurityId" | tr '\t' ':')"
  st_eq "an explicit id the database did not show is still used, and says so" \
        "GroupCustomSecurityId:--security-group (not one this database showed us)" \
        "$(seed_choose_clearance "GroupCustomSecurityId" "$known_driver" "GroupEverythingSecurityId" | tr '\t' ':')"
  st_false "nothing to choose from is refused, not guessed" seed_choose_clearance "" "" ""
  # Company groups are not clearances, so they stay out of that list.
  st_eq "the clearances a database showed are listed once each" \
        "GroupDriverSecurityId"$'\n'"GroupEverythingSecurityId" \
        "$(seed_known_clearance_ids '[{"id":"GroupCompanyId","name":"Company Group"},{"id":"GroupDriverSecurityId","name":"Driver"}]' "GroupEverythingSecurityId"$'\n')"

  # MyGeotab refuses a driver with no password, and the password has to satisfy
  # the database's policy — which may demand a symbol, so the alphabet includes
  # them rather than relying on 32 alphanumerics passing.
  local pw1 pw2 sample missing=0 i
  pw1="$(seed_password)"
  pw2="$(seed_password)"
  st_eq "a generated password is 33 characters" "33" "${#pw1}"
  st_true "it has an uppercase letter" bash -c "printf '%s' '$pw1' | grep -q '[A-Z]'"
  st_true "it has a lowercase letter" bash -c "printf '%s' '$pw1' | grep -q '[a-z]'"
  st_true "it has a digit" bash -c "printf '%s' '$pw1' | grep -q '[0-9]'"
  st_true "it has a symbol, so a strict policy still passes" bash -c "printf '%s' '$pw1' | grep -q '[^A-Za-z0-9]'"
  st_false "two drivers do not share a password" test "$pw1" = "$pw2"
  # The guarantee, over many draws — drawing from a mixed alphabet looked fine on
  # one sample and produced a symbol-free password once in sixteen.
  for ((i = 0; i < 20; i++)); do
    sample="$(seed_password)"
    case "$sample" in
      *[A-Z]* ) case "$sample" in *[a-z]*) case "$sample" in *[0-9]*) case "$sample" in *[!A-Za-z0-9]*) ;; *) missing=$((missing + 1)) ;; esac ;; *) missing=$((missing + 1)) ;; esac ;; *) missing=$((missing + 1)) ;; esac ;;
      *) missing=$((missing + 1)) ;;
    esac
  done
  st_eq "twenty consecutive passwords all satisfy every class" "0" "$missing"

  local user device change search
  user="$(seed_user_json "A1SEED-x-Driver-01" 1 "GroupCompanyId" "GroupDriverSecurityId" "s3cret-Passw0rd!")"
  st_eq "driver name" "A1SEED-x-Driver-01" "$(printf '%s' "$user" | jq -r .name)"
  st_eq "a driver is a User with isDriver" "true" "$(printf '%s' "$user" | jq -r .isDriver)"
  st_eq "driver fields are what MyGeotab needs" "companyGroups firstName isDriver lastName name password securityGroups" \
        "$(printf '%s' "$user" | jq -r 'keys | join(" ")')"
  st_eq "the driver carries its password" "s3cret-Passw0rd!" "$(printf '%s' "$user" | jq -r .password)"
  # Without these the API refuses the Add twice over: "User's CompanyGroups cannot
  # be null or empty", then "User's SecurityGroups cannot be null or empty".
  st_eq "the driver belongs to the company group" "GroupCompanyId" \
        "$(printf '%s' "$user" | jq -r '.companyGroups[0].id')"
  st_eq "the driver has a clearance" "GroupDriverSecurityId" \
        "$(printf '%s' "$user" | jq -r '.securityGroups[0].id')"
  # The shape MyGeotab's own add-asset request uses, captured from the UI.
  device="$(seed_device_json "A1SEED-x-Asset-01" "GroupVehicleId" "2026-10-16T22:16:14.954Z")"
  st_eq "device name" "A1SEED-x-Asset-01" "$(printf '%s' "$device" | jq -r .name)"
  st_eq "the asset belongs to the Vehicle group" "GroupVehicleId" "$(printf '%s' "$device" | jq -r '.groups[0].id')"
  st_eq "the serial number is blank, not invented" "" "$(printf '%s' "$device" | jq -r .serialNumber)"
  st_eq "the asset is active from now" "2026-10-16T22:16:14.954Z" "$(printf '%s' "$device" | jq -r .activeFrom)"
  st_eq "the asset stays active" "2050-01-01T00:00:00.000Z" "$(printf '%s' "$device" | jq -r .activeTo)"
  st_eq "device fields are what MyGeotab's own request carries" \
        "activeFrom activeTo groups name serialNumber" \
        "$(printf '%s' "$device" | jq -r 'keys | join(" ")')"
  st_eq "the Vehicle group is used when the database has it" "GroupVehicleId" \
        "$(seed_asset_group_id "$groups")"
  st_eq "a database without it files assets in the company group" "GroupCompanyId" \
        "$(seed_asset_group_id '[{"id":"GroupCompanyId","name":"Company Group"}]')"
  change="$(seed_driverchange_json "b1" "b2" "2026-10-16T13:30:00.000Z")"
  st_eq "an assignment is a DriverChange for the device" "b1" "$(printf '%s' "$change" | jq -r .device.id)"
  st_eq "an assignment names the driver" "b2" "$(printf '%s' "$change" | jq -r .driver.id)"
  st_eq "an assignment carries the Driver type the service writes" "Driver" "$(printf '%s' "$change" | jq -r .type)"
  st_eq "an assignment is stamped" "2026-10-16T13:30:00.000Z" "$(printf '%s' "$change" | jq -r .dateTime)"
  search="$(seed_driverchange_search_json "b1" "2026-10-16T13:30:00.000Z")"
  st_eq "the read asks for DriverChange" "DriverChange" "$(printf '%s' "$search" | jq -r .typeName)"
  st_eq "the read bounds the search to this device" "b1" "$(printf '%s' "$search" | jq -r .search.deviceSearch.id)"
  st_eq "the read includes overlapped changes, like the service" "true" \
        "$(printf '%s' "$search" | jq -r .search.includeOverlappedChanges)"

  # MyGeotab answers [{id}] per Add, but a bare id is accepted rather than
  # guessed at; the id order has to survive, because it is how drivers line up
  # with assets.
  # Both shapes reach it: the JSON-RPC envelope, and the already-unwrapped result
  # that rpc_result hands over.
  st_eq "the id, from the envelope" "b1" "$(printf '%s' '{"result":[{"id":"b1"}]}' | rpc_first_id)"
  # What a live MyGeotab answered for an Add Device: a bare id, not a list.
  st_eq "the id, as MyGeotab returned it live" "b58" "$(printf '%s' '{"result":"b58"}' | rpc_first_id)"
  st_eq "the id, from the unwrapped result" "b1" "$(printf '%s' '[{"id":"b1"}]' | rpc_first_id)"
  st_eq "the id from a nested result" "b1" "$(printf '%s' '[[{"id":"b1"}]]' | rpc_first_id)"
  st_eq "the id from a bare string" "b1" "$(printf '%s' '["b1"]' | rpc_first_id)"
  st_eq "the first id wins when several come back" "b1" \
        "$(printf '%s' '[{"id":"b1"},{"id":"b2"}]' | rpc_first_id)"
  st_eq "an empty result has no id" "" "$(printf '%s' '[]' | rpc_first_id)"
  st_eq "an error envelope has no id" "" "$(printf '%s' '{"error":{"code":"X"}}' | rpc_first_id)"
  st_eq "unexpected json has no id" "" "$(printf '%s' 'null' | rpc_first_id)"

  st_done "$SCRIPT_NAME"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if [ "$SELFTEST" -eq 1 ]; then
  run_selftest
fi

case "$COUNT" in
  ''|*[!0-9]*) die_fix "--count must be a number (got '$COUNT')" "pass --count 10" ;;
esac
[ "$COUNT" -ge 1 ] && [ "$COUNT" -le 100 ] || die_fix "--count must be between 1 and 100 (got $COUNT)" "pass --count 10"

for tool in curl jq; do
  require_command "$tool" || die_fix "$tool is required" "install $tool and re-run $SCRIPT_NAME"
done
[ "$SERVER" != "" ] || die_fix "--server cannot be empty" "pass --server my.geotab.com"

gather_credentials

step "Signing in to $DATABASE on $SERVER"
authenticate
ok "signed in as $USER_NAME on database $DATABASE ($MYGEOTAB_IDENTITY)"

# Which group and clearance the new records join, from this database's own groups
# (also read before --dry-run, so the plan names them).
resolve_groups

if [ "$DRY_RUN" -eq 1 ]; then
  build_batch
  step "Dry run: nothing will be written"
  printf '%s\n' "  database : $DATABASE"
  printf '%s\n' "  server   : $SERVER"
  printf '%s\n' "  batch    : $BATCH"
  printf '%s\n' "  groups   : drivers in '$COMPANY_GROUP_NAME' with clearance $SECURITY_GROUP_ID (from $SECURITY_GROUP_SOURCE)"
  printf '%s\n' "             assets in '$ASSET_GROUP_NAME'"
  printf '%s\n' "  would add: $COUNT drivers (Add User, isDriver: true, each with its own random password)"
  printf '%s\n' "             $COUNT assets (Add Device)"
  printf '%s\n' "             $COUNT assignments (Add DriverChange, driver named, type Driver)"
  printf '%s\n' "  first driver would be: $(seed_name "$BATCH" Driver 1)"
  printf '%s\n' "  first asset  would be: $(seed_name "$BATCH" Asset 1)"
  exit 0
fi

build_batch

if [ "$CLEANUP" -eq 1 ]; then
  cleanup_batch
  exit 0
fi

confirm_write "create a seeded test fleet and assign its drivers" \
              "$COUNT drivers + $COUNT assets + $COUNT assignments, all named $BATCH-…"
seed_fleet
