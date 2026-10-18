// Who gets to do what: the pen, fingers and palms (pure, no DOM — the
// simulator tests in test/harness/board-palm.test.ts drive it with scripted
// traces).
//
// The rules (GoodNotes-like):
// - The pen draws. A finger draws only before a Pencil has been seen and with
//   one-finger scroll off (the option); otherwise one finger pans.
// - Two fingers always pan and pinch while the Pencil is not touching the
//   screen: they land within PAIR_MS of each other, finger-sized, at most two.
//   The pen hovering, the moments after it lifts and the writing hand's side do
//   not stop them (Carl, 2026-10-18: "I can't pan and zoom with my fingers").
//   A pair that lands while the pen is near (hovering, or within LOCK_MS of it)
//   must move further before it counts (LOCKED_SLOP), so a palm settling as
//   two small contacts before the pen lands does not nudge the page.
// - One finger is held to the palm rules: while the pen is down or hovering and
//   for LOCK_MS after, on the writing hand's side of the pen tip shortly after
//   the pen was there, or resting before it moves, it does nothing.
// - A sequence (first touch down → last touch up) is poisoned by a palm-sized
//   contact, a third contact, a second finger that came too late, or the pen
//   touching down: it does nothing more until every touch has lifted, and a view
//   gesture it had started is undone (view-abort) if it was young.
// - Contact sizes are iPadOS's: WebKit reports width/height as twice UITouch's
//   majorRadius, in steps of about 20.9 px — a fingertip 41.75 or 62.6, a thumb
//   or a pressed finger 83.5, a palm 104 and more. PALM_MIN sits between.
// - A quick still two-finger tap undoes (not within UNDO_PEN_MS of the pen).
// - The chrome (toolbar, popovers, menu, inbox) is not the arbiter's: every pointer that lands on it is
//   the chrome's (chrome.ts), so a tap works with the Pencil or a finger, whatever the pen did before.
// - takeStats(): what the fingers did since the last call (pans, pinches, one-finger pans, undos, and each
//   palm rejection by its reason) for the board's log, so a real-device report can be read from the logs.

export type Kind = "pen" | "touch" | "mouse";
export type PEvent = {
  type: "down" | "move" | "up" | "cancel" | "leave";
  id: number;
  kind: Kind;
  x: number;
  y: number;
  /** Contact size in css px (0 or 1: unknown). */
  w?: number;
  h?: number;
  t: number;
  button?: number;
  /** For pen moves: 0 = hovering. */
  buttons?: number;
};

export type Action =
  | { a: "tool-start" | "tool-move" | "tool-end" | "tool-cancel"; id: number; ev: PEvent }
  | { a: "view-start"; x: number; y: number }
  | { a: "view"; x: number; y: number; scale: number }
  | { a: "view-end"; vx: number; vy: number }
  | { a: "view-abort" }
  | { a: "undo" }
  | { a: "pen-seen" };

export type Hand = "left" | "right";
export type Settings = { hand: Hand; pan1: boolean; penSeen: boolean };

export const P = {
  /** A contact this many css px across (or more) is a palm; a fingertip is 41.75–62.6, a thumb 83.5. */
  PALM_MIN: 95,
  /** A gesture's touches land within this of each other. */
  PAIR_MS: 280,
  /** A single touch that has not moved by then is resting (a palm). */
  REST_MS: 280,
  SLOP: 10,
  /** A pair that landed while the pen was near moves this far (css px) before it counts. */
  LOCKED_SLOP: 24,
  /** After the pen lifts or stops hovering, one finger stays a palm this long. */
  LOCK_MS: 600,
  /** No undo tap this soon after the pen touched. */
  UNDO_PEN_MS: 1000,
  TAP_MS: 300,
  TAP_MOVE: 10,
  /** The writing hand's side of the pen tip is palm (for one finger) this long after the pen was there… */
  HAND_MS: 2000,
  /** …within this distance of it… */
  HAND_R: 450,
  /** …and this far past the tip's vertical/horizontal line. */
  HAND_MARGIN: 40,
  /** A view gesture this young when it is poisoned is undone (the camera goes back); an older one just ends. */
  REVERT_MS: 700,
  /** Two fingers zoom only once their spread changed this much, relatively and in css px (a pan stays a pan, a drifting pair is not a pinch). */
  ZOOM_LOCK: 0.06,
  ZOOM_SLOP: 16,
};

/** Why a touch did nothing: the board's log counts these (log.ts "gestures"). */
export type PalmReason = "size" | "third-touch" | "late-second" | "pen-down" | "pen-hover" | "pen-lock" | "hand-side" | "rested";
export type GestureStats = { pan: number; pinch: number; pan1: number; undo: number; reverted: number; palm: Partial<Record<PalmReason, number>>; maxSize: number };

