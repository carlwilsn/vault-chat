// Scribble to erase (GoodNotes): scribbling back and forth quickly over ink with the pen erases the strokes the
// scribble covers, and the scribble itself. Pure (no DOM): the classifier works on the pen's samples in screen css
// px with their times, so it is the same at every zoom; the coverage test works in canvas units.
//
// A scribble is several sharp reversals (the pen turns back on itself: legs nearly antiparallel), made fast, with
// straight legs, in a small area (the path much longer than its box). Normal writing fails at least one of these:
// "m" and "n" turn back only at their stems and their legs carry the arches (not straight); "w", "z", "∑", "M"
// have two or three corners and their legs are not antiparallel; a zigzag (a resistor, a spring) turns at
// 90–130° and spreads out; cursive loops never reverse sharply. Tests: test/harness/board-scribble.test.ts on
// the recorded-shape traces in scribbleTraces.ts.

export type TP = { x: number; y: number; t: number };

/** The thresholds (exported for the tests' report). */
export const SCRIBBLE = {
  /** Resampling step, css px. */
  step: 1.5,
  /** A reversal candidate: the direction turns more than this (degrees) over the window. */
  candTurn: 120,
  /** At least this many reversals (eight legs): a few quick strokes back and forth are not yet a deliberate scribble. */
  minReversals: 7,
  /** The legs on either side of a reversal, nearly antiparallel: the median turn at least this (degrees). */
  minMedianTurn: 157,
  /** Inner legs nearly straight: chord / length (median). */
  minStraight: 0.8,
  /** Dense: the path's length over its box's diagonal (back and forth over the same place, not along a line). */
  minRatio: 4.5,
  /** Fast: the median inner leg at most this long (ms). */
  maxLegMs: 190,
  /** Legs of at least this length (css px, median): a tremor is not a scribble. */
  minLegPx: 5,
  /** And at most this box (css px, its long side). */
  maxBox: 600,
};

export type ScribbleVerdict = {
  ok: boolean;
  why: string;
  reversals: number;
  medianTurn: number;
  straight: number;
  ratio: number;
  legMs: number;
  legPx: number;
};

function resample(pts: readonly TP[], step: number): TP[] {
  const out: TP[] = [];
  if (!pts.length) return out;
  out.push({ ...pts[0]! });
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d === 0) continue;
    let s = step - carry;
    while (s <= d) {
      const f = s / d;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, t: a.t + (b.t - a.t) * f });
      s += step;
    }
    carry = d - (s - step);
  }
  const last = pts[pts.length - 1]!;
  const l = out[out.length - 1]!;
  if (Math.hypot(last.x - l.x, last.y - l.y) > step * 0.3) out.push({ ...last });
  return out;
}

const median = (v: number[]) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

const no = (why: string, v: Partial<ScribbleVerdict> = {}): ScribbleVerdict => ({ ok: false, why, reversals: 0, medianTurn: 0, straight: 0, ratio: 0, legMs: 0, legPx: 0, ...v });

/**
 * Is this pen path (screen css px, ms) a scribble? The turns are looked for at a few scales (a reversal is a
 * turn over a window of 2.5–16 px: a small window misses a round turn, a large one merges a dense scribble's legs);
 * every test must pass at one of them.
 */
export function classifyScribble(raw: readonly TP[]): ScribbleVerdict {
  if (raw.length < 6) return no("too few samples");
  const r = resample(raw, SCRIBBLE.step);
  let best: ScribbleVerdict | null = null;
  for (const win of [2.5, 4, 7, 11, 16]) {
    const v = classifyAt(r, win);
    if (v.ok) return v;
    if (!best || v.reversals > best.reversals) best = v;
  }
  return best!;
}

