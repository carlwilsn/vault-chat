// Who gets to do what: the pen, fingers and palms (pure, no DOM — the
// simulator tests in test/harness/board-palm.test.ts drive it with scripted
// traces).
//
// The rules (GoodNotes-like):
// - The pen draws; nothing else does once a Pencil has been seen on the device
//   (before that, one finger draws so the board works without one).
// - While the pen is down or hovering, and for LOCK_MS after it lifts or stops
//   hovering, every new touch is a palm.
// - A touch sequence (first touch down → last touch up) is poisoned by any
//   palm-like contact: too large (width/height), on the writing hand's side of
//   the pen tip shortly after the pen was there, a contact that rested before
//   moving, a second finger that came too late to be a gesture, a third
//   contact, or the pen arriving. A poisoned sequence does nothing more until
//   every touch has lifted; a view gesture it had started is undone
//   (view-abort restores the camera), so a palm never pans or zooms the page.
// - Gestures: two fingers that land within PAIR_MS of each other pan and
//   pinch; a quick still two-finger tap undoes (not within UNDO_PEN_MS of the
//   pen). One-finger pan only when that setting is on, and only for a finger
//   that starts moving before REST_MS.
// - The chrome (toolbar, popovers, menu, inbox) is not the arbiter's: every pointer that lands on it is
//   the chrome's (chrome.ts), so a tap works with the Pencil or a finger, whatever the pen did before.

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
  /** A finger's contact: at most this many css px across. */
  FINGER_MAX: 56,
  /** A gesture's touches land within this of each other. */
  PAIR_MS: 200,
  /** A single touch that has not moved by then is resting (a palm). */
  REST_MS: 280,
  SLOP: 10,
  /** After the pen lifts or stops hovering, touches stay palms this long. */
  LOCK_MS: 600,
  /** No undo tap this soon after the pen touched. */
  UNDO_PEN_MS: 1000,
  TAP_MS: 300,
  TAP_MOVE: 10,
  /** The writing hand's side of the pen tip is palm this long after the pen was there… */
  HAND_MS: 2000,
  /** …within this distance of it… */
  HAND_R: 450,
  /** …and this far past the tip's vertical/horizontal line. */
  HAND_MARGIN: 40,
  /** A view gesture this young when it is poisoned is undone (the camera goes back); an older one just ends. */
  REVERT_MS: 700,
  /** Two fingers zoom only once their spread changed this much (a pan stays a pan). */
  ZOOM_LOCK: 0.06,
};

type Touch = { x0: number; y0: number; x: number; y: number; t0: number; size: number; movedAt: number };
type Seq = {
  poisoned: boolean;
  done: boolean;
  view: null | { n: 1 | 2; committed: boolean; t0: number; mid0: { x: number; y: number }; d0: number; zoomFree: boolean; lx: number; ly: number; lt: number; vx: number; vy: number; ids: number[] };
};

const sizeOf = (e: PEvent) => {
  const s = Math.max(e.w ?? 0, e.h ?? 0);
  return s <= 1 ? 0 : s;
};

export class Arbiter {
  /** The pointer driving the tool (pen, mouse button 0, or a finger before a pen was seen). */
  private tool: { id: number; kind: Kind } | null = null;
  private mouseView: number | null = null;
  private lastPen = -Infinity;
  private lastPenContact = -Infinity;
  private penPos: { x: number; y: number } | null = null;
  private touches = new Map<number, Touch>();
  private seq: Seq | null = null;

  constructor(public settings: Settings) {}

  /** For a debug overlay and the tests. */
  state() {
    return { tool: this.tool, touches: [...this.touches.entries()].map(([id, t]) => ({ id, x: t.x, y: t.y, size: t.size })), poisoned: !!this.seq?.poisoned, view: !!this.seq?.view?.committed };
  }