type Touch = { x0: number; y0: number; x: number; y: number; t0: number; size: number; movedAt: number };
type Seq = {
  poisoned: boolean;
  done: boolean;
  /** One finger that landed where or when a palm would (it does nothing unless a second finger makes a pair). */
  suspect: PalmReason | null;
  view: null | { n: 1 | 2; committed: boolean; t0: number; mid0: { x: number; y: number }; d0: number; zoomFree: boolean; slop: number; lx: number; ly: number; lt: number; vx: number; vy: number; ids: number[] };
};

const sizeOf = (e: PEvent) => {
  const s = Math.max(e.w ?? 0, e.h ?? 0);
  return s <= 1 ? 0 : s;
};

const noStats = (): GestureStats => ({ pan: 0, pinch: 0, pan1: 0, undo: 0, reverted: 0, palm: {}, maxSize: 0 });

export class Arbiter {
  /** The pointer driving the tool (pen, mouse button 0, or a finger before a pen was seen). */
  private tool: { id: number; kind: Kind } | null = null;
  private mouseView: number | null = null;
  private lastPen = -Infinity;
  private lastPenContact = -Infinity;
  private penPos: { x: number; y: number } | null = null;
  private touches = new Map<number, Touch>();
  private seq: Seq | null = null;
  private stats = noStats();

  constructor(public settings: Settings) {}

  /** For a debug overlay and the tests. */
  state() {
    return { tool: this.tool, touches: [...this.touches.entries()].map(([id, t]) => ({ id, x: t.x, y: t.y, size: t.size })), poisoned: !!this.seq?.poisoned, view: !!this.seq?.view?.committed };
  }

  /** What the fingers did since the last call (the board's log), reset. */
  takeStats(): GestureStats {
    const s = this.stats;
    this.stats = noStats();
    return s;
  }

  private count(r: PalmReason): void {
    this.stats.palm[r] = (this.stats.palm[r] ?? 0) + 1;
  }

  /** The pen is near: touching, hovering, or within LOCK_MS of either. */
  private locked(t: number): boolean {
    return this.tool?.kind === "pen" || t - this.lastPen < P.LOCK_MS;
  }
  private lockReason(t: number): PalmReason {
    return this.tool?.kind === "pen" ? "pen-down" : t - this.lastPenContact < P.LOCK_MS ? "pen-lock" : "pen-hover";
  }

  private handSide(e: PEvent): boolean {
    const p = this.penPos;
    if (!p || e.t - this.lastPen > P.HAND_MS) return false;
    if (Math.hypot(e.x - p.x, e.y - p.y) > P.HAND_R) return false;
    const below = e.y - p.y > -P.HAND_MARGIN;
    return below && (this.settings.hand === "left" ? e.x - p.x < P.HAND_MARGIN : p.x - e.x < P.HAND_MARGIN);
  }

  handle(e: PEvent): Action[] {
    if (e.kind === "pen") return this.pen(e);
    if (e.kind === "mouse") return this.mouse(e);
    return this.touch(e);
  }

  // ------------------------------------------------------------ pen

  private pen(e: PEvent): Action[] {
    const out: Action[] = [];
    const hover = e.type === "move" && this.tool?.id !== e.id && !e.buttons;
    if (e.type === "leave") {
      this.lastPen = e.t;
      return out;
    }
    if (!this.settings.penSeen && (e.type === "down" || hover)) {
      this.settings.penSeen = true;
      out.push({ a: "pen-seen" });
    }
    this.lastPen = e.t;
    this.penPos = { x: e.x, y: e.y };
    if (hover) {
      // Hovering stops one finger (a palm resting while the pen is in range), never a two-finger gesture.
      out.push(...this.hoverPoison(e.t));
      return out;
    }
    if (e.type === "down") {
      this.lastPenContact = e.t;
      if (this.tool?.kind === "pen") return out; // a second pen
      out.push(...this.poison(e.t, "pen-down"));
      this.tool = { id: e.id, kind: "pen" };
      out.push({ a: "tool-start", id: e.id, ev: e });
      return out;
    }
    if (this.tool?.id !== e.id) return out;
    this.lastPenContact = e.t;
    if (e.type === "move") out.push({ a: "tool-move", id: e.id, ev: e });
    else {
      out.push({ a: e.type === "up" ? "tool-end" : "tool-cancel", id: e.id, ev: e });
      this.tool = null;
    }
    return out;
  }

  // ------------------------------------------------------------ mouse

