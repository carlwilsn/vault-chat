import { invoke } from "@tauri-apps/api/core";

// Ephemeral-capture "slop" notes scoped to the current vault. Stored as
// JSONL at <vault>/.vault-chat/notes.jsonl so they travel with the
// vault (and the git history) but stay hidden from the file tree.

export type NoteAnchor = {
  source_path: string;
  source_kind: "pdf" | "markdown" | "code" | "html" | "image" | "notebook" | "none";
  source_anchor: string | null; // e.g. "page=3", "L42", "heading: X"
  source_before?: string | null;
  source_after?: string | null;
  source_selection?: string | null;
  /** @deprecated Kept for back-compat with older notes. New code should
   *  use `images`. On read we normalize into `images`; on write we also
   *  set this to images[0] so old readers keep working. */
  image_data_url?: string | null;
  /** Every marquee image attached to this anchor, in capture order. */
  images?: string[];
  primary: boolean;
};

/** Return every image attached to an anchor, normalizing the legacy
 *  single-image shape. Always safe — never throws. */
export function anchorImages(a: NoteAnchor): string[] {
  if (a.images && a.images.length > 0) return a.images;
  if (a.image_data_url) return [a.image_data_url];
  return [];
}

export type NoteTurn = { role: "user" | "assistant"; content: string };

export type Note = {
  id: string;
  timestamp: string; // ISO
  last_updated: string; // ISO
  anchors: NoteAnchor[];
  turns: NoteTurn[]; // empty for pure captures; populated when promoted from ask
  user_draft: string | null; // typed text not yet sent as a turn
  // "cleared" is a terminal state past "resolved": the user emptied the resolved
  // pile, so the note drops out of every view but stays on disk (no destructive
  // delete). It must OUTRANK resolved in preferredNote so a stale resolved twin
  // on another machine can't un-clear it across the union merge.
  status: "open" | "resolved" | "cleared";
  /** Cached AI-written summary of the note — generated lazily on first
   *  expand in the panel and persisted so we don't re-spend tokens. */
  formatted?: string | null;
  /** Cached short AI headline (≤8 words) that's distinct from the body, so a
   *  list of notes is scannable instead of every row repeating its first line.
   *  Generated lazily on the box and persisted. */
  title?: string | null;
  /** ISO stamp set when the boss says a shipped fix on THIS report didn't take.
   *  Reopen-in-place: the same note re-enters the fix queue instead of minting a
   *  second card (report 8dabd9b1). The feedback queue treats any fixer verdict
   *  older than this stamp as stale, so the ticket becomes actionable again. */
  reopened_at?: string;
};

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
  const lines = await invoke<string[]>("notes_read", { vault });
  const parsed = parseNoteLines(lines);
  const deduped = dedupeNotes(parsed);
  if (deduped.length >= parsed.length) return 0;
  await writeAllNotes(vault, deduped);
  return parsed.length - deduped.length;
}

export async function appendNote(vault: string, note: Note): Promise<void> {
  await invoke("notes_append", { vault, line: JSON.stringify(note) });
}

export async function writeAllNotes(vault: string, notes: Note[]): Promise<void> {
  const lines = notes.map((n) => JSON.stringify(n));
  await invoke("notes_write_all", { vault, lines });
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
