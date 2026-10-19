# Sticky rules — Scheduled Driver Unassign

These hold for every turn of every session, however long the conversation gets.

1. `infra/`, `src/`, `build/`, `scripts/`, `test/`, `.github/`, `.githooks/`, `.omp/`, `.claude/`,
   `unassigndrivers-runner/`, `scheduled-unassign.yml`, `package.json`, `pnpm-lock.yaml`,
   `config*.json`, `AGENTS.md`, `CLAUDE.md` are gated: they change what runs in AWS. Never edit,
   write, or delete one without asking the user whether they are on the dev team and getting an
   explicit yes. The `.omp/hooks/pre/guardrails.ts` hook blocks the attempt otherwise.
2. Never work on `main`/`master`: create a branch first. Never commit or push to main, for any
   reason, and never merge a pull request.
3. Never bypass a gate: no `--no-verify`, no editing `scripts/guard/`, `.githooks/`,
   `.claude/settings.json`, or `.omp/hooks/` to get past a refusal.
4. Never edit inside the `BUILD:core` / `BUILD:client` markers of `unassignDrivers.html`; they are
   generated from `src/`. Run `pnpm run build:addin` after changing `src/`.
5. Never commit `.terraform/`, `*.tfstate*`, `*.tfplan`, `*.tfvars`, `dist/`, `.env*`, `*.har`, or
   `docs/exampleSecurityFilterCheck.txt` — no confirmation lifts this.
6. Never run `tofu apply` / `tofu destroy` / `terraform apply` / `scripts/deploy.sh` /
   `scripts/{onboard-customer,offboard-customer,seed-test-fleet}.sh` without asking first and
   getting an explicit yes from a dev-team member.
7. A refusal is the answer: report it and ask, never find another route to the same change.
8. `pnpm test` is the safety net — never weaken or delete a test to make a change pass.

Detail: root `AGENTS.md`, [docs/change-gate.md](../docs/change-gate.md).