  private mouse(e: PEvent): Action[] {
    if (e.type === "down") {
      if (e.button === 0 && !this.tool) {
        this.tool = { id: e.id, kind: "mouse" };
        return [{ a: "tool-start", id: e.id, ev: e }];
      }
      if (e.button !== 0 && this.mouseView === null) {
        this.mouseView = e.id;
        return [{ a: "view-start", x: e.x, y: e.y }];
      }
      return [];
    }
    if (this.tool?.id === e.id && this.tool.kind === "mouse") {
      if (e.type === "move") return [{ a: "tool-move", id: e.id, ev: e }];
      if (e.type === "up" || e.type === "cancel") {
        this.tool = null;
        return [{ a: e.type === "up" ? "tool-end" : "tool-cancel", id: e.id, ev: e }];
      }
    }
    if (this.mouseView === e.id) {
      if (e.type === "move") return [{ a: "view", x: e.x, y: e.y, scale: 1 }];
      if (e.type === "up" || e.type === "cancel") {
        this.mouseView = null;
        return [{ a: "view-end", vx: 0, vy: 0 }];
      }
    }
    return [];
  }

  // ------------------------------------------------------------ touch

  /** Poison the touch sequence (if any): cancel a finger stroke, undo a young view gesture. */
  private poison(t: number, why: PalmReason): Action[] {
    const out: Action[] = [];
    if (this.tool?.kind === "touch") {
      out.push({ a: "tool-cancel", id: this.tool.id, ev: { type: "cancel", id: this.tool.id, kind: "touch", x: 0, y: 0, t: 0 } });
      this.tool = null;
    }
    const s = this.seq;
    if (s && !s.poisoned) {
      s.poisoned = true;
      this.count(why);
      if (s.view?.committed && !s.done) {
        const young = t - s.view.t0 < P.REVERT_MS;
        if (young) this.stats.reverted++;
        out.push(young ? { a: "view-abort" } : { a: "view-end", vx: 0, vy: 0 });
      }
      s.view = null;
    }
    return out;
  }

  /** The pen hovering: a finger stroke or a moving one-finger pan stops; a one-finger pan not yet moving waits
   *  (a second finger may still make a pair); two fingers go on. */
  private hoverPoison(t: number): Action[] {
    const s = this.seq;
    if (!s || s.poisoned || s.done) return [];
    if (this.tool?.kind === "touch" || (s.view?.n === 1 && s.view.committed)) return this.poison(t, "pen-hover");
    if (s.view?.n === 1) {
      s.view = null;
      s.suspect = "pen-hover";
    }
    return [];
  }

