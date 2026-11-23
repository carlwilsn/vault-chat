import { invoke } from "@tauri-apps/api/core";

// Notes are global on the connected box; their original files retain ownership. Stored as
// JSONL at <vault>/.vault-chat/notes.jsonl so they travel with the
// vault (and the git history) but stay hidden from the file tree.

import type { Note, NoteAnchor, NoteTurn } from "./noteTypes";
export type { Note, NoteAnchor, NoteTurn } from "./noteTypes";

/** Return every image attached to an anchor, normalizing the legacy
 *  single-image shape. Always safe — never throws. */
export function anchorImages(a: NoteAnchor): string[] {
  if (a.images && a.images.length > 0) return a.images;
  if (a.image_data_url) return [a.image_data_url];
  return [];
}

/** The text we'd hand a model to write a title from — empty when there's
 *  nothing meaningful to headline (a bare image/anchor capture). */
export function titleableText(n: Note): string {
  const parts: string[] = [];
  if (n.user_draft && n.user_draft.trim()) parts.push(n.user_draft.trim());
  if (n.turns.length > 0) parts.push(n.turns.map((t) => t.content).join("\n"));
  if (!parts.length && n.formatted && n.formatted.trim()) parts.push(n.formatted.trim());
  return parts.join("\n\n").trim();
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return `n_${Math.random().toString(36).slice(2, 10)}`;
}

function parseNoteLines(lines: string[]): Note[] {
  const notes: Note[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.id === "string") notes.push(parsed as Note);
    } catch {
      // skip broken line
    }
  }
  return notes;
}

/** The winner between two rows that represent the same note. Status is
 *  authoritative and ranked `cleared` > `resolved` > `open` — once a note is
 *  cleared/resolved on any machine it must not be reverted by a staler-status
 *  twin, regardless of timestamps. Among rows of equal status the latest
 *  `last_updated` (falling back to `timestamp`) wins, carrying the freshest
 *  edits/title/summary. Returns `a` on an exact tie. */
function statusRank(s: Note["status"]): number {
  return s === "cleared" ? 2 : s === "resolved" ? 1 : 0;
}
function preferredNote(a: Note, b: Note): Note {
  const ra = statusRank(a.status);
  const rb = statusRank(b.status);
  if (ra !== rb) return ra > rb ? a : b;
  const as = a.last_updated || a.timestamp || "";
  const bs = b.last_updated || b.timestamp || "";
  return as >= bs ? a : b;
}

/** A stable key over a note's *meaningful* body — typed draft + conversation
 *  turns + anchored source paths. Returns null for a bare capture with no text
 *  and no turns (an image/anchor-only note): those must NEVER be collapsed
 *  against each other, since two distinct screenshots share an empty body.
 *  Keys on the FULL text, never a prefix — two genuinely-distinct notes don't
 *  share byte-identical bodies, so this only ever merges a true re-capture
 *  (e.g. a double-fired `buildNote`, which mints a fresh id each call).
 *  JSON-encoding the parts keeps the field boundaries unambiguous. */
function bodyKey(n: Note): string | null {
  const draft = (n.user_draft ?? "").trim();
  const turns = n.turns.map((t) => `${t.role}:${t.content}`).join("\n");
  if (!draft && !turns) return null;
  const paths = n.anchors.map((a) => a.source_path).sort();
  return JSON.stringify([draft, turns, paths]);
}

/** Collapse duplicate rows to one note each. notes.jsonl is committed with
 *  `merge=union` (.gitattributes), so a row that two machines edited — or that
 *  one machine rewrote on a status flip — survives the merge as several physical
 *  lines for the same id. Every sibling append-only store already dedupes on
 *  read for exactly this reason (schedules.ts dedupeById, runWatcher.ts byId
 *  map, phoneApp.ts inflight/worker guards); notes was the one that didn't,
 *  which left a resolved note's open twin "open" forever and corrupted the open
 *  backlog. Dedupe here so a read is the source of truth no matter how many
 *  union-merged lines back it — compaction of the file is then just cosmetic. */
export function dedupeNotes(list: Note[]): Note[] {
  // Pass 1 — collapse physical rows that share a stable id (the common case:
  // union-merge concatenation, and a status flip that rewrote the row).
  const byId = new Map<string, Note>();
  for (const n of list) {
    const prev = byId.get(n.id);
    byId.set(n.id, prev ? preferredNote(n, prev) : n);
  }
  // Pass 2 — body-key fallback for distinct-id twins (a double-fired capture
  // mints two ids with identical content). Conservative: only notes with real
  // body content are eligible; bare captures keep their own ids (bodyKey null).
  const byBody = new Map<string, Note>();
  const kept: Note[] = [];
  for (const n of byId.values()) {
    const key = bodyKey(n);
    if (!key) {
      kept.push(n);
      continue;
    }
    const prev = byBody.get(key);
    if (!prev) {
      byBody.set(key, n);
      kept.push(n);
      continue;
    }
    if (preferredNote(n, prev) === n) {
      byBody.set(key, n);
      kept[kept.indexOf(prev)] = n;
    }
  }
  return kept;
}

