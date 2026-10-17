// Scripted pen and touch traces for the palm-rejection arbiter (palm.ts): a
// deterministic simulator for the unit tests (test/harness/board-palm.test.ts)
// and a replayer that dispatches the same traces as real PointerEvents into the
// running board (in the dev server: `await import("/board/src/palmTraces.ts")`).
// Not imported by the app, so not in its bundle.
//
// Screen: 1180 × 820 css px (an iPad Air in landscape). A left-handed writer:
// the palm rests to the left of and below the pen tip.
import { Arbiter, type Action, type Hand, type PEvent } from "./palm";

type Pt = [number, number];

export class Trace {
  evs: PEvent[] = [];
  constructor(
    public name: string,
    public expect: "nothing" | "ink-only" | "pinch" | "pan" | "undo" | "no-undo",
  ) {}

  /** A pen stroke: down at t0, a sample every dt ms along pts, up. */
  pen(pts: Pt[], t0: number, dt = 8, id = 1): this {
    pts.forEach(([x, y], i) => this.evs.push({ type: i === 0 ? "down" : "move", id, kind: "pen", x, y, t: t0 + i * dt, buttons: 1 }));
    const [x, y] = pts[pts.length - 1]!;
    this.evs.push({ type: "up", id, kind: "pen", x, y, t: t0 + pts.length * dt, buttons: 0 });
    return this;
  }

  /** The pen hovering (no contact) along pts, then leaving range. */
  hover(pts: Pt[], t0: number, dt = 16, id = 1): this {
    pts.forEach(([x, y], i) => this.evs.push({ type: "move", id, kind: "pen", x, y, t: t0 + i * dt, buttons: 0 }));
    const [x, y] = pts[pts.length - 1]!;
    this.evs.push({ type: "leave", id, kind: "pen", x, y, t: t0 + pts.length * dt });
    return this;
  }

  /** A touch: down at t0, along pts every dt ms, up; size (css px) per sample or fixed; w/h for an elongated contact. */
  touch(id: number, pts: Pt[], t0: number, dt: number, size: number | ((i: number) => number), aspect = 1): this {
    const sz = (i: number) => (typeof size === "number" ? size : size(i));
    pts.forEach(([x, y], i) => this.evs.push({ type: i === 0 ? "down" : "move", id, kind: "touch", x, y, w: sz(i), h: sz(i) / aspect, t: t0 + i * dt }));
    const [x, y] = pts[pts.length - 1]!;
    const last = pts.length - 1;
    this.evs.push({ type: "up", id, kind: "touch", x, y, w: sz(last), h: sz(last) / aspect, t: t0 + pts.length * dt });
    return this;
  }

  sorted(): PEvent[] {
    return this.evs.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map((x) => x.e);
  }
}

/** n points from a to b. */
export function line(a: Pt, b: Pt, n: number): Pt[] {
  return Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / Math.max(1, n - 1), a[1] + ((b[1] - a[1]) * i) / Math.max(1, n - 1)] as Pt);
}
/** A resting contact that drifts a few px (a palm settling). */
export function rest(at: Pt, n: number, drift = 3): Pt[] {
  return Array.from({ length: n }, (_, i) => [at[0] + Math.sin(i / 3) * drift, at[1] + Math.cos(i / 4) * drift] as Pt);
}
/** Handwriting-ish: a wavy line to the right. */
export function writing(at: Pt, n: number, step = 3): Pt[] {
  return Array.from({ length: n }, (_, i) => [at[0] + i * step, at[1] + Math.sin(i / 4) * 12] as Pt);
}

export type SimResult = {
  actions: Action[];
  /** Tool actions by pointer kind. */
  inkBy: { pen: number; touch: number; mouse: number };
  viewStarts: number;
  undos: number;
  /** The camera after the trace (pan in px, zoom factor), applying view actions like the board does. */
  cam: { x: number; y: number; z: number };
};

