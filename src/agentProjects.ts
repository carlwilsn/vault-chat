// Where projects live in a vault — the one definition the box server
// (server/context/projects.ts) and the app (src/projects.ts) both read; the
// Rust side (src-tauri/src/lib.rs AGENT_PROJECTS_DIR, prepare_agent_projects)
// carries the same strings and a server test holds them equal.
//
// A project is an ordinary folder, `<vault>/agent-projects/<slug>/`, that the
// vault's hide list (`.vaultchatignore`, the file tree's "Hidden files") hides
// by default. Hidden once: the first time a vault has the folder its name is
// added to the hide list and recorded in HIDE_DEFAULTS_FILE; if Carl unhides it
// the record stays, so it is never hidden again.
//
// Projects used to live in `.vault-chat/projects/<slug>/`; both sides move them
// (the same per-file moves, so git sees the same rename on each side and the
// sync merges them cleanly). The server-only state of a project (pinned
// check/metric/budget, tasks) stays in `.vault-chat/local/projects/<slug>/`.

/** The projects folder, relative to the vault root. */
export const PROJECTS_DIR = "agent-projects";
/** Where projects lived before (relative to the vault root). */
export const LEGACY_PROJECTS_DIR = ".vault-chat/projects";
/** The vault's hide list (lib.rs IGNORE_FILE). */
export const HIDE_FILE = ".vaultchatignore";
/** Entries vault-chat has hidden by default once (one per line); never re-hidden. */
export const HIDE_DEFAULTS_FILE = ".vault-chat/hidden-by-default";

const norm = (l: string) => l.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");

/** The entries of a list file (the hide list's format: one path per line, `#` comments). */
export function listEntries(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map(norm)
    .filter(Boolean);
}

/**
 * Hide `entry` by default, once. Given the hide list and the record of what was
 * hidden by default, the new texts to write, or null when there is nothing to do
 * (already recorded: hidden before, possibly unhidden by Carl since).
 * Deterministic, so two machines doing it from the same files write the same bytes.
 */
export function hideOnce(entry: string, hideText: string, recordText: string): { hide: string | null; record: string } | null {
  if (listEntries(recordText).includes(entry)) return null;
  const record = (recordText ? withNl(recordText) : "# Hidden by default once by vault-chat; unhiding one keeps it shown.\n") + `${entry}\n`;
  const hide = listEntries(hideText).includes(entry) ? null : withNl(hideText) + `${entry}\n`;
  return { hide, record };
}

function withNl(s: string): string {
  return s && !s.endsWith("\n") ? `${s}\n` : s;
}
