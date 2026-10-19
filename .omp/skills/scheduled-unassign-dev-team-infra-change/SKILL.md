---
name: scheduled-unassign-dev-team-infra-change
description: Use when a change touches the gated zone of Scheduled Driver Unassign - infra/ (OpenTofu), src/ (Lambda and shared core), build/, scripts/ (deploy, onboard, offboard, seed), test/, .github/, .githooks/, .omp/, .claude/, package.json, pnpm-lock.yaml, config*.json, AGENTS.md, CLAUDE.md. Covers getting the dev-team confirmation, keeping the add-in and Lambda in step, verifying, and checking in without touching main.
---

# Changing the service (gated zone)

Everything in the gated zone changes what runs in AWS, how it is deployed, or the gate itself.
`scripts/guard/policy.mjs` holds the list; the git hooks, the Claude Code hook, and the Oh My Pi hook
all read it.

## 1. Get the confirmation first

Ask the user, in these words (never set the confirmation yourself, never persist it in a file):

> "This change touches `<paths>`, which controls the AWS side of the app (the Lambda service, its
> OpenTofu infrastructure, or the tooling that deploys them). Are you on the dev team, and do you
> want this change to go ahead?"

Proceed only on an explicit yes. Gated actions then run as:

```bash
UNASSIGN_DEV_TEAM=1 <the same command>
git commit -m "…" --trailer "Dev-Team-Approved-By: <their name>"
```

## 2. Keep the two copies in step

`src/core/unassign-core.js` runs in the browser **and** in the Lambda; `build/inline-core.mjs` copies
it into the add-in's BUILD regions. After touching `src/core/` or `src/addin/`:

```bash
pnpm run build:addin      # regenerate unassignDrivers.html
pnpm test                 # fails if the built copy is stale
```

Never hand-edit inside the markers: the pre-commit hook refuses it, and the pages the tenants load
would otherwise drift from the code the Lambda runs.

## 3. Verify

```bash
pnpm test                     # unit tests, no network/AWS/tenant; includes the add-in sync check
node build/inline-core.mjs --check
```

Read-only infrastructure work needs no confirmation:

```bash
tofu -chdir=infra/live/ca validate      # and us
tofu -chdir=infra/live/ca plan          # plans, applies nothing
```

Plan alone is not proof. A change to the Lambda's behaviour, IAM, or the scheduler needs a real run
in a test database — `scripts/seed-test-fleet.sh` and the health action exist for that, and both are
gated actions requiring the confirmation from §1.

## 4. Repo-specific traps

`docs/maintainers-guide.md` §7 lists nineteen of them; they are not restated here. The ones that
break a Lambda change most often: 18 (the 48 KiB local-archive ceiling — deploys go from S3),
12 (CORS belongs to the Function URL; `allow_methods` has a six-character limit), 2 (`RetryPolicy`
and `DeadLetterConfig` live inside `Target`), 13 (the unlicensed sentence lives in three places and a
test catches drift), 16 (offline green does not cover the call site — assert on the caller).

## 5. Check in

```bash
git switch -c <type>/<short-slug>        # never work on main
git add <files>
git status                               # no .tfstate, no dist/, no .env*
UNASSIGN_DEV_TEAM=1 git commit -m "…" --trailer "Dev-Team-Approved-By: <name>"
UNASSIGN_DEV_TEAM=1 git push -u origin <type>/<short-slug>
```

Then stop and hand the branch to the dev team: they review, merge, and run `scripts/deploy.sh`.
Never push `main`, never merge, never tag (jsDelivr caches a tag permanently), never run a deploy
without the §1 confirmation, and never use `--no-verify` — if a hook is wrong, fix the hook on the
branch as a gated change.

## 6. If a gate refuses

Report the refusal verbatim, ask §1's question if the work is gated, and stop. Do not retry the same
action through another tool, and do not edit `scripts/guard/`, `.githooks/`, `.claude/settings.json`,
or `.omp/hooks/` to get past it.
