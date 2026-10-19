---
name: scheduled-unassign-dev-team-infra-change
description: Use when a change touches the gated zone of Scheduled Driver Unassign - infra/ (OpenTofu), src/ (Lambda and shared core), build/, scripts/, test/, .github/, .githooks/, .omp/, .claude/, package.json, pnpm-lock.yaml, config*.json, AGENTS.md, CLAUDE.md - and needs the dev-team confirmation, verification, and a branch-based check-in.
---

# Changing the service (gated zone)

The authoritative procedure is `.omp/skills/scheduled-unassign-dev-team-infra-change/SKILL.md`; read
it before acting. It carries the exact question to ask the user, the confirmation commands
(`UNASSIGN_DEV_TEAM=1`, `--trailer "Dev-Team-Approved-By: <name>"`), the `pnpm run build:addin` rule
for `src/core/`, and the check-in sequence.

Hard points, also enforced by `.claude/settings.json`, `.githooks/`, and the pull-request check: no
work on `main`, no `--no-verify`, no gated path without an explicit yes from the user, no deploy or
`tofu apply` without the same confirmation, and no editing of the guard itself.
