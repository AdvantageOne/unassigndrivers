#!/usr/bin/env node
/*
 * git pre-push gate. Reads the ref lines git writes to stdin:
 *
 *   <local ref> <local sha> <remote ref> <remote sha>
 *
 * Refuses:
 *   - any push to main/master, for every author (dev team merges through a pull request)
 *   - publishing a commit that touches gated paths without a "Dev-Team-Approved-By" trailer
 *
 * This is the last local gate before a change leaves the machine; the pull-request check
 * (.github/workflows/guard.yml) and CODEOWNERS are the ones that cannot be bypassed.
 */
import { readFileSync } from "node:fs";
import {
  MAIN_BRANCHES,
  classify,
  commitFiles,
  commitSubject,
  commitTrailer,
  commitsNotOnRemotes,
  gateIntroducedAt,
  git,
  isAncestorOf,
  isMainBranch,
  mainBranchRefusal,
  splitNul,
} from "./policy.mjs";

const ZERO_SHA = /^0+$/;

function fail(message) {
  process.stderr.write(`\n${message}\n\n`);
  process.exit(1);
}

function commitsInRange(localSha, remoteSha) {
  if (ZERO_SHA.test(remoteSha)) return commitsNotOnRemotes(localSha);
  return splitNul(git(["rev-list", "-z", `${remoteSha}..${localSha}`], { allowFailure: true }));
}

const lines = readFileSync(0, "utf8").split("\n").filter((line) => line.trim().length > 0);
if (lines.length === 0) process.exit(0);

const published = [];
for (const line of lines) {
  const [localRef, localSha, remoteRef, remoteSha] = line.split(" ");
  if (ZERO_SHA.test(localSha)) continue; // branch or tag deletion

  if (remoteRef.startsWith("refs/heads/")) {
    const branch = remoteRef.slice("refs/heads/".length);
    if (MAIN_BRANCHES.includes(branch)) {
      fail(
        `${mainBranchRefusal({ action: "push", branch })}\n` +
          `Push your branch and open a pull request; the dev team merges it. This refusal has no\n` +
          `override, for any author.`,
      );
    }
  }

  const gateIntroduction = gateIntroducedAt();
  for (const sha of commitsInRange(localSha, remoteSha)) {
    if (gateIntroduction && isAncestorOf(sha, gateIntroduction)) continue;
    const { protected: gated } = classify(commitFiles(sha));
    if (gated.length === 0) continue;
    const trailer = commitTrailer(sha);
    if (trailer) {
      published.push({ sha, trailer, gated });
      continue;
    }
    fail(
      `Refusing this push (${localRef} -> ${remoteRef}): commit ${sha.slice(0, 12)} touches gated\n` +
        `paths and carries no dev-team approval trailer.\n\n` +
        `  ${sha.slice(0, 12)}  ${commitSubject(sha)}\n` +
        gated.slice(0, 12).map((file) => `      - ${file}`).join("\n") +
        `\n\nAsk the user whether they are on the dev team (see AGENTS.md), then record the answer:\n\n` +
        `  git rebase --exec 'git commit --amend --no-edit --trailer "Dev-Team-Approved-By: <name>"' <base>\n` +
        `  # or, for a single commit:  git commit --amend --trailer "Dev-Team-Approved-By: <name>"\n`,
    );
  }
}

if (published.length > 0) {
  process.stderr.write(
    `publishing ${published.length} dev-team approved commit(s):\n` +
      published
        .map(({ sha, trailer, gated }) => `  ${sha.slice(0, 12)}  ${trailer}  (${gated.length} gated file(s))`)
        .join("\n") +
      "\n\n",
  );
}

process.exit(0);