export function simulate(trace: Trace, opts: { hand?: Hand; pan1?: boolean; penSeen?: boolean } = {}): SimResult {
  const arb = new Arbiter({ hand: opts.hand ?? "left", pan1: opts.pan1 ?? false, penSeen: opts.penSeen ?? true });
  const actions: Action[] = [];
  const kinds = new Map<number, PEvent["kind"]>();
  const inkBy = { pen: 0, touch: 0, mouse: 0 };
  let cam = { x: 0, y: 0, z: 1 };
  let start: { cam: typeof cam; x: number; y: number } | null = null;
  for (const e of trace.sorted()) {
    for (const a of arb.handle(e)) {
      actions.push(a);
      if (a.a === "tool-start") kinds.set(a.id, a.ev.kind);
      if (a.a === "tool-start" || a.a === "tool-move") inkBy[a.ev.kind]++;
      if (a.a === "view-start") start = { cam: { ...cam }, x: a.x, y: a.y };
      if (a.a === "view" && start) cam = { x: start.cam.x + (a.x - start.x), y: start.cam.y + (a.y - start.y), z: start.cam.z * a.scale };
      if (a.a === "view-abort" && start) cam = { ...start.cam };
      if (a.a === "view-end" || a.a === "view-abort") start = null;
    }
  }
  return { actions, inkBy, viewStarts: actions.filter((a) => a.a === "view-start").length, undos: actions.filter((a) => a.a === "undo").length, cam };
}

// ------------------------------------------------------------ the traces

const PEN_AT: Pt = [600, 380];

export const TRACES: Record<string, () => Trace> = {
  // The palm lands (heel large, then the side of the little finger) before the pen touches down.
  palmBeforePen: () =>
    new Trace("left palm lands before the pen", "ink-only")
      .touch(11, rest([470, 560], 80, 6), 0, 16, (i) => Math.min(110, 40 + i * 6))
      .touch(12, rest([560, 500], 70, 5), 40, 16, 38)
      .pen(writing(PEN_AT, 90), 260),
  // The hard case: both palm contacts report finger-sized, land together and settle (move) before the pen.
  palmBeforePenSmall: () =>
    new Trace("left palm lands before the pen, finger-sized contacts", "ink-only")
      .touch(11, [...line([470, 560], [452, 572], 30), ...rest([452, 572], 60, 2)], 0, 10, 44)
      .touch(12, [...line([560, 500], [546, 508], 28), ...rest([546, 508], 60, 2)], 30, 10, 40)
      .pen(writing(PEN_AT, 90), 300),
  palmMidStroke: () =>
    new Trace("palm lands mid-stroke", "ink-only")
      .pen(writing(PEN_AT, 150), 0)
      .touch(11, rest([480, 540], 90, 4), 300, 16, 90)
      .touch(12, rest([540, 470], 80, 4), 330, 16, 42),
  palmSliding: () =>
    new Trace("palm slides while writing, and on after the pen lifts", "ink-only")
      .pen(writing(PEN_AT, 200, 2.5), 0)
      .touch(11, line([470, 560], [1000, 560], 140), 50, 14, 85)
      .touch(12, line([540, 480], [1060, 480], 130), 70, 14, 40),
  palmLiftsBeforePen: () =>
    new Trace("palm lifts (shrinking, sliding) before the pen", "ink-only")
      .pen(writing(PEN_AT, 150), 0)
      .touch(11, [...rest([480, 540], 30, 3), ...line([480, 540], [430, 600], 10)], 100, 16, (i) => (i < 30 ? 80 : 80 - (i - 29) * 7))
      .touch(12, line([540, 470], [500, 520], 20), 120, 16, (i) => 40 - i),
  palmLiftsAfterPen: () =>
    new Trace("palm lifts with a slide after the pen lifts", "ink-only")
      .pen(writing(PEN_AT, 100), 0)
      .touch(11, [...rest([480, 540], 70, 3), ...line([480, 540], [380, 640], 15)], 60, 16, 50)
      .touch(12, [...rest([540, 470], 70, 3), ...line([540, 470], [450, 560], 15)], 80, 16, 36),
  sideOfHand: () =>
    new Trace("side of the hand: a long contact sliding", "nothing")
      .touch(11, line([300, 500], [380, 640], 40), 0, 16, 120, 3.5),
  knuckle: () =>
    new Trace("a knuckle rests, then drags a little", "nothing")
      .touch(11, [...rest([700, 300], 30, 2), ...line([700, 300], [760, 360], 20)], 0, 16, 30),
  twoKnuckles: () =>
    new Trace("two knuckles land 300 ms apart and drag", "nothing")
      .touch(11, [...rest([700, 300], 40, 2), ...line([700, 300], [700, 420], 20)], 0, 16, 30)
      .touch(12, line([780, 330], [780, 450], 40), 300, 16, 30),
  palmThenFingerTap: () =>
    new Trace("palm resting while the other hand taps two fingers", "nothing")
      .touch(11, rest([470, 560], 60, 3), 0, 16, 95)
      .touch(12, [[900, 300], [900, 300], [901, 300]], 400, 40, 30)
      .touch(13, [[980, 310], [980, 310], [980, 311]], 410, 40, 30),
  pinch: () =>
    new Trace("a deliberate two-finger pinch (right hand, on the right)", "pinch")
      .touch(21, line([800, 400], [700, 400], 25), 0, 12, 32)
      .touch(22, line([900, 420], [1020, 420], 25), 30, 12, 30),
  twoFingerPan: () =>
    new Trace("a two-finger pan", "pan")
      .touch(21, line([700, 300], [700, 560], 30), 0, 12, 32)
      .touch(22, line([790, 310], [790, 570], 30), 25, 12, 30),
  undoTap: () =>
    new Trace("a two-finger undo tap", "undo")
      .touch(21, [[700, 300], [701, 301], [701, 301]], 0, 40, 30)
      .touch(22, [[790, 310], [790, 311], [790, 311]], 20, 40, 30),
  undoTapAfterPen: () =>
    new Trace("a two-finger tap 700 ms after the pen lifted (no undo)", "no-undo")
      .pen(writing(PEN_AT, 30), 0)
      .touch(21, [[900, 300], [901, 301], [901, 301]], 950, 40, 30)
      .touch(22, [[990, 310], [990, 311], [990, 311]], 970, 40, 30),
  pinchAfterWriting: () =>
    new Trace("a right-hand pinch on the right, 800 ms after writing", "pinch")
      .pen(writing(PEN_AT, 40), 0)
      .touch(21, line([850, 400], [800, 400], 20), 1120, 12, 32)
      .touch(22, line([950, 420], [1050, 420], 20), 1140, 12, 30),
  handSidePinch: () =>
    new Trace("a two-contact 'pinch' on the hand side 900 ms after writing (a palm)", "nothing")
      .pen(writing(PEN_AT, 40), 0)
      .touch(21, line([520, 520], [470, 540], 20), 1220, 12, 40)
      .touch(22, line([580, 470], [600, 440], 20), 1240, 12, 40),
  hoverThenPalm: () =>
    new Trace("the pen hovers, the palm lands and slides, the pen writes", "ink-only")
      .hover(line([640, 330], [600, 380], 20), 0)
      .touch(11, line([480, 540], [470, 560], 30), 100, 16, 44)
      .touch(12, line([540, 470], [528, 480], 30), 110, 16, 40)
      .pen(writing(PEN_AT, 60), 340),
};

