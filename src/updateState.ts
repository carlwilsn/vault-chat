// The update banner as state (Native agency: it was screen-only; LaptopBuild read versions, not the banner). The
// banner (src/UpdateBanner.tsx) publishes where it stands and hands over its own actions; app/titlebar offers them:
// `update` to read, checkUpdates / installUpdate / dismissUpdate to act, `updateChanged` to watch.
export type UpdateSummary = { state: "idle" | "available" | "downloading" | "installing" | "error" | "checked"; version?: string; notes?: string; downloaded?: number; total?: number | null; message?: string };
type Actions = { install: () => Promise<void> | void; dismiss: () => void; check: () => void };

const KEY = "__vcUpdateState";
type Slot = { now: UpdateSummary; actions: Actions | null; fns: Set<(s: UpdateSummary) => void> };
function slot(): Slot {
  const g = globalThis as Record<string, unknown>;
  return ((g[KEY] as Slot | undefined) ??= { now: { state: "idle" }, actions: null, fns: new Set() });
}

export function publishUpdate(s: UpdateSummary, actions: Actions): void {
  const x = slot();
  const changed = JSON.stringify(x.now) !== JSON.stringify(s);
  x.now = s;
  x.actions = actions;
  if (changed) for (const f of [...x.fns]) f(s);
}
export const updateNow = (): UpdateSummary => slot().now;
export const updateActions = (): Actions | null => slot().actions;
export function onUpdateChanged(fn: (s: UpdateSummary) => void): () => void {
  slot().fns.add(fn);
  return () => void slot().fns.delete(fn);
}
