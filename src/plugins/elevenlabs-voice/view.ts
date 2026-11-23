// The ElevenLabs voice panel's open state: kept by the plugin, not by React, so the panel and the plugin's offers
// (./index.tsx) share it. It lasts as long as the plugin's run (turned off, the panel goes with it).
export type PanelView = {
  get(): boolean;
  set(open: boolean): void;
  subscribe(fn: () => void): () => void;
};

export function createPanelView(): PanelView {
  let open = false;
  const fns = new Set<() => void>();
  return {
    get: () => open,
    set(v) {
      if (v === open) return;
      open = v;
      for (const f of [...fns]) f();
    },
    subscribe(fn) {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
  };
}

/** The panel's parts on screen (its voice section, its health row, the voice library) register what they show and
 *  their own controls while drawn, so the offers read and run what Carl's clicks do (report 28: they were local). */
export type PanelPart = { state(): Record<string, unknown>; act: Record<string, (a: Record<string, unknown>) => unknown> };
const parts = new Map<string, PanelPart>();
const partFns = new Set<() => void>();
export function registerPanelPart(name: string, p: PanelPart): () => void {
  parts.set(name, p);
  panelChanged();
  return () => {
    if (parts.get(name) === p) parts.delete(name);
    panelChanged();
  };
}
/** Something a part shows changed (it calls this after each render). */
export function panelChanged(): void {
  for (const f of [...partFns]) f();
}
export function onPanelChanged(fn: () => void): () => void {
  partFns.add(fn);
  return () => void partFns.delete(fn);
}
export function panelParts(): Record<string, Record<string, unknown>> {
  return Object.fromEntries([...parts].map(([k, p]) => [k, p.state()]));
}
export function panelAct(part: string, action: string, a: Record<string, unknown> = {}): unknown {
  const p = parts.get(part);
  if (!p) throw new Error(part === "library" ? "the voice library is not open (browseLibrary opens it)" : `the panel's ${part} is not on screen (open the panel; it needs the key ELEVENLABS_API_KEY)`);
  const f = p.act[action];
  if (!f) throw new Error(`no ${action} on the panel's ${part}`);
  return f(a);
}
