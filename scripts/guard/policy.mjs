/*
 * Scheduled Driver Unassign - change gate policy
 * AdvantageOne
 *
 * One source of truth for "what may break the AWS side of this app". Every gate in
 * the repository imports this module instead of restating the rules:
 *
 *   .githooks/pre-commit, commit-msg, pre-push   -> the durable gate (works for any
 *                                                   agent, editor, or human using git)
 *   scripts/guard/claude-pre-tool-use.mjs        -> Claude Code PreToolUse hook
 *   .omp/hooks/pre/guardrails.ts                 -> Oh My Pi tool_call hook
 *   scripts/guard/ci-check.mjs                   -> the pull-request backstop
 *
 * Two zones:
 *
 *   OPEN     unassignDrivers.html (outside the BUILD markers), translations/, docs/,
 *            README.md - anyone, including non-technical staff.
 *   GATED    everything that can change what runs in AWS, how it is deployed, or the
 *            guard itself. Requires the dev-team confirmation below.
 *
 * The confirmation is the environment variable UNASSIGN_DEV_TEAM=1 (the human's
 * assertion that they are on the dev team) plus, for commits, a
 * "Dev-Team-Approved-By: <name>" trailer that records who said so in the history.
 * No gate prompts interactively: a prompt would hang agents and CI, and an
 * unanswerable prompt fails open, which is worse than an explicit switch.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path with symlinks resolved (`/tmp` -> `/private/tmp` on macOS, a symlinked home
 * directory, a linked worktree). Agent tools and git report paths in whichever spelling the
 * caller used, so every comparison has to happen on the real path or gated files slip through.
 */
function canonicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    // The file may not exist yet (a new file): canonicalise its directory instead.
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export const REPO_ROOT = canonicalPath(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));

/** Directories (trailing "/") and files the dev team owns. */
export const PROTECTED_PATHS = [
  // Infrastructure as code and the service itself.
  "infra/", // OpenTofu: module + one root per region
  "src/", // Lambda handler/actions/libs, shared core, add-in service client
  "build/", // inlines src/ into the add-in; a change here changes both copies
  // Deployment + operations tooling that mutates AWS.
  "scripts/",
  "unassigndrivers-runner/", // legacy GitHub Actions runner (unassigns drivers with stored secrets)
  "scheduled-unassign.yml", // legacy trigger workflow
  // The safety net itself.
  "test/",
  ".github/", // workflows + CODEOWNERS
  ".githooks/",
  ".omp/", // agent rules, hooks, skills
  ".claude/", // agent rules + PreToolUse hooks
  "AGENTS.md",
  "CLAUDE.md",
  // Build/test pins and published add-in configuration (region endpoints, release tag).
  "package.json",
  "pnpm-lock.yaml",
  "config.json",
  "config.ca.json",
  "config.us.json",
  "config.pages.json",
];