/** Read every note for the vault, deduped. Silently skips malformed lines so
 *  one corrupt entry doesn't nuke the list. */
export async function readNotes(vault: string): Promise<Note[]> {
  const { boxLinkFor, boxGet } = await import("./boxChat");
  const link = await boxLinkFor(vault);
  if (link) return (await boxGet(link, "/notes?full=1")).notes;
  const lines = await invoke<string[]>("notes_read", { vault });
  return dedupeNotes(parseNoteLines(lines));
}

/** One-time-ish compaction: rewrite notes.jsonl with the deduped set, dropping
 *  the surplus union-merge / status-flip lines. A no-op (no write) when the file
 *  is already compact, so it's safe to call on every launch. Correctness never
 *  depends on this — readNotes dedupes regardless — it just stops the file from
 *  growing unbounded as merge=union keeps re-concatenating duplicates. Returns
 *  the number of lines collapsed. */
export async function compactNotes(vault: string): Promise<number> {
  if (!vault) return 0;
  const { boxLinkFor } = await import("./boxChat");
  if (await boxLinkFor(vault)) return 0;
  const lines = await invoke<string[]>("notes_read", { vault });
  const parsed = parseNoteLines(lines);
  const deduped = dedupeNotes(parsed);
  if (deduped.length >= parsed.length) return 0;
  await writeAllNotes(vault, deduped);
  return parsed.length - deduped.length;
}

export async function appendNote(vault: string, note: Note): Promise<void> {
  const { boxLinkFor, boxPost } = await import("./boxChat");
  const link = await boxLinkFor(vault);
  if (link) {
    // The notes noun's add (box:notes), with what the composer captured: one path for every way a note is made.
    const r = await boxPost(link, "/notes", { text: note.user_draft ?? "", anchors: note.anchors, turns: note.turns, id: note.id });
    if (!r.ok) throw new Error(r.error);
    return;
  }
  await invoke("notes_append", { vault, line: JSON.stringify(note) });
}

export async function writeAllNotes(vault: string, notes: Note[]): Promise<void> {
  const { boxLinkFor, boxPost } = await import("./boxChat");
  const link = await boxLinkFor(vault);
  if (link) {
    const r = await boxPost(link, "/notes/write", { notes });
    if (!r.ok) throw new Error(r.error);
    return;
  }
  const lines = notes.map((n) => JSON.stringify(n));
  await invoke("notes_write_all", { vault, lines });
}

/** One of the Notes panel's controls as the box's notes action (server/model/notes.ts, the agent's box:notes): edit,
 *  resolve / reopen (status), delete, clear-resolved. False when this vault has no box: the caller writes the file. */
export async function noteAction(vault: string, action: "edit" | "status" | "delete" | "clear-resolved", body: Record<string, unknown>): Promise<boolean> {
  const { boxLinkFor, boxPost } = await import("./boxChat");
  const link = await boxLinkFor(vault);
  if (!link) return false;
  const r = await boxPost(link, `/notes/${action}`, body);
  if (!r.ok) throw new Error(r.error);
  return true;
}

/** Factory — create a Note from a capture payload. Call appendNote
 *  separately to persist. */
export function buildNote(payload: {
  anchors: NoteAnchor[];
  turns?: NoteTurn[];
  userDraft?: string | null;
}): Note {
  const now = new Date().toISOString();
  return {
    id: newId(),
    timestamp: now,
    last_updated: now,
    anchors: payload.anchors,
    turns: payload.turns ?? [],
    user_draft: payload.userDraft ?? null,
    status: "open",
  };
}

// True if the note is rich enough to be worth re-summarizing. Trivial
// pure-text dumps with no context are shown as-is; summarizing them
// would just paraphrase a sentence the user already wrote.
export function noteIsSummarizable(n: Note): boolean {
  if (n.turns.length > 0) return true;
  if (n.anchors.some((a) => a.image_data_url)) return true;
  if (n.anchors.some((a) => a.source_selection && a.source_selection.length > 0)) return true;
  if (n.anchors.length > 1) return true;
  return false;
}
