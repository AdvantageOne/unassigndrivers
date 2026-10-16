# Scheduled Driver Unassign by Advantage One

MyGeotab add-in that resets every asset to **Unknown Driver** at the times you set, so each
shift starts clean and trips are not credited to the previous driver.

The add-in is a single HTML file. Schedules are stored in AWS EventBridge Scheduler and
executed by a Lambda, so they fire whether or not anyone has MyGeotab open. Results are
written back to the tenant's own MyGeotab database as a run log.

| | |
|---|---|
| Add-in | `unassignDrivers.html`; `scripts/deploy.sh` publishes it to the region's hosting bucket (`unassign/unassignDrivers.html`) with that region's endpoint stamped in. The repo copy and `config.json` serve the jsDelivr path |
| Scheduling | One Lambda + EventBridge Scheduler per region: Canada `ca-central-1`, United States `us-east-2` |
| Tenant config | `s3://<deployment>-config/config/customers.json` |
| Credentials | One AWS Secrets Manager secret per tenant (`unassign/<database>/serviceaccount`) |
| Deploy | `scripts/deploy.sh` (asks Canada or United States, then plans and applies) |
| Licensing | Per database, in the deployment config. Advantage One staff can register a database and license it from the add-in's setup panel; anyone else on an unlicensed database sees a "contact your CSR" message instead of the scheduler |
| Support | jordan@advtracking.net |

Docs: **[deployment guide](docs/aws-deployment-guide.md)** for operating it,
**[maintainer's guide](docs/maintainers-guide.md)** for changing it,
**[implementation brief](docs/aws-port-implementation-prompt.md)** for the design decisions,
**[legacy analysis](docs/aws-lambda-eventbridge-port.md)** for how the GitHub Actions version worked.

## Install the add-in in a MyGeotab database

One file per region, naming that region's published page (the deploy prints the same file after
checking it against what it just uploaded):

| Database | Configuration to paste |
|---|---|
| Canada (`ca-central-1`) | [`config.ca.json`](config.ca.json) — `https://advone-addin-hosting-ca-central-1.s3.ca-central-1.amazonaws.com/unassign/unassignDrivers.html` |
| United States (`us-east-2`) | [`config.us.json`](config.us.json) — `https://advone-addinhosting-us-east-2.s3.us-east-2.amazonaws.com/unassign/unassignDrivers.html` |

1. Open **System Settings → Add-Ins** and turn on **Allow unverified Add-Ins**.
2. Click **New Add-In** and paste that region's JSON into **Configuration**. If the add-in is already
   installed, edit the existing entry instead, because MyGeotab rejects a second add-in with the same
   name.
3. Click **Done**, then **Save**, and refresh the browser.

MyGeotab keeps its own copy of the page once installed, so after a deploy that changes the page,
update the add-in entry (or re-paste its configuration) to pull the new copy in.

To install it without a deployment, use [`config.json`](config.json), which loads the page from
jsDelivr (the repo's copy is committed pointing at the Canada endpoint). Either way the add-in reads
and writes schedules through the scheduling service; with `SERVER_API_BASE` near the top of its
`<script>` block empty, it falls back to its original behaviour of running schedules in the browser
while a tab is open. See the [deployment guide](docs/aws-deployment-guide.md) for the hosted URLs
and the bucket setup behind them.

## Release a new version of the add-in

1. Edit the sources, not the built file: schedule logic lives in `src/core/unassign-core.js`, the
   service client in `src/addin/api-client.js`, and the UI in `unassignDrivers.html`. In that last
   file, check that `SERVER_API_BASE` still points at the deployment you mean — it is baked into the
   add-in and currently names the Canada endpoint. (For an AWS deployment this constant is only a
   default: `scripts/deploy.sh` stamps the region's endpoint into the copy it publishes.)
2. Run `pnpm test` (this includes a check that the built file matches `src/`) and `pnpm run build:addin`.
3. Bump `version` in [`config.json`](config.json) and publish a release with a **new** tag that
   matches (for example `v2.0.1`). Never move or reuse a tag: jsDelivr caches each tag permanently.
4. In each database, replace the add-in configuration with the new `config.json`.

## Deploy or change the AWS side

```bash
scripts/deploy.sh                 # asks: Canada (ca-central-1) or United States (us-east-2)
scripts/onboard-customer.sh       # register a Geotab database with the scheduler
scripts/offboard-customer.sh      # disable one, keeping its run history
```

Deployment requires only an AWS CLI login and OpenTofu 1.10+; the scripts own every other detail
(bucket names, state, artifact, outputs, and the add-in upload). A run that changes no infrastructure
still republishes the add-in page, so add-in fixes ship with the same command. See the
[deployment guide](docs/aws-deployment-guide.md).

## Repository map

```
unassignDrivers.html            the add-in; built regions are generated (see below)
config.ca.json                  add-in configuration for the Canada database (S3 page)
config.us.json                  add-in configuration for the United States database (S3 page)
config.json                     standalone/legacy install; loads the page from jsDelivr
config.pages.json               legacy GitHub Pages config, unused
src/core/unassign-core.js       schedule math, lock, unassign, run log (shared: add-in + Lambda)
src/addin/api-client.js         browser client for the scheduling service
src/lambda/                     the service: handler, actions, libraries
build/inline-core.mjs           copies src/ into the add-in between BUILD markers
package.json                    pnpm scripts and engine pins (no dependencies)
pnpm-lock.yaml                  lockfile; `pnpm install` writes nothing else
test/                           unit tests (pnpm test); no network, no AWS, no tenant required
infra/                          OpenTofu: module plus one thin root per region
scripts/                        deploy, onboard, offboard
docs/                           deployment guide, maintainer's guide, design brief, legacy analysis
```

**Tooling.** Package manager is pnpm (pinned in `package.json`; `pnpm test`, `pnpm run build:addin`).
The project has no dependencies — the Lambda runtime provides AWS SDK v3 — so `pnpm install` only
writes the lockfile and `node_modules/` stays empty. Infrastructure pins the AWS provider to
`~> 6.69` (lock files record 6.69.0) and requires OpenTofu 1.10+.

**Built regions.** The two marked blocks in `unassignDrivers.html` (`BUILD:core`, `BUILD:client`)
are generated from `src/` by `pnpm run build:addin`. Never edit inside those markers: edit the
source and rebuild, or `pnpm test` will fail with a clear message.

## Status

- Implemented: shared core extraction with tests, the Lambda service (all add-in actions plus the
  scheduled path), per-database licensing with the staff-only setup panel, OpenTofu for both
  regions, deploy/onboard/offboard scripts, the add-in's service mode, and these docs.
- Pending, and requiring access this repository does not have: resolving this add-in's Geotab
  `securityId.id` (the deployment ships with `""`, which denies everyone until it is set), proving
  the clearance check against a real admin and a real restricted user, and the pilot/cutover.
  Details in [docs/aws-deployment-guide.md](docs/aws-deployment-guide.md#2-before-the-first-real-run).

Support: jordan@advtracking.net