  private locked(t: number): boolean {
    return this.tool?.kind === "pen" || t - this.lastPen < P.LOCK_MS;
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
      out.push(...this.poison(e.t));
      return out;
    }
    if (e.type === "down") {
      this.lastPenContact = e.t;
      if (this.tool?.kind === "pen") return out; // a second pen
      out.push(...this.poison(e.t));
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

  /** Poison the touch sequence (if any): cancel a finger stroke, undo a view gesture. */
  private poison(t: number): Action[] {
    const out: Action[] = [];
    if (this.tool?.kind === "touch") {
      out.push({ a: "tool-cancel", id: this.tool.id, ev: { type: "cancel", id: this.tool.id, kind: "touch", x: 0, y: 0, t: 0 } });
      this.tool = null;
    }
    const s = this.seq;
    if (s && !s.poisoned) {
      s.poisoned = true;
      if (s.view?.committed && !s.done) out.push(t - s.view.t0 < P.REVERT_MS ? { a: "view-abort" } : { a: "view-end", vx: 0, vy: 0 });
      s.view = null;
    }
    return out;
  }

  private touch(e: PEvent): Action[] {
    const t = e.t;
    if (e.type === "leave") return [];
    if (e.type === "down") {
      if (!this.touches.size) this.seq = { poisoned: false, done: false, view: null };
      this.touches.set(e.id, { x0: e.x, y0: e.y, x: e.x, y: e.y, t0: t, size: sizeOf(e), movedAt: 0 });
      const s = this.seq!;
      if (s.poisoned || s.done) return [];
      if (this.locked(t) || sizeOf(e) > P.FINGER_MAX || this.handSide(e) || this.touches.size > 2) return this.poison(e.t);
      if (!this.settings.penSeen) {
        // No Pencil: one finger writes, a second one turns it into a view gesture.
        if (this.touches.size === 1) {
          this.tool = { id: e.id, kind: "touch" };
          return [{ a: "tool-start", id: e.id, ev: e }];
        }
        const out: Action[] = [];
        if (this.tool?.kind === "touch") {
          out.push({ a: "tool-cancel", id: this.tool.id, ev: e });
          this.tool = null;
        }
        this.startView(2, t);
        return out;
      }
      if (this.touches.size === 1) {
        if (this.settings.pan1) this.startView(1, t);
        return [];
      }
      // A second finger: a gesture only if the first one did not rest.
      const first = [...this.touches.entries()].find(([id]) => id !== e.id)![1];
      const out: Action[] = [];
      if (s.view?.n === 1 && s.view.committed) {
        out.push({ a: "view-end", vx: 0, vy: 0 });
      } else if (t - first.t0 > P.PAIR_MS) return this.poison(e.t);
      this.startView(2, t);
      return out;
    }

    const tc = this.touches.get(e.id);
    if (!tc) return [];
    tc.x = e.x;
    tc.y = e.y;
    tc.size = Math.max(tc.size, sizeOf(e));
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
          if (still(tc) && still(other)) out.push({ a: "undo" });
        }
        s.done = true;
        s.view = null;
      }
      if (!this.touches.size) this.seq = null;
      return out;
    }

    // A move.
    if (!s || s.poisoned || s.done) return [];
    if (tc.size > P.FINGER_MAX || this.locked(t)) return this.poison(e.t);
    if (this.tool?.id === e.id && this.tool.kind === "touch") return [{ a: "tool-move", id: e.id, ev: e }];
    const v = s.view;
    if (!v || !v.ids.includes(e.id)) return [];
    const pts = v.ids.map((i) => this.touches.get(i)!).filter(Boolean);
    if (pts.length !== v.n) return [];
    const mid = { x: pts.reduce((a, q) => a + q.x, 0) / v.n, y: pts.reduce((a, q) => a + q.y, 0) / v.n };
    const d = v.n === 2 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) : 1;
    const out: Action[] = [];
    if (!v.committed) {
      if (v.n === 1) {
        if (!tc.movedAt) return [];
        // A finger that rested before it moved is a palm.
        if (tc.movedAt - tc.t0 > P.REST_MS) return this.poison(e.t);
      } else if (Math.hypot(mid.x - v.mid0.x, mid.y - v.mid0.y) <= P.SLOP && Math.abs(d / v.d0 - 1) <= P.ZOOM_LOCK) return [];
      v.committed = true;
      v.lx = v.mid0.x;
      v.ly = v.mid0.y;
      v.lt = t;
      out.push({ a: "view-start", x: v.mid0.x, y: v.mid0.y });
    }
    if (!v.zoomFree && Math.abs(d / v.d0 - 1) > P.ZOOM_LOCK) v.zoomFree = true;
    const dt = Math.max(1, t - v.lt);
    v.vx = 0.8 * ((mid.x - v.lx) / dt) + 0.2 * v.vx;
    v.vy = 0.8 * ((mid.y - v.ly) / dt) + 0.2 * v.vy;
    v.lx = mid.x;
    v.ly = mid.y;
    v.lt = t;
    out.push({ a: "view", x: mid.x, y: mid.y, scale: v.zoomFree ? d / v.d0 : 1 });
    return out;
  }

  private startView(n: 1 | 2, t: number): void {
    const ids = [...this.touches.keys()].slice(-n);
    const pts = ids.map((i) => this.touches.get(i)!);
    const mid0 = { x: pts.reduce((a, q) => a + q.x, 0) / n, y: pts.reduce((a, q) => a + q.y, 0) / n };
    const d0 = n === 2 ? Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y) || 1 : 1;
    this.seq!.view = { n, committed: false, t0: t, mid0, d0, zoomFree: false, lx: mid0.x, ly: mid0.y, lt: t, vx: 0, vy: 0, ids };
  }
}
