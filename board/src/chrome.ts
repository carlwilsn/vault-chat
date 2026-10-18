// Taps on the chrome (toolbar, popovers, the ⋯ menu, the inbox sheet and its viewer, the selection pill):
// any pointer — the Pencil, a finger or the mouse — presses the button it went down and came up on, once.
// None of the ink, palm or gesture logic sees these pointers (view.ts routes everything off the canvas here).
//
// A button acts on its pointerup, not on the click iOS may or may not synthesise after it; the click
// that does follow the same tap is then dropped — wherever it lands: the press may have put something
// new under the finger (the inbox's scrim, a popover), and that must not take the click and undo it.
// A click with no pointer before it (the keyboard, a test's element.click()) acts as usual.
// A button that was redrawn while the finger was on it (the inbox list repaints when the box's list arrives,
// the pill's chat list on every voice state change) is the same button when it says the same (`same`): the
// new one is pressed, not missed.
// Pure: the tests drive it as it is.

export type ChromeOpts<B = unknown> = {
  /** A tap moving further than this (css px) is not a press (a scroll, a drag). */ slop?: number;
  /** A click this soon after a pointerup press of the same button repeats it. */ dedupeMs?: number;
  /** The button it went down on, redrawn since, and the one under it now are the same button. */ same?: (down: B, now: B) => boolean;
  /** A short name for a button (the log's missedOn). */ name?: (b: B) => string;
};

export class ChromeTaps<B> {
  private downs = new Map<number, { b: B | null; x: number; y: number }>();
  private last: number | null = null;
  private slop: number;
  private dedupeMs: number;
  private same: ((down: B, now: B) => boolean) | undefined;
  private name: ((b: B) => string) | undefined;
  /** Since the last takeStats(): taps that pressed their button, taps on a button that pressed nothing (moved off it, slid too far) and on which, native clicks dropped as a tap's tail. */
  private stats = { pressed: 0, missed: 0, dropped: 0, missedOn: [] as string[] };

  constructor(
    /** Press the button (view.ts: its click handlers run, once). */
    private press: (b: B) => void,
    o: ChromeOpts<B> = {},
  ) {
    this.slop = o.slop ?? 12;
    this.dedupeMs = o.dedupeMs ?? 800;
    this.same = o.same;
    this.name = o.name;
  }

  /** A pointer went down on the chrome, on button `b` (or on none): it is the chrome's until it lifts. */
  down(id: number, b: B | null, x: number, y: number): void {
    this.downs.set(id, { b, x, y });
  }

  /** It came up over `over` (the button under it now): the press, when it is the same button. True when it pressed. */
  up(id: number, over: B | null, x: number, y: number, t: number): boolean {
    const d = this.downs.get(id);
    this.downs.delete(id);
    const sameButton = !!d?.b && over !== null && (d.b === over || !!this.same?.(d.b, over));
    if (!d || !d.b || !sameButton || Math.hypot(x - d.x, y - d.y) > this.slop) {
      if (d?.b) {
        this.stats.missed++;
        if (this.name && this.stats.missedOn.length < 8) this.stats.missedOn.push(this.name(d.b) + (over === null ? ">none" : !sameButton ? ">" + this.name(over) : ">moved"));
      }
      return false;
    }
    this.last = t;
    this.stats.pressed++;
    this.press(over as B);
    return true;
  }

  /** The tap counts since the last call (the board's log, board/src/log.ts), reset. */
  takeStats(): { pressed: number; missed: number; dropped: number; missedOn?: string[] } {
    const { missedOn, ...s } = this.stats;
    this.stats = { pressed: 0, missed: 0, dropped: 0, missedOn: [] };
    return missedOn.length ? { ...s, missedOn } : s;
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
    const keep = !(l !== null && t - l < this.dedupeMs);
    if (!keep) this.stats.dropped++;
    return keep;
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

/** What a chrome button says (a redrawn copy says the same): its tag, data attributes, label and text. */
export function buttonSignature(b: HTMLElement): string {
  return [b.tagName, JSON.stringify({ ...b.dataset }), b.getAttribute("aria-label") ?? "", (b.textContent ?? "").trim().slice(0, 80)].join("|");
}

/** The same button, redrawn: the one the finger went down on is gone from the page, the one under it now says the same. */
export function redrawnSame(down: HTMLElement, now: HTMLElement): boolean {
  return !down.isConnected && buttonSignature(down) === buttonSignature(now);
}

/** A button's name in the log: what it does, never what it shows (a chat's or an entry's title is not logged). */
export function buttonName(b: HTMLElement): string {
  const d = b.dataset;
  const k =
    d.act ?? d.mode ?? d.pop ?? d.v ?? d.x ?? d.m ?? (d.add !== undefined ? "add" : d.id !== undefined ? "entry" : d.size ? "size" : d.color ? "color" : d.grid ? "grid" : d.hand ? "hand" : d.pan1 ? "pan1" : d.eraser ? "eraser-kind" : null);
  return (k ?? b.getAttribute("aria-label") ?? "button").slice(0, 24);
}

/**
 * A native field (an input, a textarea, a select, contenteditable): fully the browser's. The chrome's tap handling,
 * the click dedupe, the gesture/touch prevention and the board's keys leave it alone — iOS raises its keyboard
 * and places the caret only when the field's own touches and keys reach it untouched.
 */
export function isField(t: unknown): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/** A field that takes typing (Backspace, ⌘Z are the field's own there, not the board's). */
export function isTextField(t: unknown): boolean {
  const el = t as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable === true) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  return !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test(el.type ?? "text");
}
