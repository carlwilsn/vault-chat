// Where each open file is scrolled to, for the agent (app/viewer's open state and its scrolled event). Every viewer
// already says where it is through the store's viewport (voice's follow-along: a markdown scroll ratio, a PDF page);
// a plugin viewer says it with file.scrolled(...), which goes the same way. Followed from the app's start with one
// reference check per store change, so nothing here runs on the keystroke path.
import { useStore, type Viewport } from "../../store";

export type ScrollPos = { ratio?: number; page?: number; totalPages?: number; line?: number; at: number };

const norm = (p: string) => p.replace(/\\/g, "/");
const at = new Map<string, ScrollPos>();
const lineHint = new Map<string, number>();
const fns = new Set<(path: string, pos: ScrollPos) => void>();

function take(v: Viewport | null): void {
  if (!v?.path) return;
  const p = norm(v.path);
  const pos: ScrollPos = {
    ...(typeof v.scrollRatio === "number" ? { ratio: Math.round(v.scrollRatio * 1000) / 1000 } : {}),
    ...(typeof v.page === "number" ? { page: v.page } : {}),
    ...(typeof v.totalPages === "number" ? { totalPages: v.totalPages } : {}),
    ...(lineHint.has(p) ? { line: lineHint.get(p)! } : {}),
    at: Date.now(),
  };
  at.set(p, pos);
  if (at.size > 50) at.delete(at.keys().next().value!);
  for (const f of [...fns]) {
    try {
      f(p, pos);
    } catch {
      /* a listener's problem */
    }
  }
}

let started = false;
/** Follow the store's viewport (once). */
export function followScroll(): void {
  if (started) return;
  started = true;
  take(useStore.getState().viewport);
  useStore.subscribe((s, prev) => {
    if (s.viewport !== prev.viewport) take(s.viewport);
  });
}

/** A plugin viewer says where it is. */
export function noteScroll(path: string, pos: { ratio?: number; page?: number; totalPages?: number; line?: number }): void {
  const p = norm(path);
  if (typeof pos.line === "number" && pos.line > 0) lineHint.set(p, Math.floor(pos.line));
  else lineHint.delete(p);
  const ratio = typeof pos.ratio === "number" && Number.isFinite(pos.ratio) ? Math.min(1, Math.max(0, pos.ratio)) : undefined;
  useStore.getState().setViewport({
    path,
    ...(ratio !== undefined ? { scrollRatio: ratio } : {}),
    ...(typeof pos.page === "number" ? { page: pos.page } : {}),
    ...(typeof pos.totalPages === "number" ? { totalPages: pos.totalPages } : {}),
  });
}

/** Where a file is scrolled to (null: not known). */
export function scrollOf(path: string): ScrollPos | null {
  return at.get(norm(path)) ?? null;
}

/** Called on each change of where a file is; returns off. */
export function onScroll(fn: (path: string, pos: ScrollPos) => void): () => void {
  fns.add(fn);
  return () => void fns.delete(fn);
}
