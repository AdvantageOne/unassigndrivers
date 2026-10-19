# CLAUDE.md

@AGENTS.md

## This project is gated — read this before your first edit

`.claude/settings.json` runs `scripts/guard/claude-pre-tool-use.mjs` before every `Edit`, `Write`,
`MultiEdit`, `NotebookEdit`, and `Bash` call. It is not advisory: a denied call is blocked and the
reason comes back to you as a tool error.

Denied, always:

- editing or writing `infra/`, `src/`, `build/`, `scripts/`, `test/`, `.github/`, `.githooks/`,
  `.omp/`, `.claude/`, `unassigndrivers-runner/`, `scheduled-unassign.yml`, `package.json`,
  `pnpm-lock.yaml`, `config*.json`, `AGENTS.md`, `CLAUDE.md` — unless the session was started with
  `UNASSIGN_DEV_TEAM=1` by the user
- `git commit` or `git push` on `main`/`master` (branch first: `git switch -c <type>/<slug>`)
- `git push` that names `main` or `master`, and any use of `--no-verify`
- committing gated paths without `UNASSIGN_DEV_TEAM=1` **and**
  `--trailer "Dev-Team-Approved-By: <name>"`
- `tofu apply` / `tofu destroy` / `terraform apply` / `scripts/deploy.sh` / the onboard, offboard,
  and seed scripts without `UNASSIGN_DEV_TEAM=1`

When a call is denied: **do not retry it with another tool, another path spelling, or a shell
workaround.** Ask the user the question printed in the refusal (AGENTS.md §3), act on their answer,
and if the answer is no, report the blocked work instead of finding a way around the gate.

Allowed without asking: `unassignDrivers.html` outside the `BUILD:core` / `BUILD:client` markers,
`translations/`, `docs/`, `README.md`, `pnpm test`, `pnpm run check:addin`.
