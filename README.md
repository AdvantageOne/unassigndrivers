# Scheduled Driver Unassign by Advantage One

MyGeotab add-in that resets every asset to **Unknown Driver** at the times you set, so each
shift starts clean and trips are not credited to the previous driver.

The add-in is a single HTML file. Schedules are stored in AWS EventBridge Scheduler and
executed by a Lambda, so they fire whether or not anyone has MyGeotab open. Results are
written back to the tenant's own MyGeotab database as a run log.

| | |
|---|---|
| Add-in | `unassignDrivers.html`, loaded by MyGeotab through jsDelivr, pinned to a release tag |
| Scheduling | One Lambda + EventBridge Scheduler per region: Canada `ca-central-1`, United States `us-east-2` |
| Tenant config | `s3://<deployment>-config/config/customers.json` |
| Credentials | One AWS Secrets Manager secret per tenant (`unassign/<database>`) |
| Deploy | `scripts/deploy.sh` (asks Canada or United States, then plans and applies) |
| Licensing | Per database, in the deployment config. Advantage One staff can register a database and license it from the add-in's setup panel; anyone else on an unlicensed database sees a "contact your CSR" message instead of the scheduler |
| Support | jordan@advtracking.net |

Docs: **[deployment guide](docs/aws-deployment-guide.md)** for operating it,
**[maintainer's guide](docs/maintainers-guide.md)** for changing it,
**[implementation brief](docs/aws-port-implementation-prompt.md)** for the design decisions,
**[legacy analysis](docs/aws-lambda-eventbridge-port.md)** for how the GitHub Actions version worked.

## Install the add-in in a MyGeotab database

1. Open **System Settings → Add-Ins** and turn on **Allow unverified Add-Ins**.
2. Click **New Add-In** and paste the contents of [`config.json`](config.json) into **Configuration**.
   If the add-in is already installed, edit the existing entry instead, because MyGeotab rejects a
   second add-in with the same name.
3. Click **Done**, then **Save**, and refresh the browser.

The add-in reads and writes schedules through the Advantage One scheduling service; point it at a
deployment by setting `SERVER_API_BASE` near the top of the add-in's `<script>` block (see the
deployment guide). With that value empty, the add-in falls back to its original behaviour of
running schedules in the browser while a tab is open.

## Release a new version of the add-in

1. Edit the sources, not the built file: schedule logic lives in `src/core/unassign-core.js`, the
   service client in `src/addin/api-client.js`, and the UI in `unassignDrivers.html`. In that last
   file, check that `SERVER_API_BASE` still points at the deployment you mean — it is baked into the
   add-in and currently names the Canada endpoint.
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
(bucket names, state, artifact, outputs). See the [deployment guide](docs/aws-deployment-guide.md).

## Repository map

```
unassignDrivers.html            the add-in; built regions are generated (see below)
config.json                     add-in configuration published to MyGeotab (jsDelivr tag)
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
