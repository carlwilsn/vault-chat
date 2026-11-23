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
  "Not on a live call: you don't edit files yourself while a voice call is live (a shell line that only reads, such as cat, grep, ls, git log, still runs). Use the Agent tool in background mode now with this change — it makes it and checks it, and notifies you when done or failed.";

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

/**
 * Programs a shell line may run on a live call: they only read (files, the box's state, git history). Anything else —
 * an editor, a package manager, a network client, an interpreter, `xargs`/`env`/`sudo` that run another program — is
 * not one of them. Some of these have flags or arguments that write or run things; `writes` below refuses those.
 */
const READ_ONLY_PROGRAMS = new Set([
  "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "ls", "find", "wc", "sed", "awk", "jq", "sort", "uniq", "cut",
  "tr", "column", "nl", "diff", "cmp", "comm", "file", "stat", "du", "df", "ps", "pgrep", "date", "echo", "printf", "pwd",
  "which", "whoami", "id", "uname", "hostname", "uptime", "free", "basename", "dirname", "realpath", "readlink", "md5sum",
  "sha256sum", "sha1sum", "base64", "od", "hexdump", "strings", "tree", "journalctl", "ss", "lsof", "true", "false",
  "test", "[", "sleep", "seq", "zcat", "zgrep", "tac", "rev", "pdftotext", "pdfinfo", "git", "cd", "nproc",
]);
/** git subcommands that only read (some only with some arguments: `gitWrites`). */
const GIT_READS = new Set(["log", "show", "status", "diff", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "rev-list", "cat-file", "branch", "tag", "describe", "shortlog", "reflog", "merge-base", "remote", "config", "worktree", "for-each-ref", "name-rev", "count-objects"]);

