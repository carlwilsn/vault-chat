// Zoom of the open files, for the agent (app/viewer's open state and its zoom action). A viewer that zooms (the PDF
// viewer, the image viewer; a plugin's viewer through file.zoomable) says so here with its file, how far it is zoomed
// and how to set it; the registry holds one entry per mounted viewer, gone when it unmounts. No React here.

export type Zoomable = { get(): number; set(z: number): void; min: number; max: number };

const norm = (p: string) => p.replace(/\\/g, "/");
const by = new Map<string, Zoomable[]>();

/** One zoom step, for the viewers' − / + buttons and the agent's "in" / "out" alike (report 28: 1.1 vs 1.25). */
export const ZOOM_STEP = 1.1;

const fns = new Set<() => void>();
/** A viewer's zoom moved (its buttons, Ctrl+wheel, a pinch, the agent): the viewer offers' watch. */
export function zoomMoved(): void {
  for (const f of [...fns]) f();
}
export function onZoomMoved(fn: () => void): () => void {
  fns.add(fn);
  return () => void fns.delete(fn);
}

/** A mounted viewer of `path` zooms: returns the undo (call it on unmount). */
export function registerZoom(path: string, z: Zoomable): () => void {
  const p = norm(path);
  by.set(p, [...(by.get(p) ?? []), z]);
  return () => {
    const list = (by.get(p) ?? []).filter((x) => x !== z);
    if (list.length) by.set(p, list);
    else by.delete(p);
  };
}

/** How far `path` is zoomed (1 = fit), or null when its viewer does not zoom. */
export function zoomOf(path: string): number | null {
  const l = by.get(norm(path));
  const z = l ? l[l.length - 1] : undefined;
  return z ? Math.round(z.get() * 100) / 100 : null;
}

/** Zoom `path`: a factor (1 = fit), or "in" / "out" (one ZOOM_STEP) / "reset". Every view of it follows; answers the
 *  zoom now. Throws when its viewer does not zoom. */
export function setZoomOf(path: string, want: number | "in" | "out" | "reset"): { zoom: number; min: number; max: number } {
  const list = by.get(norm(path));
  if (!list?.length) throw new Error("the viewer drawing this file does not zoom (the PDF and image viewers do)");
  const top = list[list.length - 1]!;
  const now = top.get();
  const raw = want === "in" ? now * ZOOM_STEP : want === "out" ? now / ZOOM_STEP : want === "reset" ? 1 : Number(want);
  if (!Number.isFinite(raw) || raw <= 0) throw new Error(`zoom takes a factor > 0 (1 = fit) or "in", "out", "reset", not ${JSON.stringify(want)}`);
  const z = Math.max(top.min, Math.min(top.max, raw));
  for (const x of list) x.set(Math.max(x.min, Math.min(x.max, z)));
  return { zoom: Math.round(z * 100) / 100, min: top.min, max: top.max };
}
