// A terminal or a file opened outside the app, followed until it closes (the native shell's tracked_open,
// src-tauri/src/tracked_open.rs): its id while open, and "tracked-exited" when its window goes. An older shell without
// the command: null (the caller opens it the old way and says it can't tell when it closes).
import { invoke } from "@tauri-apps/api/core";

export type Tracked = { id: string; kind: "terminal" | "open"; open: boolean; quick?: boolean };
const items = new Map<string, Tracked>();
const fns = new Set<() => void>();
const changed = () => {
  for (const f of [...fns]) f();
};
let listening = false;
async function listenExits(): Promise<void> {
  if (listening) return;
  listening = true;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ id: string; ms: number }>("tracked-exited", (e) => {
      const t = items.get(e.payload.id);
      if (!t) return;
      // Back at once: the program handed it to an instance already running, so its own window can't be followed.
      items.set(t.id, { ...t, open: false, ...(e.payload.ms < 1500 ? { quick: true } : {}) });
      changed();
    });
  } catch {
    listening = false;
  }
}

/** Open it tracked; null when this shell can't track (open it the old way). */
export async function openTracked(kind: "terminal" | "open", target: string): Promise<string | null> {
  try {
    await listenExits();
    const r = await invoke<{ id: string }>("tracked_open", { kind, target });
    items.set(r.id, { id: r.id, kind, open: true });
    changed();
    return r.id;
  } catch {
    return null;
  }
}
/** Close it, as closing its window does. */
export async function closeTracked(id: string): Promise<void> {
  await invoke("tracked_close", { id });
}
export const trackedNow = (id: string): Tracked | null => items.get(id) ?? null;
export function onTrackedChanged(fn: () => void): () => void {
  fns.add(fn);
  return () => void fns.delete(fn);
}
