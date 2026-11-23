// The Notes panel's own view state (which list it shows, what it is searching): kept by the plugin, not by React, so
// the panel and the plugin's offers (src/plugins/notes/index.tsx) share it: the agent reads and sets it, the panel
// shows it. It lasts as long as the plugin's run (kept while the panel is closed, as before).
export type NotesViewState = {
  readonly filter: "active" | "resolved";
  readonly query: string;
  /** The card opened (its summary and anchors shown), or null. */
  readonly expanded: string | null;
  /** The card whose raw note is shown, or null. */
  readonly raw: string | null;
  /** The card being edited in place and its text so far, or null. */
  readonly editing: { readonly id: string; readonly text: string } | null;
};
export type NotesView = {
  get(): NotesViewState;
  set(p: Partial<NotesViewState>): void;
  subscribe(fn: () => void): () => void;
};

export function createNotesView(): NotesView {
  let st: NotesViewState = { filter: "active", query: "", expanded: null, raw: null, editing: null };
  const fns = new Set<() => void>();
  return {
    get: () => st,
    set(p) {
      const next = { ...st, ...p };
      if ((Object.keys(next) as (keyof NotesViewState)[]).every((k) => next[k] === st[k])) return;
      st = next;
      for (const f of [...fns]) f();
    },
    subscribe(fn) {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
  };
}
