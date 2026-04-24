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
  image_data_url?: string | null;
  primary: boolean;
};

export type NoteTurn = { role: "user" | "assistant"; content: string };

export type Note = {
  id: string;
  timestamp: string; // ISO
  last_updated: string; // ISO
  anchors: NoteAnchor[];
  turns: NoteTurn[]; // empty for pure captures; populated when promoted from ask
  user_draft: string | null; // typed text not yet sent as a turn
  status: "open" | "resolved";
  /** Cached AI-written summary of the note — generated lazily on first
   *  expand in the panel and persisted so we don't re-spend tokens. */
  formatted?: string | null;
};

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return `n_${Math.random().toString(36).slice(2, 10)}`;
}

/** Read every note for the vault. Silently skips malformed lines so
 *  one corrupt entry doesn't nuke the list. */
export async function readNotes(vault: string): Promise<Note[]> {
  const lines = await invoke<string[]>("notes_read", { vault });
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
