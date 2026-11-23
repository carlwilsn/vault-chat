// The app's parts that failed and show their fallback's Reload (src/PluginMount.tsx AppPluginMount): which part, why,
// and its own retry (what the Reload button does). app/titlebar's crashed state reads them and its reloadPart action
// runs the same retry; a part coming back (or going) tells the offers' watch.
type Failure = { part: string; error: string; retry: () => void };
const failures = new Map<string, Failure>();
const fns = new Set<() => void>();
const changed = () => {
  for (const f of [...fns]) f();
};

export function notePartFailed(part: string, error: string, retry: () => void): () => void {
  const f = { part, error, retry };
  failures.set(part, f);
  changed();
  return () => {
    if (failures.get(part) === f) failures.delete(part);
    changed();
  };
}
export const partFailures = () => [...failures.values()].map(({ part, error }) => ({ part, error: error.slice(0, 400) }));
export function retryPart(part: string): boolean {
  const f = failures.get(part);
  if (!f) return false;
  f.retry();
  return true;
}
export function onPartFailures(fn: () => void): () => void {
  fns.add(fn);
  return () => void fns.delete(fn);
}

// ---- the diagnostics bundle (Ctrl+Shift+D): the last one written ----
let lastDiag: { path: string; at: string } | null = null;
export const diagNow = () => lastDiag;
export function noteDiag(path: string): void {
  lastDiag = { path, at: new Date().toISOString() };
  changed();
}
