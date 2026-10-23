// Is Carl looking at this surface? Each surface says so to the box (POST /api/v1/attention), and
// the box buzzes his phone only when none is (server/pushGate.ts).
//
//   phone, iPad  looking while the app is on screen (the screen locking or another app hides it)
//   laptop       looking while the window is shown and focused and he touched it in the last few
//                minutes (an app left open on an empty desk is not someone looking)
//
// A beat every 30 s while looking (the box forgets one after 75 s), one at once on every change,
// and a last "not looking" when the surface goes away. Never throws; a failed post just drops.

export type AttentionDevice = "laptop" | "phone" | "board";
export type AttentionBody = { device: AttentionDevice; looking: boolean; convId: string | null };

export const BEAT_EVERY_MS = 30_000;
/** The laptop: no keyboard, mouse or touch for this long and he is not looking. */
export const LAPTOP_IDLE_MS = 5 * 60_000;

export type AttentionBeat = {
  /** The open conversation changed (or anything else worth saying at once). */
  poke: () => void;
  stop: () => void;
  /** Tests: what the surface would say now. */
  looking: () => boolean;
};

export function startAttentionBeat(o: {
  device: AttentionDevice;
  post: (b: AttentionBody) => void | Promise<unknown>;
  convId?: () => string | null;
  /** Input must be this recent (the laptop); none: on screen is enough. */
  idleMs?: number;
  now?: () => number;
}): AttentionBeat {
  const now = o.now ?? (() => Date.now());
  let lastInput = now();
  let last: { looking: boolean; convId: string | null } | null = null;
  let lastAt = 0;
  let stopped = false;

  const looking = (): boolean => {
    if (typeof document === "undefined" || !document) return false;
    if (document.visibilityState !== "visible") return false;
    if (!o.idleMs) return true;
    const focused = typeof document.hasFocus === "function" ? document.hasFocus() : true;
    return focused && now() - lastInput < o.idleMs;
  };

  const say = (force = false) => {
    if (stopped) return;
    const l = looking();
    const c = o.convId?.() ?? null;
    const changed = !last || last.looking !== l || last.convId !== c;
    // While looking: a beat every 30 s. Not looking: said once.
    if (!changed && !force && !(l && now() - lastAt >= BEAT_EVERY_MS - 1000)) return;
    last = { looking: l, convId: c };
    lastAt = now();
    try {
      void Promise.resolve(o.post({ device: o.device, looking: l, convId: c })).catch(() => undefined);
    } catch {
      /* dropped */
    }
  };

  const onInput = () => {
    const wasIdle = !!o.idleMs && now() - lastInput >= o.idleMs;
    lastInput = now();
    if (wasIdle || !last?.looking) say();
  };
  const onChange = () => say();
  const timer = setInterval(() => say(), 10_000);
  (timer as { unref?: () => void }).unref?.();
  const inputs = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
  const hasWin = typeof window !== "undefined" && typeof window.addEventListener === "function";
  const hasDoc = typeof document !== "undefined" && typeof document.addEventListener === "function";
  if (hasWin) {
    for (const ev of inputs) window.addEventListener(ev, onInput, { passive: true, capture: true });
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    window.addEventListener("pagehide", onChange);
  }
  if (hasDoc) document.addEventListener("visibilitychange", onChange);
  say(true);

  return {
    poke: () => say(true),
    looking,
    stop: () => {
      if (stopped) return;
      clearInterval(timer);
      if (hasWin) {
        for (const ev of inputs) window.removeEventListener(ev, onInput, { capture: true });
        window.removeEventListener("focus", onChange);
        window.removeEventListener("blur", onChange);
        window.removeEventListener("pagehide", onChange);
      }
      if (hasDoc) document.removeEventListener("visibilitychange", onChange);
      try {
        void Promise.resolve(o.post({ device: o.device, looking: false, convId: o.convId?.() ?? null })).catch(() => undefined);
      } catch {
        /* dropped */
      }
      stopped = true;
    },
  };
}