/** The traces the tests and the browser proof run, with their sizes as the README lists them. */
export const PALM_CASES = ["palmBeforePen", "palmBeforePenSmall", "palmMidStroke", "palmSliding", "palmLiftsBeforePen", "palmLiftsAfterPen", "sideOfHand", "knuckle", "twoKnuckles", "palmThenFingerTap", "handSidePinch", "hoverThenPalm"];

// ------------------------------------------------------------ replay in the browser

/**
 * Dispatch a trace as real PointerEvents into `target` (the board's root
 * element), in real time, offset to `origin` (css px of the trace's 0,0).
 */
export async function replay(trace: Trace, target: HTMLElement, origin = { x: 0, y: 0 }, speed = 1): Promise<void> {
  const evs = trace.sorted();
  const t0 = performance.now(), e0 = evs[0]?.t ?? 0;
  const stage = target.querySelector(".stage") as HTMLElement;
  for (const e of evs) {
    const due = t0 + (e.t - e0) / speed;
    const wait = due - performance.now();
    if (wait > 1) await new Promise((r) => setTimeout(r, wait));
    const type = e.type === "down" ? "pointerdown" : e.type === "move" ? "pointermove" : e.type === "up" ? "pointerup" : e.type === "cancel" ? "pointercancel" : "pointerleave";
    const ev = new PointerEvent(type, {
      bubbles: e.type !== "leave",
      cancelable: true,
      pointerId: e.kind === "pen" ? 1000 + e.id : e.id,
      pointerType: e.kind,
      isPrimary: true,
      clientX: origin.x + e.x,
      clientY: origin.y + e.y,
      width: e.w ?? 1,
      height: e.h ?? 1,
      pressure: e.kind === "pen" ? (e.buttons ? 0.5 : 0) : e.type === "up" ? 0 : 0.5,
      button: e.type === "down" || e.type === "up" ? 0 : -1,
      buttons: e.kind === "pen" ? (e.buttons ?? 0) : e.type === "up" ? 0 : 1,
    });
    (e.type === "leave" ? target : stage).dispatchEvent(ev);
  }
}
