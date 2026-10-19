#!/usr/bin/env node
/*
 * Pull-request / push backstop (.github/workflows/guard.yml).
 *
 * Compares the head against the base commit and fails when:
 *   - a never-committable path (state, build output, secrets) is in the diff
 *   - a commit touching gated paths has no "Dev-Team-Approved-By" trailer
 *
 * Local hooks can be bypassed with --no-verify or by an agent that sets the confirmation
 * environment variable itself. This job and CODEOWNERS are the gates that cannot be.
 *
 * Base commit comes from GUARD_BASE_SHA (or argv[2]).
 */
import {
  classify,
  commitFiles,
  commitSubject,
  commitTrailer,
  gateIntroducedAt,
  git,
  isAncestorOf,
  splitNul,
} from "./policy.mjs";

const base = (process.env.GUARD_BASE_SHA || process.argv[2] || "").trim();
const failures = [];

function fail(message) {
  failures.push(message);
}

function commitExists(rev) {
  try {
    return git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).trim().length > 0;
  } catch {
    return false;
  }
}

function resolveBase() {
  if (base && !/^0+$/.test(base) && commitExists(base)) return base;
  const parent = git(["rev-parse", "--verify", "HEAD^"], { allowFailure: true }).trim();
  if (!parent) {
    process.stdout.write(`no usable base commit (${base || "empty"}); skipping the diff checks\n`);
    process.exit(0);
  }
  return parent;
}

const head = git(["rev-parse", "HEAD"]).trim();
const from = resolveBase();

// Three-dot: only what this branch introduced, so a base branch that moved ahead with its
// own gated change does not fail an unrelated pull request.
let changed = splitNul(git(["diff", "--name-only", "-z", `${from}...${head}`], { allowFailure: true }));
if (changed.length === 0) {
  changed = splitNul(git(["diff", "--name-only", "-z", from, head], { allowFailure: true }));
}

const { protected: gated, forbidden } = classify([...new Set(changed)]);

if (forbidden.length > 0) {
  fail(
    `never-committable paths in this change:\n` +
      forbidden.map(({ path, why }) => `  - ${path} (${why})`).join("\n"),
  );
}

const commits = splitNul(git(["rev-list", "-z", `${from}..${head}`], { allowFailure: true }));
const gateIntroduction = gateIntroducedAt();
const unapproved = [];
let exempted = 0;
for (const sha of commits) {
  // History that predates the gate cannot carry its trailer; the gate's own commit is exempt too.
  if (gateIntroduction && isAncestorOf(sha, gateIntroduction)) {
    exempted++;
    continue;
  }
  const { protected: files } = classify(commitFiles(sha));
  if (files.length === 0) continue;
  if (commitTrailer(sha)) continue;
  unapproved.push({ sha, subject: commitSubject(sha), files });
}

if (unapproved.length > 0) {
  fail(
    `gated paths changed without a dev-team approval trailer:\n\n` +
      unapproved
        .map(
          ({ sha, subject, files }) =>
            `  ${sha.slice(0, 12)}  ${subject}\n` +
            files.map((file) => `      - ${file}`).join("\n"),
        )
        .join("\n") +
      `\n\nRecord the confirmation the dev team gave:\n` +
      `  git commit --amend --trailer "Dev-Team-Approved-By: <name>"   # or --trailer on the commit\n`,
  );
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.join("\n\n")}\n\nSee AGENTS.md and docs/change-gate.md.\n\n`);
  process.exit(1);
}

process.stdout.write(
  `change gate: ${changed.length} file(s) vs ${from.slice(0, 12)}, ` +
    `${gated.length} gated, ${commits.length} commit(s) checked, ${exempted} pre-gate commit(s) exempt - ok\n`,
);
process.exit(0);
