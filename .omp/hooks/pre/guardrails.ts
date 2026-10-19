/*
 * Oh My Pi pre-tool hook: the repository change gate for this session.
 *
 *   .omp/hooks/pre/guardrails.ts   (discovered as an extension factory by the native provider)
 *
 * Refuses, before the tool runs:
 *   - bash: hook bypasses (--no-verify), commits/pushes on main, git pushes that name main,
 *           unconfirmed AWS mutations (tofu apply, deploy.sh, ...), shell writes into gated paths
 *   - edit/write/ast_edit and friends: gated paths, unless the user started the session with
 *           UNASSIGN_DEV_TEAM=1 (their assertion that they are on the dev team)
 *
 * The policy lives in scripts/guard/policy.mjs so the git hooks, the Claude Code hook, and the
 * pull-request check enforce exactly the same list. See AGENTS.md and the skill
 * "scheduled-unassign-dev-team-infra-change".
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  devTeamConfirmed,
  isProtected,
  protectedRefusal,
  reviewBashCommand,
  toRepoRelative,
} from "../../../scripts/guard/policy.mjs";

/** Tools whose arguments name files they are about to create or change. */
const WRITING_TOOLS: Record<string, true> = {
  edit: true,
  write: true,
  ast_edit: true,
  multi_edit: true,
  multiedit: true,
  notebook_edit: true,
  apply_patch: true,
};

const PATH_ARGUMENTS = ["path", "file_path", "filePath", "notebook_path", "paths", "files"];

/** The path a path-argument entry names, whether it is a string or a { path } record. */
function pathOf(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object" && "path" in entry && typeof entry.path === "string") {
    return entry.path;
  }
  return null;
}

function namedPaths(input: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const key of PATH_ARGUMENTS) {
    const value = input[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const path = pathOf(entry);
        if (path) found.push(path);
      }
      continue;
    }
    const path = pathOf(value);
    if (path) found.push(path);
  }
  return found;
}

export default function guardrails(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    const tool = String(event.toolName ?? "").toLowerCase();
    // Tool inputs arrive as untyped JSON from the model; the object check is the only shape
    // guarantee available, so the record cast stands on its own line for inspection.
    const input: Record<string, unknown> =
      event.input !== null && typeof event.input === "object"
        ? (event.input as Record<string, unknown>)
        : {};

    if (tool === "bash" || tool === "shell") {
      const verdict = reviewBashCommand(String(input.command ?? ""));
      if (verdict?.deny) return { block: true, reason: verdict.deny };
      return undefined;
    }

    if (!WRITING_TOOLS[tool] || devTeamConfirmed()) return undefined;

    const gated: string[] = [];
    for (const named of namedPaths(input)) {
      const relative = toRepoRelative(named);
      if (relative === null || !isProtected(relative) || gated.includes(relative)) continue;
      gated.push(relative);
    }
    if (gated.length === 0) return undefined;

    return {
      block: true,
      reason: protectedRefusal(gated, { action: `${tool} on ${gated.join(", ")}` }),
    };
  });
}
