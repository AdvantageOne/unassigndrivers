#!/usr/bin/env node
/*
 * git commit-msg gate: a commit that touches gated paths must record who approved it.
 *
 *   git commit --trailer "Dev-Team-Approved-By: <name>"
 *
 * The trailer is the audit trail the pull-request check and CODEOWNERS review read.
 * Merge commits are exempt here (their parents were already gated); pre-push still
 * checks every protected-touching commit in the range it is about to publish.
 */
import { readFileSync } from "node:fs";
import { classify, stagedFiles, trailerRefusal } from "./policy.mjs";

const messagePath = process.argv[2];
const { protected: gated } = classify(stagedFiles());
if (gated.length === 0) process.exit(0);

const message = messagePath ? readFileSync(messagePath, "utf8") : "";
if (/^Dev-Team-Approved-By:[ \t]*\S/m.test(message)) process.exit(0);

process.stderr.write(
  `\n${trailerRefusal(gated, "this branch")}\n\n` +
    `If this is a merge commit, run it through the branch instead; pre-push checks the commits\n` +
    `being published.\n\n`,
);
process.exit(1);
