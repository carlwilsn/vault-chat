// When Carl last touched the laptop app (a real key, click, wheel or mouse movement in one of its own windows), for
// the gate's Drive-copy runs (src/driveOnLaptop.ts): they refuse while he is using the laptop and stop the moment he
// starts. Only trusted events count (the app's own synthetic events never do), and only those the app's windows see:
// input in other programs is not visible to it. Holds a timestamp, nothing about what was typed or where.
type Listener = (kind: string) => void;
let last = -Infinity;
let installed = false;
const listeners = new Set<Listener>();

/** Note one real input (exported for the windows that forward theirs, and tests). */
export function noteInput(kind: string, at = Date.now()): void {
  last = Math.max(last, at);
  for (const fn of [...listeners]) fn(kind);
}

/** ms since the last real input in the app's windows; Infinity when none was seen since it started. */
export function idleMs(now = Date.now()): number {
  return Number.isFinite(last) ? Math.max(0, now - last) : Infinity;
}

/** Call `fn` on the next real inputs until the returned function is called. */
export function onInput(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Main window: watch real input. Mouse movement counts only past a few pixels (a jiggle of the desk does not). */
export function installUserActivity(win: Window = window): void {
  if (installed) return;
  installed = true;
  let mx = NaN;
  let my = NaN;
  const opts = { capture: true, passive: true } as const;
  for (const type of ["keydown", "pointerdown", "wheel", "touchstart"] as const) {
    win.addEventListener(type, (e) => { if (e.isTrusted) noteInput(type); }, opts);
  }
  win.addEventListener("pointermove", (e) => {
    if (!e.isTrusted) return;
    if (Number.isNaN(mx) || Math.abs(e.screenX - mx) + Math.abs(e.screenY - my) > 6) {
      const first = Number.isNaN(mx);
      mx = e.screenX;
      my = e.screenY;
      if (!first) noteInput("pointermove");
    }
  }, opts);
}

/** Tests: forget. */
export function _resetUserActivity(): void {
  last = -Infinity;
  listeners.clear();
}

/** Tests: how many run-time listeners are attached now (0 between runs). */
export function _inputListenerCount(): number {
  return listeners.size;
}
