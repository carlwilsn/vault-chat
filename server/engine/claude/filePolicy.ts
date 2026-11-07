// vault-chat's one path policy, over Claude Code's own file tools.
//
// Today those tools are pi's: server/mcp/filesystem.ts loads pi's core tools for
// read/write/edit, so no pi install means no file tools. Letting Claude Code use
// its own instead is what frees vault-chat of pi — but only if the policy
// survives, because the policy is the thing that keeps a turn inside the vault:
// realpath rather than a lexical prefix, the deny lists, and the other vaults'
// walls.
//
// So the rule is applied to the call before it runs (ClaudeSession's onToolUse,
// a PreToolUse hook). policy.mjs holds the real decision and is shared with pi's
// extension — it is vault-chat's own code, imported here in-process rather than
// written out to pi's state dir.
// @ts-ignore a plain .mjs (the same helpers pi's extension loads): one policy, one copy
import { guardToolCall, resolveList } from "../pi/ext/policy.mjs";

/** What a tool call wants to do to a path. */
export type Touch = { path: string; write: boolean };

export type Walls = {
  /** The thread's folder: a relative path in a call resolves against it. */
  cwd: string;
  home: string;
  denyRead: string[];
  denyWrite: string[];
};

/**
 * The paths a built-in tool call would touch, and whether it would write.
 *
 * Only the tools that name a path are listed. A tool that names none touches
 * nothing to check (TodoWrite, WebSearch); Bash is deliberately absent — a shell
 * line is not a path, and what holds it in is the sandbox, as it always was.
 */
export function touchesOf(tool: string, input: Record<string, unknown>): Touch[] {
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const one = (v: unknown, write: boolean): Touch[] => {
    const p = str(v);
    return p ? [{ path: p, write }] : [];
  };
  switch (tool) {
    case "Read":
      return one(input.file_path, false);
    case "Write":
      return one(input.file_path, true);
    case "Edit":
    case "NotebookEdit":
      return [...one(input.file_path, true), ...one(input.notebook_path, true)];
    // A search names a directory to walk, and reads whatever is under it.
    case "Glob":
    case "Grep":
      return one(input.path, false);
    default:
      return [];
  }
}

/**
 * Why vault-chat refuses this call, or null to let it through. The first path
 * that is refused answers: a call is one decision, and a partly-allowed edit is
 * not a thing.
 */
export function ruleOnToolUse(tool: string, input: Record<string, unknown>, walls: Walls): string | null {
  for (const t of touchesOf(tool, input)) {
    const why = guardToolCall(t.write ? "write" : "ls", { path: t.path }, {
      cwd: walls.cwd,
      home: walls.home,
      denyRead: resolveList(walls.denyRead, walls.home),
      denyWrite: resolveList(walls.denyWrite, walls.home),
    });
    if (why) return why;
  }
  return null;
}
