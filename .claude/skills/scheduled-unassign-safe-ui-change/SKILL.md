---
name: scheduled-unassign-safe-ui-change
description: Use when changing the Scheduled Driver Unassign add-in's screen, wording, layout, translations, or in-page behaviour (the open zone - unassignDrivers.html outside the BUILD markers, translations/, docs/, README.md), with no dev-team confirmation needed.
---

# Changing the add-in safely (open zone)

The authoritative procedure is `.omp/skills/scheduled-unassign-safe-ui-change/SKILL.md`; read it
before acting. It is the same text Oh My Pi, the git hooks, and Codex work from, so following it here
keeps one rule set for the whole repository.

In short: you may change `unassignDrivers.html` outside the `BUILD:core` / `BUILD:client` markers,
`translations/`, `docs/`, and `README.md`. Everything else is gated (see the root `AGENTS.md`). Branch
with `git switch -c ui/<slug>`, run `pnpm test`, commit, push the branch, and stop — the dev team
reviews and publishes.
