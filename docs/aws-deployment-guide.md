# Deployment and operations guide

How to deploy, feed and run the Scheduled Driver Unassign service on AWS. One deployment per
country; both are the same code with different variables and state.

| Deployment | Region | OpenTofu state | Tenant config |
|---|---|---|---|
| Canada | `ca-central-1` | `s3://advone-ca-central-deploy/scheduled-driver-unassign/terraform.tfstate` | `s3://advone-ca-central-config/config/customers.json` |
| United States | `us-east-2` | `s3://advone-east-2-deploy/scheduled-driver-unassign/terraform.tfstate` | `s3://advone-east-2-config/config/customers.json` |

The two `-deploy` buckets are shared with other Advantage One services, so everything this service
owns sits under the `scheduled-driver-unassign/` prefix — its state, the state lock OpenTofu writes
beside it, and its ownership marker. The deploy script only ever lists and guards that prefix, so
another service storing its state in the same bucket is neither counted nor touched. Both backend
configs and the scripts derive the prefix from one constant (`SERVICE_SLUG` in
`scripts/lib/common.sh`); a mismatch between the backend config and the scripts is refused before
`tofu init`.

What one deployment contains: a Lambda function (`advone-unassign-api`) with a Function URL, one S3
bucket holding the tenant registry, a Secrets Manager secret per tenant, an SNS topic with the
alarms, an SQS dead-letter queue for failed scheduled runs, and a schedule group per onboarded
Geotab database. There is no VPC, no database, and nothing to scale.

Estimated cost: the Lambda runs for a few seconds per scheduled slot per tenant, so a handful of
customers is cents per month. The S3 and Secrets Manager line items are the floor (~$0.40 per
secret per month).

---

## 1. Prerequisites

- AWS CLI v2, logged in to the account that owns the deployments (`aws sts get-caller-identity`
  must work).
- OpenTofu 1.10 or newer (`tofu version`), `jq`, and `zip`.
- Permission to create S3 buckets, Lambda, IAM roles, EventBridge Scheduler schedules, SQS queues,
  SNS topics and CloudWatch alarms in the target region.

The deploy script checks all of this before changing anything.

## 2. Before the first real run

Three things need access this repository does not have. Until item 1 is done, **every browser
request is denied by design** (fail closed).

1. **This add-in's Geotab security id.** The config ships with `"securityId": { "id": "" }`.
   Install the add-in in a test database and capture its filter entry
   (`{ "isAdd": true, "securityId": { "id": "…", "customPageName": "Scheduled Driver Unassign" } }`)
   from a `Get Group` response, then set `addIn.securityId.id` in the tenant config:
   ```bash
   aws s3 cp s3://advone-ca-central-config/config/customers.json - --region ca-central-1 |
     jq '.addIn.securityId.id = "<captured id>"' |
     aws s3 cp - s3://advone-ca-central-config/config/customers.json --region ca-central-1
   ```
   `pageName` matching (`"Scheduled Driver Unassign"`) is a fallback while the id is empty, and is
   disabled when `pageName` is also empty.
2. **Two-user proof.** In one database, call any read action (`listSchedules`) as an Administrator
   and as a restricted user who lacks this add-in. The first must succeed; the second must return
   `403 ADDIN_ACCESS_DENIED`. If both succeed, stop: `GroupSecurityId` (the database-wide catalog,
   which lists every filter as `isAdd: true`) is being trusted, and `clearance.ignoreCatalogGroup`
   must be checked before anyone uses this in production.
3. **Session shape.** Confirm the add-in's `api.getSession()` returns `userName`, `database`,
   `sessionId` and `server`. The Lambda uses those four values; the legacy add-in only ever read
   `userName`.

## 3. Deploy

```bash
scripts/deploy.sh              # interactive: asks Canada or United States
scripts/deploy.sh --region us  # non-interactive region, still asks before applying
```

The script, in order:

