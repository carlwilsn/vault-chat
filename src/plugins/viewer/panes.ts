// The viewer's panes on screen (src/plugins/viewer ./Pane.tsx): each registers what its header's buttons do (Reload,
// Keep mine) under its file while it shows it, so the offers (./index.ts) do what a click does. Shared with the app, so
// the plugin and the fallback see the same panes.

export type PaneHandle = {
  /** The pane (its id in a split), or null for the one viewer. */
  paneId: string | null;
  /** Show the file as it is on disk (drops typing not saved yet): the header's Reload. */
  reloadFromDisk(): Promise<void>;
  /** Save this version over the one on disk: the header's Keep mine. */
  keepMine(): Promise<void>;
};

const panes = new Map<string, PaneHandle[]>();

type PaneEvent = (name: "reloaded" | "keptMine", data: { file: string; paneId: string | null }) => void;
const paneFns = new Set<PaneEvent>();
/** The header's Reload / Keep mine ran (Carl's click or the agent's action): the viewer's events. */
export function onPaneEvent(fn: PaneEvent): () => void {
  paneFns.add(fn);
  return () => void paneFns.delete(fn);
}
export function emitPaneEvent(...a: Parameters<PaneEvent>): void {
  for (const f of [...paneFns]) f(...a);
}
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** A pane showing `file`; the off when it stops showing it. */
export function registerPane(file: string, h: PaneHandle): () => void {
  const k = norm(file);
  panes.set(k, [...(panes.get(k) ?? []), h]);
  return () => {
    const left = (panes.get(k) ?? []).filter((x) => x !== h);
    if (left.length) panes.set(k, left);
    else panes.delete(k);
  };
}

/** The pane showing `file` (the one with that pane id when two show it). */
export function paneOf(file: string, paneId: string | null): PaneHandle | null {
  const all = panes.get(norm(file)) ?? [];
  return all.find((h) => h.paneId === paneId) ?? all[0] ?? null;
}