/** A shell word without its quotes (a rough reading, enough to name a program and its flags). */
const unquote = (w: string) => w.replace(/^(["'])(.*)\1$/, "$2");
const positional = (args: string[]) => args.filter((x) => !x.startsWith("-"));

/** Whether this read-only program, with these arguments, would write or run something after all. */
function writes(prog: string, args: string[]): boolean {
  switch (prog) {
    case "sed":
      // -i edits in place; a w/W/e command in the script writes a file or runs one.
      return args.some((x) => /^-[a-zA-Z]*i|^--in-place/.test(x) || (!x.startsWith("-") && /(^|[;{}\s])[wWe](\s|$)|\/[gpIiMm0-9]*[wWe](\s|$)/.test(x)));
    case "awk":
      return args.some((x) => /system\s*\(|getline|>|\|/.test(x) || /^-i/.test(x));
    case "find":
      return args.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(x));
    case "sort":
      return args.some((x) => /^-o|^--output/.test(x));
    case "uniq":
      return positional(args).length > 1; // uniq IN OUT writes OUT
    case "pdftotext":
      return positional(args).length > 1 && positional(args).at(-1) !== "-";
    case "tree":
      return args.includes("-o");
    case "date":
      return args.some((x) => /^-s|^--set/.test(x));
    case "hostname":
      return positional(args).length > 0;
    case "journalctl":
      return args.some((x) => /^--(vacuum|rotate|flush|sync|relinquish|setup-keys)/.test(x));
    case "git":
      return gitWrites(args);
    default:
      return false;
  }
}

/** git: only -C <dir> and --no-pager before a read subcommand, and none of the arguments that make it write. */
function gitWrites(args: string[]): boolean {
  let k = 0;
  for (; k < args.length; k++) {
    if (args[k] === "-C") k++;
    else if (args[k] !== "--no-pager") break;
  }
  const sub = args[k];
  const rest = args.slice(k + 1);
  if (!sub || !GIT_READS.has(sub)) return true;
  if (rest.some((x) => /^--output|^--exec/.test(x))) return true;
  const pos = positional(rest);
  switch (sub) {
    case "branch":
    case "tag":
      // A listing: no name given, or --list / -l.
      return rest.some((x) => /^-(d|D|m|M|c|C|f|u|a|s|F)$/.test(x) && !(sub === "branch" && x === "-a")) || rest.some((x) => /^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description|annotate|sign)/.test(x)) || (pos.length > 0 && !rest.some((x) => x === "--list" || x === "-l"));
    case "remote":
      return pos.length > 0 && !["show", "get-url"].includes(pos[0]!);
    case "config":
      return !rest.some((x) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(x)) || rest.some((x) => /^--(add|unset|replace-all|rename-section|remove-section|edit)|^-e$/.test(x));
    case "worktree":
      return pos[0] !== "list";
    case "reflog":
      return ["expire", "delete"].includes(pos[0] ?? "");
    default:
      return false;
  }
}

/**
 * Whether a shell line only reads: every command in it (split on ; && || | & and newlines) is a READ_ONLY_PROGRAMS one
 * that `writes` does not catch, there is no output redirection to a file (`>/dev/null`, `2>&1` are fine), and nothing
 * the reading cannot follow is in it (command or process substitution, backticks, groups, here-docs, eval/exec/source,
 * a leading assignment). False when unsure: a line refused here can still be delegated.
 */
export function readOnlyShell(command: string): boolean {
  const cmd = String(command ?? "").trim();
  if (!cmd || cmd.length > 4000) return false;
  if (/`|\$\(|<\(|>\(|<<|\\\n/.test(cmd)) return false;
  const bare = (x: string) => x.replace(/'[^']*'|"[^"]*"/g, (q) => q.replace(/[^'"]/g, "_"));
  // Output redirection: only to /dev/null, or one stream into another.
  const noNull = cmd.replace(/(\d|&)?>>?\s*\/dev\/null\b/g, " ").replace(/\d?>&\d/g, " ");
  if (/>/.test(bare(noNull))) return false;
  if (/[(){}]/.test(bare(noNull).replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, ""))) return false;
  // Split on the operators outside quotes (the quotes kept, positions the same as in `bare`).
  const b = bare(noNull);
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < b.length; i++) {
    if (/[;|&\n]/.test(b[i]!)) {
      parts.push(noNull.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(noNull.slice(from));
  for (const raw of parts) {
    const words = (raw.trim().match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(unquote);
    if (!words.length) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return false;
    const prog = words[0]!.split("/").pop()!;
    if (!READ_ONLY_PROGRAMS.has(prog) || ["eval", "exec", "source", "."].includes(prog)) return false;
    if (writes(prog, words.slice(1))) return false;
  }
  return true;
}

/** Whether a tool call is held on a live voice call: the file writers always; a shell line unless it only reads. */
export function heldOnCall(tool: string, input: Record<string, unknown>): boolean {
  if (!WRITING_TOOLS.includes(tool)) return false;
  return tool !== "Bash" || !readOnlyShell(String(input?.command ?? ""));
}

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
  const wait = waitLoopReason(tool, input);
  if (wait) return wait;
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

/**
 * Waiting is Claude Code's own (Carl 11-22: trust the harness): a wait on a ship result or a CI run runs in the
 * background (Bash with run_in_background, or Monitor), and Claude Code wakes the session when it ends; the backend
 * keeps a session with background work running warm. Only a FOREGROUND loop is refused: it would hold the turn, and
 * Carl could not talk to the chat meanwhile. Reading a result once (cat, ls, gh run view) still runs.
 */
const WAITED_ON = /ship-results|\bgh\s+(run|pr)\s+(watch|checks|view)\b|actions\/runs/;
const LOOPS = /\b(sleep|until|while|watch|inotifywait)\b|\bgh\s+run\s+watch\b|--watch\b/;
export const WAIT_LOOP_REASON =
  "vault-chat: run this wait in the background (Bash with run_in_background: true, or Monitor), not in the foreground: " +
  "Claude Code wakes you when it ends, and Carl can still talk to this chat meanwhile. Reading a result once (cat, ls) is fine.";
export function waitLoopReason(tool: string, input: Record<string, unknown>): string | null {
  if (tool !== "Bash" || input.run_in_background === true) return null;
  const text = [input.command, input.script].filter((x) => typeof x === "string").join("\n");
  if (!text || !WAITED_ON.test(text) || !LOOPS.test(text)) return null;
  return WAIT_LOOP_REASON;
}