1. checks `aws`, `tofu` (>= 1.10), `jq` and `zip`, then `aws sts get-caller-identity`;
2. creates the state bucket if it does not exist (versioning, encryption, public access blocked);
3. writes and verifies its ownership marker (`scheduled-driver-unassign/deployment.json`) in that
   bucket — if the marker names a different account or region, it stops rather than touching someone
   else's deployment (`--force` adopts it). It also refuses to run if this service's state is still
   sitting at the pre-prefix key, and prints the `aws s3 mv` that fixes it;
4. builds `dist/lambda.zip` from `src/` and checks that it contains `src/lambda/handler.js`;
5. `tofu init` with `infra/backend/<region>.hcl`, then `tofu plan`;
6. prints a summary of adds / changes / **destroys** and asks for confirmation (`--yes` skips the
   prompt, `--plan-only` stops here);
7. applies, prints the outputs, and smoke-tests the deployment by invoking `{"action":"health"}`;
8. publishes the add-in page to the region's hosting bucket with that region's endpoint stamped in,
   fetches it back to prove it is readable, and prints the MyGeotab configuration to paste (§4).

Useful flags: `--plan-only`, `--yes`, `--force`, `--destroy` (requires typing the deployment name
to confirm; `--yes` never skips that), `--selftest` (offline checks of the script's own helpers).

Re-running with nothing changed prints "no changes" and skips the apply — but it still publishes the
add-in page, because the page is not a Terraform resource and a page-only fix (like a UI bug fix)
ships through this same command. Two simultaneous runs are stopped by the OpenTofu state lock, not
by a double apply.

## 4. Point the add-in at the deployment

`SERVER_API_BASE`, at the top of the add-in's `<script>` block, is where the add-in calls. You do not
set it by hand for a deployment: `scripts/deploy.sh` publishes the page to the region's hosting
bucket with that region's `function_url` stamped in, and prints the configuration to paste:

| Region | Published page |
|---|---|
| Canada | `https://advone-addin-hosting-ca-central-1.s3.ca-central-1.amazonaws.com/unassign/unassignDrivers.html` |
| United States | `https://advone-addinhosting-us-east-2.s3.us-east-2.amazonaws.com/unassign/unassignDrivers.html` |

Each deployment serves its own region's copy, so a database is never pointed at the other region by
accident. The configuration to paste is committed per region — [`config.ca.json`](../config.ca.json)
and [`config.us.json`](../config.us.json) — and the deploy prints that same file, after checking it
against the page it actually uploaded (a config naming the other region's endpoint works fine in
MyGeotab and fails silently, so it is worth failing the deploy over).

In MyGeotab: **System Settings → Add-Ins → Allow unverified Add-Ins**, then **New Add-In** and paste
that region's JSON. If the add-in is already installed, edit that entry instead — MyGeotab rejects a
second add-in with the same name. MyGeotab keeps its own copy of the page once installed, so after a
page-changing deploy, update the add-in's URL (or re-paste the config) to pull the new copy in.

The buckets are not Terraform resources (they were made by hand and each region has one for all of
Advantage One's add-ins). The deploy creates a missing one and applies, every run:

- **public read by policy**, scoped to this service's own `unassign/` prefix — object ACLs stay
  blocked, so a bug here cannot expose another service's objects;
- **versioning on**, so a bad upload can be rolled back without a redeploy;
- `Cache-Control: public, max-age=60, must-revalidate` on the page, so a fresh deploy is visible
  within a minute.

The repo's copy of `unassignDrivers.html` stays committed pointing at **Canada**
(`https://yfzpzulqadv5r7rkbtbenmphiy0xrdnl.lambda-url.ca-central-1.on.aws`) so it works when opened
from disk or served from jsDelivr; the deploy replaces that one line per region. To point any other
build elsewhere, change the constant and re-release:

```js
var SERVER_API_BASE = "https://<the function_url output>";
```

With that value set the add-in shows a **Scheduled runs** card, hides the in-browser-only controls
(grace window, wake lock), and stops running schedules from the browser tab. With it empty, the
add-in keeps its original in-browser scheduler.

The add-in's frame is served from a MyGeotab host, and those hosts are `geotab.com` subdomains, so
`allowed_origins` defaults to the pattern `"https://*.geotab.com"` — that covers `my.geotab.com`,
`myg-static.geotab.com`, regional hosts and anything else Geotab serves add-ins from, without listing
them. Entries are exact origins or patterns where `*` stands for any run of characters that does not
cross a `/`, compared case-insensitively; `https://geotab.com`, `https://evil-geotab.com` and
`https://my.geotab.com.evil.com` are all refused. Add `"https://cdn.jsdelivr.net"` only if the add-in
ever ends up in a frame served from jsDelivr rather than from MyGeotab.

Two layers, and only one of them can hold a pattern:

- **The Function URL's `cors` block** adds the headers and answers the preflight itself. The Lambda
  API accepts exact origins or a bare `*` — no patterns — so when `allowed_origins` contains a
  pattern, Terraform widens the URL's list to `*` and the function enforces the real policy
  (`isOriginAllowed` in `src/lambda/http.js`). The function adds no CORS headers of its own: with the
  URL's headers in play, both sets would appear and the browser would reject the response for having
  multiple `Access-Control-Allow-Origin` values.
- **The function's own check** runs on every request and answers `403 ADDIN_ACCESS_DENIED` for an
  origin that does not match. That is the gate that still applies when something invokes the function
  directly rather than through the URL.

`allow_methods` is `["POST"]` for a related API quirk: each member is capped at six characters, so
`OPTIONS` cannot be listed, and the browser checks the *actual* request method anyway.

## 5. Onboard a customer

```bash
scripts/onboard-customer.sh            # asks the region too
scripts/onboard-customer.sh --region ca
```

It asks for the Geotab database, server (default `my.geotab.com`), service-account user name,
password (or offers to generate a 32-character one), time zone (default per deployment: Toronto for
Canada, New York for United States) and optional notes. Before writing anything it signs in to
MyGeotab with those credentials; a wrong password exits with no side effects. It then creates or
updates the secret `unassign/<database>/serviceaccount` and merges the customer into the S3 config with a
conditional write, so two operators onboarding at the same time cannot clobber each other.

The service account must be a dedicated MyGeotab user with Administrator clearance and Company
Group access — it needs to change driver assignments and write the run log. `--dry-run` prints the
resulting configuration without writing anything.

### Licensing, and setting a database up from the add-in

A database is **licensed** when its record in `config/customers.json` carries
`"license": { "licensed": true }`. Without it, everyone who is not Advantage One staff is refused
with `403 LICENSE_REQUIRED` and the add-in shows a modal saying *"Please contact your CSR to enabled
your license"*. Two ways to license a database:

1. **`scripts/onboard-customer.sh`** — whoever has AWS credentials and onboards a database is
   licensing it, so the record it writes is licensed (`"source": "onboard-script"`).
2. **The add-in's setup panel**, for staff (see below): it registers the database and licenses it in
   one step (`"source": "addin-panel"`).

**Staff** are identified by the email domain of their MyGeotab user name, exactly (not by suffix —
`someone@not-advtracking.net` is not staff). The defaults are `advtracking.net` and
`advantageone.tech`, overridable in the config:

```json
"licensing": { "staffDomains": ["advtracking.net", "advantageone.tech"], "enforce": true }
```

A staff member opening the add-in in a database with no worker configured sees a **Service account
setup** card (it needs only a proven session and a staff domain, not the add-in's Geotab clearance,
so staff can register databases before `addIn.securityId.id` is configured): MyGeotab user name, password, server, and a "License this database" checkbox. Saving it
verifies the credentials against MyGeotab first, then writes the secret `unassign/<database>/serviceaccount`, then
adds or updates the record — `enabled: true`, `workerUserName` (display only, never a credential),
`timeZone` and the license block. A credential that MyGeotab rejects is reported and nothing is
written. The password exists only in that request and in Secrets Manager: never in the config, never
in a log.

Two consequences worth knowing:

- **Enforcement covers the add-in's actions, not scheduled runs.** An unlicensed database keeps
  running its existing schedules; stopping a customer's fleet process is a billing decision, not
  something a flag should do silently. Setting `"enforce": false` also stops the refusals while the
  add-in still shows the state.
- **The Lambda can now write.** Its role may create or update `unassign/*` secrets and write the one
  config object. Both are reachable only through the staff-only action, behind a proven MyGeotab
  session.
- **The scheduled path is gated on the configuration, and fails loudly when it is missing.** A
  schedule that fires for a database with no record in this deployment (a leftover after an
  offboarding, for instance) errors: EventBridge retries the invocation, the payload lands in the
  DLQ and the alarm fires. The same happens when the service account in the secret no longer signs
  in — the run does not happen and someone is told. A record that is present but `"enabled": false`
  is skipped quietly instead, because that is a decision an operator made on purpose.

To unlicense a database, set `"licensed": false` (the add-in reads the config at most 60 seconds
later); to disable it entirely, set `"enabled": false`.

To stop a customer without losing its history:

```bash
scripts/offboard-customer.sh --region ca            # sets enabled: false, deletes nothing else
scripts/offboard-customer.sh --region ca --delete-secret
```

## 6. Day-to-day operations

| Task | How |
|---|---|
| See a tenant's schedules | Add-in **Scheduled runs** table, or `aws scheduler list-schedules --group-name UnassignDriverSchedules-<db> --region <r>` |
| Create or change a schedule | Add-in Scheduler tab → **Save Schedule** (the name is derived from scope + time, so saving the same plan updates it) |
| Run once at a specific time | Add-in **Run once at** → **Add one-time run** |
| Run everything now | Add-in **Unassign All Now**, or invoke the Lambda with a session payload |
| Prove a deployment is alive | `aws lambda invoke --function-name advone-unassign-api --payload '{"action":"health"}' out.json --region <r> && cat out.json` |
| Turn off one tenant in an emergency | Set `customers.<db>.enabled = false` in the config; or `aws scheduler update-schedule … --state DISABLED` per schedule; or delete the tenant's schedule group |
| Rotate a customer's password | Change it in MyGeotab, then re-run `scripts/onboard-customer.sh` for that database (it updates the secret in place) |
| Delete a tenant's schedules | Add-in **Delete** per row, or `aws scheduler delete-schedule --name <n> --group-name UnassignDriverSchedules-<db>` |
| Prove clearing works in a database | `scripts/seed-test-fleet.sh` (below), then a run, then the add-in's Run history |

### Proving a database clears for real

`scripts/seed-test-fleet.sh` puts a test fleet into one MyGeotab database and assigns it: 10 drivers
(`Add User`, `isDriver: true`), 10 assets (`Add Device`) and 10 assignments (`Add DriverChange` —
MyGeotab has no assignment endpoint, and that is the same record the service writes to clear one). It
needs a user with **Administrator** clearance, reads its password from the terminal (never from an
argument), and refuses to write until the database name is typed back:

```bash
scripts/seed-test-fleet.sh --database advone_matt_dev1 --user matt@example.com   # seed
#   … then run the schedule (add-in "Unassign All Now", or wait for the slot) …
scripts/seed-test-fleet.sh --database advone_matt_dev1 --user matt@example.com --cleanup
```

Everything it creates is named `A1SEED-<stamp>-…`, so a batch is identifiable and `--cleanup` removes
exactly that. After seeding, the add-in's **Preview** should list those 10 assets with drivers, and
**Run history** after a run should report 10 unassigned (and 0 failed) — if it reports
`stillAssigned`, something is re-asserting the driver (see the alarms table).

It talks to MyGeotab directly, so it works with or without a deployment (`--server` for regional
hosts); `--dry-run` signs in, prints what it would create and writes nothing.

## 7. Alarms

All alarms publish to the deployment's SNS topic (`alarm_topic_arn` output; subscribe an email
address with the `alarm_email` Terraform variable). Metrics come from JSON log fields, so the log
line always names the tenant.

| Alarm | Meaning | First response |
|---|---|---|
| `UnassignFailed` (`outcome = "failed"`) | A run reached Geotab but some writes failed | Check the log line's `failed` count and `reason`; re-run the slot from the add-in once the cause is fixed |
| `UnassignStillAssigned` (`stillAssigned > 0`) | Assets were written but a driver re-appeared on the verification pass (a key or Geotab Drive re-asserted a login) | Expected occasionally; if it repeats for one tenant, check their Drive usage |
| `UnassignDenied` (`outcome = "denied"`) | A browser request failed authorization (bad session, unknown database, missing clearance) | Usually a stale session; a sustained spike means the add-in's security id or `ALLOWED_ORIGINS` is wrong |
| Lambda `Errors` / `Throttles` | The function threw, or hit concurrency limits | Read the failed invocation's log; a thrown error on the scheduled path also retries and can land in the DLQ |
| DLQ depth ≥ 1 | A scheduled run failed enough times to be parked — most often a schedule firing for a database with **no configuration** (leftover after an offboarding), or service-account credentials in the secret that MyGeotab now rejects | Inspect the message for the payload and the reason, fix it (onboard the database, or rotate the credential with `scripts/onboard-customer.sh`), then delete the message. Delete the schedule too if the database is gone for good |

### What the logs say

Every invocation logs one line per stage, so a request can be followed end to end by its
`requestId`. Authentication in particular is never silent: it is proven, and either outcome is
recorded.

| Line (`msg`) | Written when | Useful fields |
|---|---|---|
| `event received` | always, before anything else runs | `eventType` (`http`, `direct`, `scheduler`), `action`, `method`, `origin`, `hasSession`, `userName`, `database` |
| `session proven` | the caller's MyGeotab session was verified with `Get User` | `database`, `userName`, `userId`, `server` |
| `session refused` | the session was absent, expired, or belonged to no user | `outcome: "denied"`, `code: "SESSION_INVALID"`, `reason` |
| `license checked` | the add-in asked about licensing | `domain`, `staff`, `licensed`, `onboarded`, `workerConfigured`, `setupAllowed` |
| `action completed` | an action finished | `outcome: "ok"`, `licensed`, and `staff` for the setup action |
| `action failed` | an action was refused or errored | `outcome` (`denied` or `failed`), `code`, `reason` |
| `scheduled run finished` / `scheduled run failed` | a schedule fired | `outcome`, `unassigned`, `skipped`, `failed`, `stillAssigned` |
| `service account saved from the add-in` | a staff member registered a database | `secretCreated`, `licensed`, `configUpdated`, `attempts` |

Payload contents are never logged — the setup action carries a password — and neither are session
ids or credentials.

```text
# one request, start to finish
fields @timestamp, msg, action, outcome, code, reason
| filter requestId = "<the request id>"
| sort @timestamp asc

# who failed to authenticate, and why
fields @timestamp, userName, database, reason | filter msg = "session refused"

# licensing as the add-in saw it
fields @timestamp, database, domain, staff, licensed | filter msg = "license checked"

# runs that did anything other than succeed
fields @timestamp, database, outcome, failed, stillAssigned | filter msg like /scheduled run/
```

## 8. Break-glass and rollback

- **Stop everything for one tenant:** set `enabled: false` in the config (the scheduled path then
  answers `200 skipped` and logs `outcome: "disabled"`; no retries, no DLQ).
- **Stop everything everywhere:** disable the schedule groups in the AWS console, or set the
  `alarm_email`/schedules aside by deleting the `UnassignDriverSchedules-*` groups.
- **Roll back the code:** `git revert`, push, and re-run `scripts/deploy.sh --region <r>`; the state
  records the previous revision, so `tofu plan` shows the revert.
- **Roll back one tenant to the old in-browser scheduler:** clear `SERVER_API_BASE` in the add-in and
  publish a release; the add-in's original scheduler (and its `AddInData` schedule) still exists.
  While both run, the AddInData lock stops a double run for the same occurrence.
- **Tear a deployment down:** `scripts/deploy.sh --region <r> --destroy` (types the deployment name
  to confirm). The state bucket, the customer secrets, and any tenant's run log in Geotab are not
  removed by Terraform.

## 9. Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| Add-in shows "Add-In access denied" for everyone | `addIn.securityId.id` is empty, or the caller's clearance groups do not carry the add-in's filter | Do step 2 of §2; check `clearance` flags in the config |
| Every request denied with `403` and no log of an action | The origin does not match any entry in `allowed_origins` (exact, or a pattern with `*`) | Check the browser's actual frame origin (`document.location.origin` in the add-in) and add it as an exact origin or pattern, then re-apply |
| Browser console: "Access-Control-Allow-Origin header contains multiple values" | Something re-added CORS headers in the function, on top of the Function URL's | Delete them from `src/lambda/http.js`; the Function URL is the only owner |
| `ValidationException: Value '[POST, OPTIONS]' at 'cors.allowMethods'` during apply | `OPTIONS` was added to `allow_methods` | Keep `allow_methods = ["POST"]`; Lambda answers the preflight and rejects `OPTIONS` (members are capped at six characters) |
| `401 SESSION_INVALID` | The forwarded session expired, or `sessionId` was not sent | Confirm the add-in's `getSession()` shape (§2.3) |
| Add-in shows the unlicensed modal for a database you licensed | The record has no `license.licensed: true`, or the add-in cached the config (≤ 60 s) | Check `jq .customers.\"<db>\".license` in the config; reload the page after a change |
| Staff member sees no setup card | Their user name's domain is not in `licensing.staffDomains` (exact match) | Fix the domain list in the config, or use an Advantage One account |
| `403 LICENSE_REQUIRED` from the add-in after licensing | The Lambda's config cache (60 s) or the S3 write did not land | Confirm the object in S3, then retry |
| `saveWorkerCredentials` returns "MyGeotab rejected those credentials" | Wrong password, wrong database, or the account is locked | Nothing was written — check the account in MyGeotab and try again |
| `403 DATABASE_NOT_ONBOARDED` | The database is not in the config, or `enabled` is false | Onboard it, or check the config |
| Scheduled slot never fired | No schedule for that scope/time, schedule group missing, or Lambda permission missing | `aws scheduler list-schedules --group-name …`; check the Scheduler execution role in `infra/modules/unassign` |
| Two runs for one slot | A tenant still runs the legacy in-browser scheduler with a signed-in tab | Set `SERVER_API_BASE`, or set the add-in's schedule to disabled in Geotab |
| `dist/lambda.zip` built but apply fails on the handler | The archive does not keep the `src/` prefix | Rebuild from the repo root (`zip -qr dist/lambda.zip src`) |
| Deploy refuses with "state bucket belongs to …" | The marker names another account or region | Confirm you meant to adopt it, then `--force` |
| Deploy refuses with "state from before the service prefix" | This service deployed before the state key gained its prefix | Run the `aws s3 mv` the error prints (moves `unassign/terraform.tfstate` to `scheduled-driver-unassign/terraform.tfstate`), then re-run |
| Deploy refuses with "already holds other state for this service" | A second state key exists under this service's prefix (a stray copy or a hand-made state) | Inspect `aws s3 ls s3://<bucket>/scheduled-driver-unassign/ --recursive`, then delete the stray deliberately and re-run (or `--force`) |
| Another service's state shows up in a deploy message | It should not — the script lists only this service's prefix | Report it: the prefix comes from `SERVICE_SLUG` in `scripts/lib/common.sh` |

## 10. Limits worth knowing

- EventBridge Scheduler names accept only `[0-9a-zA-Z-_.]{1,64}` — no slashes or colons. The
  script-side mapping is in `src/lambda/lib/naming.js`.
- 500 schedule groups per region (one per tenant database), 10,000,000 schedules per region, target
  payload ≤ 256 KB, `ListSchedules` 50 requests/second. One-time runs delete themselves
  (`ActionAfterCompletion: DELETE`), so they do not accumulate.
- A recurring schedule is a `cron()` expression evaluated in the tenant's time zone; a one-time run
  is converted to UTC before it is written, so it never depends on the reader's clock.
- The Lambda has a 300-second timeout. A very large fleet (thousands of active assets, one
  `DriverChange` read per device) is the only plausible way to approach it; if that happens, split
  the run by group schedule rather than raising the timeout.
