#!/usr/bin/env node
/*
 * Claude Code PreToolUse hook (wired in .claude/settings.json).
 *
 * Reads the hook JSON on stdin and either prints a deny decision or exits 0 silently:
 *
 *   Edit / Write / MultiEdit / NotebookEdit  -> refuses gated paths unless the session was
 *                                               started with UNASSIGN_DEV_TEAM=1
 *   Bash                                     -> refuses hook bypasses, main-branch commits and
 *                                               pushes, unconfirmed AWS mutations, and shell
 *                                               writes into gated paths
 *
 * Denied calls are reported to the model as tool errors, so it must stop and ask the user
 * instead of retrying with another tool. See AGENTS.md.
 */
import { readFileSync } from "node:fs";
import {
  devTeamConfirmed,
  isProtected,
  protectedRefusal,
  reviewBashCommand,
  toRepoRelative,
} from "./policy.mjs";

function deny(reason) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  deny(
    "The repository change gate (scripts/guard/claude-pre-tool-use.mjs) could not read this tool\n" +
      "call. Fix the guard before editing gated paths: ask the dev team to run\n" +
      "`node scripts/guard/claude-pre-tool-use.mjs <<< '{}'` and report the error.",
  );
}

const toolName = payload.tool_name ?? "";
const toolInput = payload.tool_input ?? {};

if (toolName === "Bash") {
  const verdict = reviewBashCommand(toolInput.command);
  if (verdict) deny(verdict.deny);
  process.exit(0);
}

for (const key of ["file_path", "notebook_path", "path", "filePath"]) {
  const raw = toolInput[key];
  if (typeof raw !== "string" || raw.length === 0) continue;
  const relative = toRepoRelative(raw);
  if (!relative || !isProtected(relative)) continue;
  if (devTeamConfirmed()) process.exit(0);
  deny(protectedRefusal([relative], { action: `editing ${relative}` }));
}

process.exit(0);
