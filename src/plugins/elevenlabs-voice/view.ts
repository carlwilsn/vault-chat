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
