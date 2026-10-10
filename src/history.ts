// Readable history: the typed client for the Rust `history_*` commands
// (src-tauri/src/history.rs) plus the shared actions every history style uses
// (flush pending edits first, reload open editors after).

import { invoke } from "@tauri-apps/api/core";
import { useStore, type FileEntry } from "./store";
import { flushEditCommit } from "./commit-controller";
import { gitCommitAll } from "./git";

export type HistoryFile = { path: string; status: "A" | "M" | "D"; add: number; del: number };

export type HistoryEntry = {
  id: string;
  kind: "session" | "mission" | "restore" | "undo" | "redo";
  actor: "human" | "agent" | "mission";
  machine?: string | null;
  title: string;
  summary?: string | null;
  /** unix seconds */
  start: number;
  end: number;
  commits: string[];
  base: string;
  files: HistoryFile[];
  conversation_id?: string | null;
  mission_id?: string | null;
  cost_usd?: number | null;
  undone_by?: string | null;
  undoes?: string | null;
  restores?: string | null;
  inner?: { hash: string; time: number; subject: string }[];
  noise?: boolean;
};

export type TimelinePage = { entries: HistoryEntry[]; next_cursor: string | null; head: string };

export type NoteVersion = {
  entry_id: string;
  hash: string;
  time: number;
  start: number;
  actor: "human" | "agent" | "mission";
  machine?: string | null;
  kind: HistoryEntry["kind"];
  summary?: string | null;
  add: number;
  del: number;
  commits: number;
  deleted: boolean;
};

export type VersionsPage = { versions: NoteVersion[]; next_cursor: string | null };
export type UndoResult = { ok: boolean; commit?: string | null; conflicts: string[]; changed_paths: string[] };

export function historyTimeline(
  vault: string,
  opts: { cursor?: string | null; limit?: number; includeNoise?: boolean; path?: string } = {},
): Promise<TimelinePage> {
  return invoke<TimelinePage>("history_timeline", {
    vault,
    cursor: opts.cursor ?? null,
    limit: opts.limit ?? 40,
    path: opts.path ?? null,
    includeNoise: opts.includeNoise ?? false,
  });
}

export function historyNoteVersions(vault: string, path: string, cursor?: string | null, limit = 30): Promise<VersionsPage> {
  return invoke<VersionsPage>("history_note_versions", { vault, path, cursor: cursor ?? null, limit });
}

export function historyFileAt(vault: string, hash: string, path: string): Promise<string> {
  return invoke<string>("history_file_at", { vault, hash, path });
}

/** "disk": what restoring `hash` would change on disk ("+" = lines that come
 *  back). "hash": what that version changed (from `base`, default its parent). */
export function historyDiff(vault: string, hash: string, path: string, against: "disk" | "hash" = "disk", base?: string): Promise<string> {
  return invoke<string>("history_diff", { vault, hash, path, against, base: base ?? null });
}

// ----- actions -----

/** Commit everything in flight before history moves files: the editor's
 *  300 ms save debounce, then the 10 s edit batch, then any leftover. */
async function flushPending(vault: string): Promise<void> {
  await new Promise((r) => window.setTimeout(r, 350));
  await flushEditCommit();
  await gitCommitAll(vault, "edit (before history)");
}

/** Reload every open pane whose file changed, and the file tree. */
async function reloadAfter(vault: string, rels: string[]): Promise<void> {
  const st = useStore.getState();
  try {
    st.setFiles(await invoke<FileEntry[]>("list_markdown_files", { vault }));
  } catch {
    /* tree refresh is best-effort */
  }
  const norm = (p: string) => p.replace(/\\/g, "/");
  const changed = new Set(rels.map((r) => norm(`${vault}/${r}`)));
  const read = (path: string) => invoke<string>("read_text_file", { path }).catch(() => null);
  for (const pane of st.panes) {
    if (!changed.has(norm(pane.file))) continue;
    const text = await read(pane.file);
    if (text !== null) useStore.getState().setPaneFile(pane.id, pane.file, text);
  }
  const cur = useStore.getState().currentFile;
  if (st.panes.length === 0 && cur && changed.has(norm(cur))) {
    const text = await read(cur);
    if (text !== null) useStore.getState().setCurrentFile(cur, text);
  }
}

export async function restoreNote(vault: string, path: string, hash: string): Promise<{ commit: string }> {
  await flushPending(vault);
  const r = await invoke<{ commit: string; reloaded_paths: string[] }>("history_restore_note", { vault, path, hash });
  await reloadAfter(vault, r.reloaded_paths);
  return r;
}

export async function undoEntry(vault: string, entryId: string, redo = false): Promise<UndoResult> {
  await flushPending(vault);
  const r = redo
    ? await invoke<UndoResult>("history_redo_entry", { vault, undoEntryId: entryId })
    : await invoke<UndoResult>("history_undo_entry", { vault, entryId });
  if (r.ok) await reloadAfter(vault, r.changed_paths);
  return r;
}

// ----- formatting (local time; the API speaks unix seconds) -----

export function relTime(unix: number, now = Date.now()): string {
  // Rounded like today's HistoryModal relativeTime.
  const mins = Math.round((now - unix * 1000) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The line a person reads for an entry. */
export function entryTitle(e: HistoryEntry): string {
  if (e.kind === "restore" && e.files.length === 1) return `Restored ${leafOf(e.files[0].path)}`;
  return e.title;
}

export function clockTime(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function fullTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Today / Yesterday / This week / Earlier — ChatsPanel's buckets. */
export function bucketOf(unix: number, now = Date.now()): string {
  const d = new Date(unix * 1000);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const t = d.getTime();
  if (t >= start.getTime()) return "Today";
  if (t >= start.getTime() - 86_400_000) return "Yesterday";
  if (t >= start.getTime() - 6 * 86_400_000) return "This week";
  return "Earlier";
}

export function leafOf(p: string): string {
  return p.split("/").pop() ?? p;
}

/** The history style Carl is choosing between (preview scenarios set it). */
export type HistoryStyle = "modal" | "sheet" | "inline";
export function historyStyle(): HistoryStyle {
  try {
    const v = localStorage.getItem("vault_chat_history_style");
    if (v === "sheet" || v === "inline") return v;
  } catch {
    /* default */
  }
  return "modal";
}
