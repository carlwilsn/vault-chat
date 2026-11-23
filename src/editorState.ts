// What the editors hold that the disk does not show yet (Native agency: the agent works beside Carl, reports/21 B6):
// where his caret is in each open file, and whether a file has typing not yet saved (the editor's 300 ms autosave,
// src/editorWrites.ts) or a save stopped on a conflict. app/viewer offers it as `editing`, so before the agent edits a
// file it can see Carl is typing in it, and where, and wait for the save (its watch) instead of writing over him.
export type Caret = { line: number; col: number; selected: number; at: number };

const KEY = "__vcEditorCarets";
function carets(): Map<string, Caret> {
  const g = globalThis as Record<string, unknown>;
  return ((g[KEY] as Map<string, Caret> | undefined) ??= new Map());
}

/** An editor's caret moved (line and column 1-based; `selected`: characters selected, 0 for a caret). */
export function setCaret(path: string | null | undefined, line: number, col: number, selected = 0, now = Date.now()): void {
  if (!path) return;
  carets().set(path, { line: Math.max(1, Math.trunc(line)), col: Math.max(1, Math.trunc(col)), selected: Math.max(0, Math.trunc(selected)), at: now });
  editorChanged();
}

/** An open editor's own typing and selecting (CodeMirror's dispatch, Monaco's type / setSelection): what Carl's keys do,
 *  so app/viewer's type and select actions take the same path. Registered while the editor is mounted. */
export type EditorHandle = {
  /** Type `text` at the caret (replacing the selection), as keys would. */
  type(text: string): void;
  /** Select from (line, col) to (endLine, endCol), 1-based; a caret when the end is left out. */
  select(line: number, col: number, endLine?: number, endCol?: number): void;
  /** Open a Ctrl+K box at the caret or selection, as Ctrl+K does. */
  ask?(): void;
};
const HKEY = "__vcEditorHandles";
function handles(): Map<string, EditorHandle> {
  const g = globalThis as Record<string, unknown>;
  return ((g[HKEY] as Map<string, EditorHandle> | undefined) ??= new Map());
}
export function registerEditor(path: string | null | undefined, h: EditorHandle): () => void {
  if (!path) return () => {};
  handles().set(path, h);
  return () => {
    if (handles().get(path) === h) handles().delete(path);
  };
}
export function editorOf(path: string): EditorHandle | null {
  return handles().get(path) ?? null;
}

const changedFns = new Set<() => void>();
/** A caret moved or a selection changed in an editor (app/viewer's watch). */
export function onEditorChanged(fn: () => void): () => void {
  changedFns.add(fn);
  return () => void changedFns.delete(fn);
}
function editorChanged(): void {
  for (const f of [...changedFns]) f();
}

export function caretOf(path: string): Caret | null {
  return carets().get(path) ?? null;
}

/** Line and column (1-based) of an offset in a text. */
export function lineColAt(text: string, offset: number): { line: number; col: number } {
  const o = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, o);
  const nl = before.lastIndexOf("\n");
  return { line: before.split("\n").length, col: o - nl };
}

const SAVED_KEY = "__vcEditorSaved";
type SavedFn = (path: string) => void;
function savedFns(): Set<SavedFn> {
  const g = globalThis as Record<string, unknown>;
  return ((g[SAVED_KEY] as Set<SavedFn> | undefined) ??= new Set());
}
/** An editor's typing reached the disk (its autosave). */
export function noteSaved(path: string): void {
  for (const f of [...savedFns()]) {
    try {
      f(path);
    } catch {
      /* a listener's own error */
    }
  }
}
/** Hear each save; returns off. */
export function onSaved(fn: SavedFn): () => void {
  savedFns().add(fn);
  return () => void savedFns().delete(fn);
}

/** Tests: forget every caret. */
export function _resetCarets(): void {
  carets().clear();
}
