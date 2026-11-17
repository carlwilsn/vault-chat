// What the place an app plugin's part is mounted in hands it (src/PluginMount.tsx AppPluginMount `props`): the Ctrl+K
// box its request and its Accept / Cancel, a viewer pane its pane. The part reads them as api.props (get / on), live:
// the place redraws with other props and the part follows without a remount. Functions are passed through as they are
// now (get() always has the newest) but a new function alone is not a change, so a parent's inline callbacks never
// redraw the part.
import { useSyncExternalStore } from "react";

export type PluginProps<P> = {
  /** The props as the place last drew them. */
  get(): P;
  /** Called when they change (a function alone changing is not a change). Returns the way to stop. */
  on(fn: () => void): () => void;
};

export type PropsChannel<P> = PluginProps<P> & { set(next: P): void };

/** Shallowly the same: every key the same value, a function counting the same as any other function. */
export function sameProps(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = (a as Record<string, unknown>)[k];
    const y = (b as Record<string, unknown>)[k];
    if (Object.is(x, y)) continue;
    if (typeof x === "function" && typeof y === "function") continue;
    return false;
  }
  return true;
}

export function propsChannel<P>(initial: P): PropsChannel<P> {
  let cur = initial;
  let shown = initial;
  const fns = new Set<() => void>();
  return {
    get: () => cur,
    on(fn) {
      fns.add(fn);
      return () => void fns.delete(fn);
    },
    set(next) {
      cur = next;
      if (sameProps(shown, next)) return;
      shown = next;
      for (const fn of [...fns]) fn();
    },
  };
}

/** In a part's own React root: its props, redrawn when the place hands it new ones. */
export function useProps<P>(props: PluginProps<P>): P {
  return useSyncExternalStore(props.on, props.get, props.get);
}
