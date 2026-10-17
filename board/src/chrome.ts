// Taps on the chrome (toolbar, popovers, the ⋯ menu, the inbox sheet and its viewer, the selection pill):
// any pointer — the Pencil, a finger or the mouse — presses the button it went down and came up on, once.
// None of the ink, palm or gesture logic sees these pointers (view.ts routes everything off the canvas here).
//
// A button acts on its pointerup, not on the click iOS may or may not synthesise after it; the click
// that does follow the same tap is then dropped — wherever it lands: the press may have put something
// new under the finger (the inbox's scrim, a popover), and that must not take the click and undo it.
// A click with no pointer before it (the keyboard, a test's element.click()) acts as usual.
// Pure: the tests drive it as it is.

export type ChromeOpts = { /** A tap moving further than this (css px) is not a press (a scroll, a drag). */ slop?: number; /** A click this soon after a pointerup press of the same button repeats it. */ dedupeMs?: number };

export class ChromeTaps<B> {
  private downs = new Map<number, { b: B | null; x: number; y: number }>();
  private last: number | null = null;
  private slop: number;
  private dedupeMs: number;

  constructor(
    /** Press the button (view.ts: its click handlers run, once). */
    private press: (b: B) => void,
    o: ChromeOpts = {},
  ) {
    this.slop = o.slop ?? 12;
    this.dedupeMs = o.dedupeMs ?? 800;
  }

  /** A pointer went down on the chrome, on button `b` (or on none): it is the chrome's until it lifts. */
  down(id: number, b: B | null, x: number, y: number): void {
    this.downs.set(id, { b, x, y });
  }

  /** It came up over `over` (the button under it now): the press, when it is the same button. True when it pressed. */
  up(id: number, over: B | null, x: number, y: number, t: number): boolean {
    const d = this.downs.get(id);
    this.downs.delete(id);
    if (!d || !d.b || d.b !== over || Math.hypot(x - d.x, y - d.y) > this.slop) return false;
    this.last = t;
    this.press(d.b);
    return true;
  }

  /** The browser took the pointer (a scroll began, the system cancelled it): no press. */
  cancel(id: number): void {
    this.downs.delete(id);
  }

  /** Is this pointer one of the chrome's (it went down on the chrome)? */
  has(id: number): boolean {
    return this.downs.has(id);
  }

  /** A native click, anywhere: false when it is the tail of a tap its pointerup already pressed (drop it). */
  click(t: number): boolean {
    const l = this.last;
    this.last = null;
    return !(l !== null && t - l < this.dedupeMs);
  }
}

/**
 * Route one pointer event (view.ts onPointer): true when the chrome took it. A pointer that went down off the
 * canvas is the chrome's until it lifts; `at` is the button at the event (for an up: the one under it now).
 */
export function routeChrome<B>(c: ChromeTaps<B>, e: { type: "down" | "move" | "up" | "cancel" | "leave"; id: number; x: number; y: number; t: number }, onCanvas: boolean, at: () => B | null): boolean {
  if (e.type === "down") {
    // A pointer id can come back (the mouse, a Pencil): a down on the canvas is the canvas's, whatever came before.
    if (onCanvas) {
      c.cancel(e.id);
      return false;
    }
    c.down(e.id, at(), e.x, e.y);
    return true;
  }
  if (!c.has(e.id)) return false;
  if (e.type === "up") c.up(e.id, at(), e.x, e.y, e.t);
  else if (e.type === "cancel") c.cancel(e.id);
  return true;
}
