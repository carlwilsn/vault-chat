// The TeX previews on screen (src/TexView.tsx): per .tex file whether it is compiling, the PDF it made, the error log of
// a failed compile, and its own compile, so app/viewer's open state shows them and its recompile action runs the same
// compile as a save does. A change tells the offers' watch.

export type TexNow = { compiling: boolean; error: string | null; pdf: string | null; at: string | null };
type Entry = { now: () => TexNow; compile: () => void };

const norm = (p: string) => p.replace(/\\/g, "/");
const by = new Map<string, Entry>();
const fns = new Set<() => void>();

export function registerTex(path: string, e: Entry): () => void {
  const p = norm(path);
  by.set(p, e);
  texChanged();
  return () => {
    if (by.get(p) === e) by.delete(p);
    texChanged();
  };
}
export function texChanged(): void {
  for (const f of [...fns]) f();
}
export function onTexChanged(fn: () => void): () => void {
  fns.add(fn);
  return () => void fns.delete(fn);
}
/** A .tex file's preview now (its error log cut to its last 4000 characters), or null when none is drawn. */
export function texOf(path: string): TexNow | null {
  const e = by.get(norm(path));
  if (!e) return null;
  const n = e.now();
  return { ...n, error: n.error && n.error.length > 4000 ? `…${n.error.slice(-4000)}` : n.error };
}
export function recompileTex(path: string): boolean {
  const e = by.get(norm(path));
  if (!e) return false;
  e.compile();
  return true;
}
