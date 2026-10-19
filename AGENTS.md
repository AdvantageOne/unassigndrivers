# AGENTS.md — what may change here, and what the gates refuse

Applies to **every** automated and human change in this checkout: Oh My Pi (`omp`), Claude Code,
Codex, Cursor, Copilot, and plain `git`. `CLAUDE.md`, `.omp/AGENTS.md`, and `.omp/RULES.md` point
back here or mirror its hard rules; this file is the single source of truth. The human-facing
operating detail is in [docs/change-gate.md](docs/change-gate.md).

This repository ships two things that must keep agreeing:

| | |
|---|---|
| The add-in (`unassignDrivers.html`) | one HTML file, published to a bucket per region; also loaded from jsDelivr for the standalone install |
| The AWS service | a Lambda per region (Canada `ca-central-1`, US `us-east-2`), EventBridge Scheduler, S3 config/run-log buckets, Secrets Manager, all owned by OpenTofu under `infra/` |

`src/core/unassign-core.js` runs **both** in the browser and inside the Lambda, and `build/inline-core.mjs`
copies it (plus `src/addin/api-client.js`) into the add-in at build time. That is why a change that
looks like "just the screen" can break the service, and why the gates below exist.

## 1. Zones

**Open — anyone may change, including non-technical staff**

- `unassignDrivers.html`, but **only outside** the `/* BUILD:core:begin */ … /* BUILD:core:end */`
  and `/* BUILD:client:begin */ … /* BUILD:client:end */` regions: markup, styles, the UI script.
- `translations/`, `docs/`, `README.md`.

**Gated — dev team only** (the guard's list is `scripts/guard/policy.mjs`, and it refuses the guides
themselves so a refusal cannot be edited away):

`infra/` · `src/` · `build/` · `scripts/` · `test/` · `.github/` · `.githooks/` · `.omp/` ·
`.claude/` · `unassigndrivers-runner/` · `scheduled-unassign.yml` · `package.json` · `pnpm-lock.yaml` ·
`config.json` · `config.ca.json` · `config.us.json` · `config.pages.json` · `AGENTS.md` · `CLAUDE.md`

## 2. Never

- **Never edit inside the BUILD markers** in `unassignDrivers.html`. They are generated from `src/`.
  Edit the source, then `pnpm run build:addin`. The pre-commit hook and `test/addin-build.test.js`
  both refuse a stale or hand-edited region: the page the browser runs would otherwise differ from
  the code the Lambda runs.
- **Never commit to or push `main`/`master`.** Create a branch first; the dev team merges through a
  pull request. Pushing main is refused for every author, including the dev team.
- **Never bypass a gate**: no `git commit --no-verify`, no `git push --no-verify`, no editing
  `scripts/guard/`, `.githooks/`, `.claude/settings.json`, `.omp/hooks/`, or a workflow to get past a
  refusal. If a gate is wrong, say so and let the dev team fix it.
- **Never commit** `.terraform/`, `*.tfstate`, `*.tfplan`, `*.tfvars`, `dist/`, `node_modules/`,
  `.env*`, `*.har`, or `docs/exampleSecurityFilterCheck.txt`. No confirmation lifts this.
- **Never** run `tofu apply`, `tofu destroy`, `terraform apply`, `scripts/deploy.sh`,
  `scripts/onboard-customer.sh`, `scripts/offboard-customer.sh`, or `scripts/seed-test-fleet.sh`
  without the dev-team confirmation in §3 — they mutate live AWS accounts in Canada and the US.
- **Never weaken or delete a test** to make a change pass (`pnpm test` is the safety net for the
  shared core and the Lambda).

## 3. Dev-team confirmation (the only way through a gate)

When a change touches a gated path, stop and ask the user, in these words:

> "This change touches `<paths>`, which controls the AWS side of the app (the Lambda service, its
> OpenTofu infrastructure, or the tooling that deploys them). Are you on the dev team, and do you
> want this change to go ahead?"

Proceed **only** if they answer yes in this conversation. Then use the confirmation in the same
command you were already going to run:

- Environment variable `UNASSIGN_DEV_TEAM=1` — the human's assertion that they are on the dev team.
  It must come from the user: never `export` it on your own initiative, never write it into a file,
  shell profile, or script, and never persist it between commands.
- Commit trailer `Dev-Team-Approved-By: <name>` — records who said yes:

```bash
git commit -m "…" --trailer "Dev-Team-Approved-By: Jordan"
UNASSIGN_DEV_TEAM=1 git commit -m "…" --trailer "Dev-Team-Approved-By: Jordan"   # gated paths staged
```

If the answer is no, or is anything other than a clear yes, do not make the change. Finish the work
that needs no confirmation and report what is blocked and why.

## 4. Check-in procedure (every change, every author)

```bash
git switch -c <type>/<short-slug>      # fix/…, feat/…, docs/… — never work on main
# … make the change …
pnpm test                              # includes: built add-in matches src/
pnpm run build:addin                   # only if you changed src/core or src/addin
git add <the files you changed>
git status                             # confirm nothing state-like or secret is staged
git commit -m "…"                      # gated paths additionally need §3's env var + trailer
git push -u origin <type>/<short-slug> # opens a pull request; never push main
```

Stop at the pushed branch and hand it to the dev team. Do not merge, do not tag, do not run
`scripts/deploy.sh` (it plans and applies OpenTofu as well as publishing the add-in).

## 5. Verifying the open zone

```bash
pnpm test                 # 100+ unit tests, no network, no AWS, no tenant
pnpm run check:addin      # the built add-in matches src/
```

For a UI-only change, these are enough; there is no browser or AWS test to run locally. Do not add
network, AWS, or tenant dependencies to `test/`.

## 6. When a gate refuses

The refusal prints what is wrong and what to do. Treat it as the answer: report it to the user, ask
the question in §3 if the work is gated, and stop. If a refusal looks wrong, quote it to the user
and let the dev team decide — never retry the same action through a different tool, and never edit
the guard.

## 7. Enforcement map (for the dev team)

| Gate | Where | What it enforces |
|---|---|---|
| Agent edit/tool gate | `.claude/settings.json` → `scripts/guard/claude-pre-tool-use.mjs`; `.omp/hooks/pre/guardrails.ts` | refuses gated edits, hook bypasses, main-branch commits/pushes, unconfirmed AWS mutations |
| Git hooks | `.githooks/{pre-commit,commit-msg,pre-push}` (`core.hooksPath`; install with `pnpm run hooks:install`, also run by `pnpm install`) | no commits on main, no gated change without the env var + trailer, add-in matches `src/`, no secrets/state |
| Pull-request check | `.github/workflows/guard.yml` → `scripts/guard/ci-check.mjs` | same rules on the commits in the PR; plus the test suite |
| Review gate | `.github/CODEOWNERS` + branch protection on `main` | dev-team review is required before anything merges |

Local hooks are bypassable (`--no-verify`, a fake environment variable). The gates that cannot be
talked around are CODEOWNERS and branch protection — keep them on for `main`.