function classifyAt(r: TP[], win: number): ScribbleVerdict {
  const C = SCRIBBLE;
  const n = r.length;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of r) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
  const bw = x1 - x0, bh = y1 - y0;
  const P = (n - 1) * C.step;
  const ratio = P / Math.max(1, Math.hypot(bw, bh));
  if (Math.max(bw, bh) > C.maxBox) return no("too large", { ratio });
  // Reversal candidates: the direction over a window before vs after each sample.
  const k = Math.max(2, Math.round(win / C.step));
  const cand = Math.cos((C.candTurn * Math.PI) / 180);
  const revs: number[] = [];
  let best = -1, bestCos = 2, lastCand = -Infinity;
  for (let i = k; i < n - k; i++) {
    const a = r[i - k]!, p = r[i]!, b = r[i + k]!;
    const ux = p.x - a.x, uy = p.y - a.y, vx = b.x - p.x, vy = b.y - p.y;
    const l = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const c = l ? (ux * vx + uy * vy) / l : 1;
    if (c < cand) {
      if (i - lastCand > k && best >= 0) {
        revs.push(best);
        bestCos = 2;
      }
      if (c < bestCos) (bestCos = c), (best = i);
      lastCand = i;
    }
  }
  if (best >= 0 && (revs.length === 0 || revs[revs.length - 1] !== best)) revs.push(best);
  const R = revs.length;
  if (R < C.minReversals) return no(`${R} reversals`, { reversals: R, ratio });
  // The legs between reversals.
  const cuts = [0, ...revs, n - 1];
  // Each leg's straightness is its middle 60%'s (the turns at its ends are round).
  type Leg = { len: number; chord: number; mid: number; ms: number; dx: number; dy: number };
  const legs: Leg[] = [];
  for (let j = 0; j + 1 < cuts.length; j++) {
    const s = cuts[j]!, e = cuts[j + 1]!;
    const len = (e - s) * C.step;
    const A = r[s]!, B = r[e]!;
    // Its direction: the chord of its middle 60% (the turns at its ends bend it).
    const i0 = Math.round(s + (e - s) * 0.2), i1 = Math.round(s + (e - s) * 0.8);
    const m0 = r[i0]!, m1 = r[i1]!;
    legs.push({ len, chord: Math.hypot(B.x - A.x, B.y - A.y), mid: (i1 - i0) * C.step, ms: B.t - A.t, dx: m1.x - m0.x, dy: m1.y - m0.y });
  }
  const inner = legs.slice(1, -1);
  const straight = median(inner.map((l) => (l.mid ? Math.hypot(l.dx, l.dy) / l.mid : 0)));
  const legMs = median(inner.map((l) => l.ms));
  const legPx = median(inner.map((l) => l.len));
  const turns: number[] = [];
  for (let j = 0; j + 1 < legs.length; j++) {
    const a = legs[j]!, b = legs[j + 1]!;
    // An end leg too short to have a direction says nothing about the turn.
    if ((j === 0 && a.len < legPx * 0.35) || (j + 1 === legs.length - 1 && b.len < legPx * 0.35)) continue;
    const l = Math.hypot(a.dx, a.dy) * Math.hypot(b.dx, b.dy);
    if (!l) continue;
    turns.push((Math.acos(Math.max(-1, Math.min(1, (a.dx * b.dx + a.dy * b.dy) / l))) * 180) / Math.PI);
  }
  const medianTurn = median(turns);
  const v = { reversals: R, medianTurn, straight, ratio, legMs, legPx };
  if (!(legPx >= C.minLegPx)) return no("legs too short", v);
  if (!(straight >= C.minStraight)) return no("legs not straight", v);
  if (!(medianTurn >= C.minMedianTurn)) return no("turns not sharp", v);
  if (!(ratio >= C.minRatio)) return no("spread out", v);
  if (!(legMs <= C.maxLegMs)) return no("too slow", v);
  return { ok: true, why: "scribble", ...v };
}

type Pt = { x: number; y: number };

function hull(ps: Pt[]): Pt[] {
  const p = [...ps].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cr = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Pt[] = [], up: Pt[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cr(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (up.length >= 2 && cr(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

function segDist(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = dx * dx + dy * dy;
  let t = l ? ((px - a.x) * dx + (py - a.y) * dy) / l : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(a.x + t * dx - px, a.y + t * dy - py);
}

/** Inside a convex polygon (counter-clockwise or clockwise), or within `m` of it. */
function nearHull(h: Pt[], x: number, y: number, m: number): boolean {
  if (h.length >= 3) {
    let pos = 0, neg = 0;
    for (let i = 0; i < h.length; i++) {
      const a = h[i]!, b = h[(i + 1) % h.length]!;
      const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (c > 0) pos++;
      else if (c < 0) neg++;
    }
    if (!pos || !neg) return true;
  }
  for (let i = 0; i < h.length; i++) if (segDist(x, y, h[i]!, h[(i + 1) % h.length]!) <= m) return true;
  return false;
}

/**
 * The region a scribble covers (canvas units): the convex hulls of runs of its path about three legs long
 * (`leg`: its legs' length), overlapping by half, so the region follows a scribble that moves along a line of
 * writing. `m` widens it (half the pen and a little).
 */
export function scribbleRegion(xy: ArrayLike<number>, m: number, leg: number): { box: { x0: number; y0: number; x1: number; y1: number }; has(x: number, y: number): boolean } {
  const pts: Pt[] = [];
  for (let k = 0; k + 1 < xy.length; k += 2) pts.push({ x: xy[k]!, y: xy[k + 1]! });
  const at: number[] = [0];
  for (let i = 1; i < pts.length; i++) at.push(at[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  const total = at[at.length - 1]!;
  const span = Math.max(leg * 3, 1e-6);
  const hulls: Pt[][] = [];
  for (let s0 = 0, i = 0; ; s0 += span / 2) {
    while (i < pts.length - 1 && at[i]! < s0) i++;
    let j = i;
    while (j < pts.length - 1 && at[j]! < s0 + span) j++;
    hulls.push(hull(pts.slice(Math.max(0, i - 1), j + 1)));
    if (s0 + span >= total) break;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
  const box = { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m };
  return { box, has: (x, y) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && hulls.some((h) => nearHull(h, x, y, m)) };
}

/** The share of a stroke's centreline (sampled along its length) inside the region. */
export function coveredShare(xy: ArrayLike<number>, region: { has(x: number, y: number): boolean }, step: number): number {
  const n = xy.length / 2;
  if (n < 1) return 0;
  if (n === 1) return region.has(xy[0]!, xy[1]!) ? 1 : 0;
  let inside = 0, total = 0;
  for (let i = 0; i + 1 < n; i++) {
    const ax = xy[i * 2]!, ay = xy[i * 2 + 1]!, bx = xy[i * 2 + 2]!, by = xy[i * 2 + 3]!;
    const d = Math.hypot(bx - ax, by - ay);
    const m = Math.max(1, Math.ceil(d / step));
    for (let j = i ? 1 : 0; j <= m; j++) {
      total++;
      if (region.has(ax + ((bx - ax) * j) / m, ay + ((by - ay) * j) / m)) inside++;
    }
  }
  return total ? inside / total : 0;
}

/** A stroke the scribble erases: most of it lies under the scribble. */
export const SCRIBBLE_COVER = 0.6;
