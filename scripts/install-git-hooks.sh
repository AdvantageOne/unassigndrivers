#!/usr/bin/env bash
#
# Installs the repository change gate as this checkout's git hooks.
#
# Hooks are not copied into .git/hooks: core.hooksPath points at the committed .githooks/
# directory, so every branch, worktree, and agent session in this clone runs the same
# reviewed hooks. Run by `pnpm install` (via the prepare script) and safe to run by hand.
#
#   scripts/install-git-hooks.sh
#
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "install-git-hooks: not a git work tree, skipping (nothing to install)"
  exit 0
fi

if [ "$(git config --get core.hooksPath || true)" = ".githooks" ]; then
  echo "install-git-hooks: already installed (core.hooksPath=.githooks)"
  exit 0
fi

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/commit-msg .githooks/pre-push 2>/dev/null || true
echo "install-git-hooks: installed (core.hooksPath=.githooks) - commits and pushes now run the change gate"
