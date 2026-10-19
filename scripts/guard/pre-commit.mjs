#!/usr/bin/env node
/*
 * git pre-commit gate. Installed by `pnpm run hooks:install` (core.hooksPath=.githooks).
 *
 * Refuses:
 *   - any commit while HEAD is main/master
 *   - state, build output, or secrets staged for commit (no override)
 *   - staged gated paths without UNASSIGN_DEV_TEAM=1
 *   - an add-in whose BUILD regions no longer match src/ (run pnpm run build:addin)
 */
import { execFileSync } from "node:child_process";
import {
  REPO_ROOT,
  branchOf,
  classify,
  devTeamConfirmed,
  forbiddenRefusal,
  git,
  isMainBranch,
  mainBranchRefusal,
  protectedRefusal,
  stagedFiles,
} from "./policy.mjs";

function fail(message) {
  process.stderr.write(`\n${message}\n\n`);
  process.exit(1);
}

const branch = branchOf("HEAD");
if (isMainBranch(branch)) fail(mainBranchRefusal({ action: "commit", branch }));

const staged = stagedFiles();
const { protected: gated, forbidden } = classify(staged);

if (forbidden.length > 0) fail(forbiddenRefusal(forbidden));

if (gated.length > 0 && !devTeamConfirmed()) {
  fail(protectedRefusal(gated, { action: "this commit" }));
}

// The page the browser runs and the code the Lambda runs are generated from one source.
// A stale or hand-edited BUILD region breaks that guarantee, so refuse the commit and
// let the author regenerate. test/addin-build.test.js enforces the same invariant in CI.
if (staged.some((file) => file === "unassignDrivers.html" || file.startsWith("src/"))) {
  try {
    execFileSync(process.execPath, ["build/inline-core.mjs", "--check", "--quiet"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || "the add-in does not match src/";
    fail(
      `Refusing this commit: ${detail}\n\n` +
        `The BUILD:core / BUILD:client regions of unassignDrivers.html are generated from src/ and\n` +
        `must ship byte-identical to what the Lambda runs. Regenerate and stage the result:\n\n` +
        `  pnpm run build:addin\n` +
        `  git add unassignDrivers.html\n\n` +
        `Never hand-edit inside the markers (docs/maintainers-guide.md section 2).`,
    );
  }
}

// Surface the confirmation in the commit so the human sees exactly what was asserted.
if (gated.length > 0) {
  process.stderr.write(
    `dev-team mode: committing ${gated.length} gated file(s):\n` +
      gated.map((file) => `  - ${file}`).join("\n") +
      `\nRemember the approval trailer: --trailer "Dev-Team-Approved-By: <name>"\n\n`,
  );
}

process.exit(0);