/** Paths that are never committable, regardless of who the author is. */
export const FORBIDDEN_PATTERNS = [
  { test: /(^|\/)\.terraform\//, why: "OpenTofu provider/state cache" },
  { test: /\.tfstate(\.|$)/, why: "Terraform/OpenTofu state (contains resource IDs and secrets)" },
  { test: /\.tfplan$/, why: "saved plan" },
  { test: /(^|\/)terraform\.tfvars$/, why: "variable values" },
  { test: /\.auto\.tfvars$/, why: "variable values" },
  { test: /^dist\//, why: "built Lambda artifact (built by scripts/deploy.sh)" },
  { test: /(^|\/)node_modules\//, why: "dependencies" },
  { test: /(^|\/)\.env(\.|$)/, why: "local secrets" },
  { test: /\.har$/, why: "captured browser trace (live session, customer database, identities)" },
  { test: /^docs\/exampleSecurityFilterCheck\.txt$/, why: "captured session trace" },
  { test: /(^|\/)\.DS_Store$/, why: "OS noise" },
];

export const MAIN_BRANCHES = ["main", "master"];

/** The question to put to the user, verbatim, before touching a gated path. */
export const DEV_TEAM_QUESTION =
  "This change touches {{paths}}, which controls the AWS side of the app (the Lambda service, its " +
  "OpenTofu infrastructure, or the tooling that deploys them). Are you on the dev team, and do you " +
  "want this change to go ahead?";

export function normalizePath(path) {
  return String(path)
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

/**
 * Repository-relative form of an absolute path, or null when the path is outside this
 * checkout (agent tools deliver absolute paths; `/repo/../elsewhere` must not be gated).
 */
export function toRepoRelative(path) {
  const absolute = canonicalPath(String(path));
  const root = REPO_ROOT.endsWith("/") ? REPO_ROOT : `${REPO_ROOT}/`;
  return absolute.startsWith(root) ? absolute.slice(root.length) : null;
}

/** Is this repository-relative path owned by the dev team? */
export function isProtected(path) {
  const rel = normalizePath(path);
  return PROTECTED_PATHS.some((entry) =>
    entry.endsWith("/") ? rel === entry.slice(0, -1) || rel.startsWith(entry) : rel === entry,
  );
}

/** Why this path must never be committed, or null when it is committable. */
export function forbiddenReason(path) {
  const rel = normalizePath(path);
  const hit = FORBIDDEN_PATTERNS.find((pattern) => pattern.test.test(rel));
  return hit ? hit.why : null;
}

export function classify(files) {
  const protectedFiles = [];
  const forbiddenFiles = [];
  for (const file of files) {
    const rel = normalizePath(file);
    if (!rel) continue;
    const why = forbiddenReason(rel);
    if (why) forbiddenFiles.push({ path: rel, why });
    else if (isProtected(rel)) protectedFiles.push(rel);
  }
  return { protected: protectedFiles, forbidden: forbiddenFiles };
}

/** True when a human has asserted dev-team membership for this shell/session. */
export function devTeamConfirmed(env = process.env) {
  return env.UNASSIGN_DEV_TEAM === "1";
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

export function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (allowFailure) return "";
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

export function splitNul(output) {
  return output.split("\0").filter((entry) => entry.length > 0);
}

/** Files staged for the commit being made right now. */
export function stagedFiles() {
  return splitNul(
    git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRD"], { allowFailure: true }),
  );
}

/** Files carried by one commit. */
export function commitFiles(sha) {
  return splitNul(
    git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sha], { allowFailure: true }),
  );
}

export function branchOf(sha = "HEAD") {
  const direct = git(["symbolic-ref", "--quiet", "--short", sha], { allowFailure: true }).trim();
  if (direct) return direct;
  return git(["rev-parse", "--abbrev-ref", sha], { allowFailure: true }).trim() || null;
}

export function isMainBranch(branch) {
  return Boolean(branch) && MAIN_BRANCHES.includes(branch);
}

export function commitTrailer(sha, key = "Dev-Team-Approved-By") {
  return git(["log", "-1", `--format=%(trailers:key=${key},valueonly)`, sha], {
    allowFailure: true,
  }).trim();
}

export function commitSubject(sha) {
  return git(["log", "-1", "--format=%s", sha], { allowFailure: true }).trim();
}

let gateIntroduction;

/**
 * The commit that introduced the gate (the first commit adding scripts/guard/policy.mjs), or
 * null when the gate is not committed yet. History that predates the gate cannot carry a
 * trailer, so the commit checks exempt it; everything after it is held to the rule.
 */
export function gateIntroducedAt() {
  if (gateIntroduction !== undefined) return gateIntroduction;
  const commits = git(["log", "--diff-filter=A", "--format=%H", "--", "scripts/guard/policy.mjs"], {
    allowFailure: true,
  })
    .split("\n")
    .filter(Boolean);
  gateIntroduction = commits.length > 0 ? commits[commits.length - 1] : null;
  return gateIntroduction;
}

/** Is `sha` at or before `ref` (so it predates it)? */
export function isAncestorOf(sha, ref) {
  try {
    git(["merge-base", "--is-ancestor", sha, ref]);
    return true;
  } catch {
    return false;
  }
}

/** Commits reachable from `head` that are not already on any remote (new-branch pushes). */
export function commitsNotOnRemotes(head) {
  const listed = splitNul(
    git(["rev-list", "-z", head, "--not", "--remotes"], { allowFailure: true }),
  );
  return listed.length > 0 ? listed : splitNul(git(["rev-list", "-z", head], { allowFailure: true }));
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------

const ZONE_NOTE =
  "Allowed without a dev-team confirmation: unassignDrivers.html (outside the BUILD markers),\n" +
  "translations/, docs/, README.md.";

export function protectedRefusal(files, { action = "this change" } = {}) {
  const list = files.slice(0, 12).map((file) => `  - ${file}`).join("\n");
  const more = files.length > 12 ? `\n  ...and ${files.length - 12} more` : "";
  return (
    `Refusing ${action}: it touches gated paths that control the AWS side of the app.\n\n` +
    `${list}${more}\n\n` +
    `${ZONE_NOTE}\n\n` +
    `What to do: stop and ask the user\n\n  "${DEV_TEAM_QUESTION.replace("{{paths}}", "<the paths above>").replace("\n", " ")}"\n\n` +
    `Only if they answer yes in this conversation, re-run the gated action with the confirmation:\n` +
    `  UNASSIGN_DEV_TEAM=1 <the same command>\n` +
    `and, for commits, add the trailer that records who confirmed:\n` +
    `  --trailer "Dev-Team-Approved-By: <their name>"\n\n` +
    `Never bypass a gate (no --no-verify, no editing scripts/guard, .githooks, .omp/hooks, or\n` +
    `.claude/settings.json). See AGENTS.md and docs/change-gate.md.`
  );
}

export function forbiddenRefusal(files) {
  const list = files.map(({ path, why }) => `  - ${path} (${why})`).join("\n");
  return (
    `Refusing this commit: these paths must never be committed.\n\n${list}\n\n` +
    `They are local state, build output, or captured secrets. Remove them from the index:\n` +
    `  git restore --staged <path>\n` +
    `There is no override for this check.`
  );
}

export function mainBranchRefusal({ action, branch }) {
  return (
    `Refusing to ${action} on "${branch}": all work happens on a branch, never on main.\n\n` +
    `  git switch -c <type>/<short-slug>     # e.g. fix/run-log-timezone\n` +
    `then re-run the same command. Pushing main is refused for every author; the dev team merges\n` +
    `through a pull request.`
  );
}

export function trailerRefusal(files, branch) {
  const list = files.slice(0, 12).map((file) => `  - ${file}`).join("\n");
  return (
    `Refusing this commit: it touches gated paths but carries no dev-team approval trailer.\n\n` +
    `${list}\n\n` +
    `Amend it with who confirmed:\n` +
    `  git commit --amend --trailer "Dev-Team-Approved-By: <their name>"\n` +
    `(or add --trailer to the original commit command), on branch "${branch}". The trailer is what\n` +
    `the pull-request check and the dev team's review read. See AGENTS.md.`
  );
}

export function noVerifyRefusal() {
  return (
    `Refusing a hook bypass (--no-verify). The hooks are the change gate for the AWS side of this\n` +
    `app. If a hook is wrong, ask the dev team to fix scripts/guard; do not route around it.`
  );
}

export function infraCommandRefusal(command, label = "this command") {
  return (
    `Refusing ${label} without a dev-team confirmation:\n\n  ${command}\n\n` +
    `Ask the user: "${DEV_TEAM_QUESTION.replace("{{paths}}", "the AWS infrastructure")}"\n` +
    `Only if they answer yes, re-run it as:\n  UNASSIGN_DEV_TEAM=1 <the same command>\n\n` +
    `Read-only work (aws ... describe/list, tofu plan without -out, tofu validate, pnpm test) needs\n` +
    `no confirmation.`
  );
}

// ---------------------------------------------------------------------------
// shell command policy (shared by the Claude Code Bash hook and the omp hook)
// ---------------------------------------------------------------------------

const AWS_MUTATIONS = [
  { test: /\btofu\b[^|;&\n]*\bapply\b/, label: "tofu apply" },
  { test: /\btofu\b[^|;&\n]*\bdestroy\b/, label: "tofu destroy" },
  { test: /\btofu\b[^|;&\n]*\bplan\b[^|;&\n]*\s-destroy\b/, label: "tofu plan -destroy" },
  { test: /\bterraform\b[^|;&\n]*\bapply\b/, label: "terraform apply" },
  { test: /\bterraform\b[^|;&\n]*\bdestroy\b/, label: "terraform destroy" },
  {
    test: /scripts\/(deploy|onboard-customer|offboard-customer|seed-test-fleet)\.sh/,
    label: "a deploy/onboarding script",
  },
  // Direct AWS CLI mutations, for when a caller skips the scripts. Read-only calls
  // (describe/list/get, s3 ls) are always allowed.
  {
    test: /\baws\b[^|;&\n]*\s(s3\s+(rm|mv|cp|sync|put-object)|lambda\s+(update|create|delete)|scheduler\s+(create|update|delete)|secretsmanager\s+(put|create|update|delete)|iam\s+(create|put|attach|delete)|cloudformation\s+(create|update|delete)|events\s+put-)/,
    label: "an AWS CLI mutation",
  },
];

const PATH_MUTATORS = /(>>?\s*|(^|\s)tee\s+|(^|\s)sed\s+-i|(^|\s)perl\s+-i|(^|\s)rm\s+|(^|\s)mv\s+|(^|\s)cp\s+|(^|\s)truncate\s+|(^|\s)patch\s+|(^|\s)dd\s+)/;

function mentionsProtectedPath(command) {
  const directories = PROTECTED_PATHS.filter((entry) => entry.endsWith("/"));
  const files = PROTECTED_PATHS.filter((entry) => !entry.endsWith("/"));
  if (directories.some((dir) => command.includes(dir))) return true;
  return files.some((file) =>
    new RegExp(`(^|[\\s"'])/?${file.replaceAll(".", "\\.")}([\\s"']|$)`).test(command),
  );
}

function hasApprovalTrailer(command) {
  return /--trailer[=\s]+["']?Dev-Team-Approved-By:/i.test(command);
}

/**
 * Decide whether a shell command must be refused. Returns { deny: string } or null.
 * Deliberately narrow: this is a policy for the model's shell, not a sandbox. The git
 * hooks and the pull-request check are the enforcement that a determined caller cannot
 * talk its way past.
 */
export function reviewBashCommand(command, { branch = null, staged = null } = {}) {
  const cmd = String(command ?? "");
  if (!cmd.trim()) return null;

  if (/--no-verify\b/.test(cmd)) return { deny: noVerifyRefusal() };

  const isCommit = /(^|[;&|(\s])git\s+(-[^\s]+\s+)*commit\b/.test(cmd);
  const isPush = /(^|[;&|(\s])git\s+(-[^\s]+\s+)*push\b/.test(cmd);
  const currentBranch = branch ?? branchOf("HEAD");

  if (isPush && /(^|[\s:])(main|master)([\s:]|$)/.test(cmd)) {
    return {
      deny:
        mainBranchRefusal({ action: "push", branch: "main" }) +
        "\n\nPush your branch and open a pull request instead.",
    };
  }
  if ((isCommit || isPush) && isMainBranch(currentBranch)) {
    return { deny: mainBranchRefusal({ action: isPush ? "push" : "commit", branch: currentBranch }) };
  }

  if (isCommit) {
    const files = staged ?? stagedFiles();
    const { protected: gated } = classify(files);
    if (gated.length > 0) {
      if (!devTeamConfirmed()) return { deny: protectedRefusal(gated, { action: "this commit" }) };
      if (!hasApprovalTrailer(cmd)) {
        return {
          deny:
            `Dev-team mode is on, but this commit touches gated paths and has no approval trailer.\n\n` +
            gated.slice(0, 12).map((file) => `  - ${file}`).join("\n") +
            `\n\nAdd it:\n  UNASSIGN_DEV_TEAM=1 git commit ... --trailer "Dev-Team-Approved-By: <their name>"`,
        };
      }
    }
  }

  const mutation = AWS_MUTATIONS.find((entry) => entry.test.test(cmd));
  if (mutation && !devTeamConfirmed()) {
    return { deny: infraCommandRefusal(cmd, mutation.label) };
  }

  if (!devTeamConfirmed() && PATH_MUTATORS.test(cmd) && mentionsProtectedPath(cmd)) {
    return {
      deny:
        `Refusing a shell write into a gated path:\n\n  ${cmd}\n\n` +
        `Use the editor tools on open files, or ask the user whether they are on the dev team before\n` +
        `this change goes ahead. See AGENTS.md.`,
    };
  }

  return null;
}
