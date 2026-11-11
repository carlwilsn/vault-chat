// vault-chat's one path policy, over Claude Code's own file tools.
//
// The file tools used to be pi's (its core read/write/edit, loaded from its
// install), so no pi install meant no file tools at all. Claude Code using its
// own instead is what freed vault-chat of pi — but only because the policy
// survives, because the policy is the thing that keeps a turn inside the vault:
// realpath rather than a lexical prefix, the deny lists, and the other vaults'
// walls.
//
// So the rule is applied to the call before it runs (ClaudeSession's onToolUse,
// a PreToolUse hook). policy.mjs holds the real decision and is shared with pi's
// extension — it is vault-chat's own code, imported here in-process rather than
// written out to pi's state dir.
import { join } from "node:path";

// @ts-ignore a plain .mjs — vault-chat's own policy, kept when pi went
import { guardToolCall, isUnder, realish, resolveList } from "../policy.mjs";

/** Why a write is refused while a voice call is live: the talker hands it to a background agent. */
export const CALL_WRITE_REASON =
  "Not on a live call: you don't edit files yourself while a voice call is live. Use the Agent tool in background mode now with this change — it makes it and checks it, and notifies you when done or failed.";

/**
 * The deny lists, from the sandbox alone. Both engines read them from here so
 * there is one answer to "what may a turn not touch": the private metadata of
 * other vaults, the engine's own state, and — inside a project folder that is
 * Carl's own git repo — that project's .vault-chat, which is his, not the
 * agent's. pi's own readWalls/writeWalls call this, so the two cannot drift.
 */
export function wallsOf(sandbox: {
  denyRead: string[];
  denyWrite: string[];
  others?: () => string[];
  readOnly?: () => string[];
}): { denyRead: string[]; denyWrite: string[] } {
  const projectPrivate = (sandbox.readOnly?.() ?? []).flatMap((p) =>
    ["conversations", "events", "local"].map((d) => join(p, ".vault-chat", d)));
  return {
    denyRead: [...sandbox.denyRead, ...(sandbox.others?.() ?? []), ...projectPrivate],
    denyWrite: [...sandbox.denyWrite, ...projectPrivate],
  };
}

/**
 * The calls the voice gate covers. On a live call the agent does not change
 * files itself — it hands them off — and that includes a shell line, which could
 * write around the rule. Claude Code's own tools are gated by the same rule as
 * vault-chat's own file tools did, in the same words.
 */
export const WRITING_TOOLS: readonly string[] = ["Write", "Edit", "NotebookEdit", "Bash"];

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
 * Why a path handed in from outside a tool call is refused, or null.
 *
 * The host's own readers (a PDF the viewer opens, an attachment) resolve a path
 * against the thread's folder and must not reach round the walls by symlink or
 * `..`; this is the same decision as a tool call's, on the resolved path.
 */
export function externalPath(root: string, path: unknown, write: boolean, walls: { denyRead: string[]; denyWrite: string[] }): string | null {
  const home = process.env.HOME ?? "/";
  if (typeof path !== "string" || !path.trim()) return "An explicit vault file path is required.";
  const resolved = realish(path, root, home);
  if (!isUnder(resolved, realish(root, root, home))) return "Path is outside the explicitly bound vault.";
  return guardToolCall(write ? "write" : "ls", { path }, {
    cwd: root,
    home,
    denyRead: resolveList(walls.denyRead, home),
    denyWrite: resolveList(walls.denyWrite, home),
  });
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
