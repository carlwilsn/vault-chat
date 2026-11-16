// The notes' data shapes (src/notes.ts reads and writes them): no imports, so a host that only names a Note (the plugin
// host API, src/hostApi.ts) does not pull in the app.

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

export type NoteTurn = { role: "user" | "assistant"; content: string };

export type Note = {
  /** Read-only routing provenance, never persisted in notes.jsonl. */
  origin_vault?: string;
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