  private touch(e: PEvent): Action[] {
    const t = e.t;
    if (e.type === "leave") return [];
    if (e.type === "down") {
      if (!this.touches.size) this.seq = { poisoned: false, done: false, suspect: null, view: null };
      const size = sizeOf(e);
      this.stats.maxSize = Math.max(this.stats.maxSize, size);
      this.touches.set(e.id, { x0: e.x, y0: e.y, x: e.x, y: e.y, t0: t, size, movedAt: 0 });
      const s = this.seq!;
      if (s.poisoned || s.done) return [];
      if (this.tool?.kind === "pen") return this.poison(t, "pen-down");
      if (size >= P.PALM_MIN) return this.poison(t, "size");
      if (this.touches.size > 2) return this.poison(t, "third-touch");
      if (this.touches.size === 1) {
        // One finger: where and when a palm lands, it waits (a second finger may make it a pair).
        const why: PalmReason | null = this.locked(t) ? this.lockReason(t) : this.handSide(e) ? "hand-side" : null;
        if (why) {
          s.suspect = why;
          return [];
        }
        if (this.settings.pan1) {
          this.startView(1, t, P.SLOP);
          return [];
        }
        if (!this.settings.penSeen) {
          // No Pencil yet and one-finger scroll off: one finger writes, a second one turns it into a view gesture.
          this.tool = { id: e.id, kind: "touch" };
          return [{ a: "tool-start", id: e.id, ev: e }];
        }
        return [];
      }
      // A second finger: a pair when it came in time (or joins a one-finger pan already moving).
      const first = [...this.touches.entries()].find(([id]) => id !== e.id)![1];
      const out: Action[] = [];
      if (s.view?.n === 1 && s.view.committed) out.push({ a: "view-end", vx: 0, vy: 0 });
      else if (t - first.t0 > P.PAIR_MS) return this.poison(t, "late-second");
      if (this.tool?.kind === "touch") {
        out.push({ a: "tool-cancel", id: this.tool.id, ev: e });
        this.tool = null;
      }
      // Landed while the pen was near: it has to mean it (a palm settling as two small contacts moves a little).
      const near = s.suspect !== null || this.locked(t) || this.handSide(e);
      s.suspect = null;
      this.startView(2, t, near ? P.LOCKED_SLOP : P.SLOP);
      return out;
    }

    const tc = this.touches.get(e.id);
    if (!tc) return [];
    tc.x = e.x;
    tc.y = e.y;
    tc.size = Math.max(tc.size, sizeOf(e));
    this.stats.maxSize = Math.max(this.stats.maxSize, tc.size);
    if (!tc.movedAt && Math.hypot(e.x - tc.x0, e.y - tc.y0) > P.SLOP) tc.movedAt = t;
    const s = this.seq;

    if (e.type === "up" || e.type === "cancel") {
      this.touches.delete(e.id);
      const out: Action[] = [];
      if (this.tool?.id === e.id && this.tool.kind === "touch") {
        out.push({ a: e.type === "up" ? "tool-end" : "tool-cancel", id: e.id, ev: e });
        this.tool = null;
      }
      if (s && !s.poisoned && !s.done && s.view && s.view.ids.includes(e.id)) {
        const v = s.view;
        if (v.committed) {
          const fresh = t - v.lt < 80;
          out.push({ a: "view-end", vx: fresh ? v.vx : 0, vy: fresh ? v.vy : 0 });
        } else if (v.n === 2 && e.type === "up" && t - v.t0 <= P.TAP_MS && t - this.lastPenContact > P.UNDO_PEN_MS && !this.locked(t)) {
          const other = this.touches.get(v.ids.find((i) => i !== e.id)!);
          const still = (q: Touch | undefined) => !q || Math.hypot(q.x - q.x0, q.y - q.y0) < P.TAP_MOVE;
          if (still(tc) && still(other)) {
            this.stats.undo++;
            out.push({ a: "undo" });
          }
        }
        s.done = true;
        s.view = null;
      }
      // A lone finger that landed like a palm and then moved: counted (it moved nothing).
      if (s && !this.touches.size && s.suspect && !s.poisoned && tc.movedAt) this.count(s.suspect);
      if (!this.touches.size) this.seq = null;
      return out;
    }

    // A move.
    if (!s || s.poisoned || s.done) return [];
    if (tc.size >= P.PALM_MIN) return this.poison(t, "size");
    if (this.tool?.id === e.id && this.tool.kind === "touch") {
      if (this.locked(t)) return this.poison(t, this.lockReason(t));
      return [{ a: "tool-move", id: e.id, ev: e }];
    }
    const v = s.view;
    if (!v || !v.ids.includes(e.id)) return [];
    // One finger is a palm while the pen is near; two fingers go on while it is not touching.
    if (v.n === 1 && this.locked(t)) return this.poison(t, this.lockReason(t));
    const pts = v.ids.map((i) => this.touches.get(i)!).filter(Boolean);
    if (pts.length !== v.n) return [];
    const mid = { x: pts.reduce((a, q) => a + q.x, 0) / v.n, y: pts.reduce((a, q) => a + q.y, 0) / v.n };
    const d = v.n === 2 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : 1;
    const spread = (min: number) => Math.abs(d / v.d0 - 1) > P.ZOOM_LOCK && Math.abs(d - v.d0) > min;
    const out: Action[] = [];
    if (!v.committed) {
      if (v.n === 1) {
        if (!tc.movedAt) return [];
        // A finger that rested before it moved is a palm.
        if (tc.movedAt - tc.t0 > P.REST_MS) return this.poison(t, "rested");
      } else if (Math.hypot(mid.x - v.mid0.x, mid.y - v.mid0.y) <= v.slop && !spread(Math.max(P.ZOOM_SLOP, v.slop))) return [];
      v.committed = true;
      v.lx = v.mid0.x;
      v.ly = v.mid0.y;
      v.lt = t;
      if (v.n === 1) this.stats.pan1++;
      else this.stats.pan++;
      out.push({ a: "view-start", x: v.mid0.x, y: v.mid0.y });
    }
    if (!v.zoomFree && v.n === 2 && spread(P.ZOOM_SLOP)) {
      v.zoomFree = true;
      this.stats.pinch++;
    }
    const dt = Math.max(1, t - v.lt);
    v.vx = 0.8 * ((mid.x - v.lx) / dt) + 0.2 * v.vx;
    v.vy = 0.8 * ((mid.y - v.ly) / dt) + 0.2 * v.vy;
    v.lx = mid.x;
    v.ly = mid.y;
    v.lt = t;
    out.push({ a: "view", x: mid.x, y: mid.y, scale: v.zoomFree ? d / v.d0 : 1 });
    return out;
  }

  private startView(n: 1 | 2, t: number, slop: number): void {
    const ids = [...this.touches.keys()].slice(-n);
    const pts = ids.map((i) => this.touches.get(i)!);
    const mid0 = { x: pts.reduce((a, q) => a + q.x, 0) / n, y: pts.reduce((a, q) => a + q.y, 0) / n };
    const d0 = n === 2 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) || 1 : 1;
    this.seq!.view = { n, committed: false, t0: t, mid0, d0, zoomFree: false, slop, lx: mid0.x, ly: mid0.y, lt: t, vx: 0, vy: 0, ids };
  }
}
