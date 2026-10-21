// Ink geometry, pure (no DOM): the erasers, hit tests, the lasso. Strokes are flat [x, y, …] polylines (the pen's
// samples) drawn at a uniform width with round caps (ink.ts: within a fraction of a px of the samples), so the
// geometry here is what is on screen.
//
// The precise eraser is a capsule (the eraser circle swept from the last
// sample to this one). A stroke loses the part of its centreline within
// R = eraser radius + half the stroke width of the capsule: the pieces that
// remain end exactly R from the eraser's path, so their round caps just touch
// the eraser's edge — clean ends, nothing of the ink left inside the circle.

export type XY = { x: number; y: number };
export type Box = { x0: number; y0: number; x1: number; y1: number };

/**
 * Ink written on items: the strokes (not already in `skip`) whose every point
 * lies inside one of the boxes. Moving or scaling an item carries them along;
 * a stroke that only crosses the item's edge stays where it is.
 */
export function carriedInk<S extends { xy: ArrayLike<number> }>(strokes: readonly S[], skip: { has(s: S): boolean }, boxes: ReadonlyArray<{ x: number; y: number; w: number; h: number }>): S[] {
  if (!boxes.length) return [];
  const qs = boxes.map((b) => ({ x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h }));
  return strokes.filter((s) => {
    if (skip.has(s) || !s.xy.length) return false;
    return qs.some((q) => {
      for (let k = 0; k + 1 < s.xy.length; k += 2) if (s.xy[k]! < q.x0 || s.xy[k]! > q.x1 || s.xy[k + 1]! < q.y0 || s.xy[k + 1]! > q.y1) return false;
      return true;
    });
  });
}

/** Distance from p to segment ab. */
export function ptSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Distance between segments ab and cd (0 when they cross). */
export function segSeg(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  const d1 = cross(cx, cy, dx, dy, ax, ay), d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy), d4 = cross(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(ptSeg(ax, ay, cx, cy, dx, dy), ptSeg(bx, by, cx, cy, dx, dy), ptSeg(cx, cy, ax, ay, bx, by), ptSeg(dx, dy, ax, ay, bx, by));
}

export function xyBox(xy: ArrayLike<number>, pad = 0): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k + 1 < xy.length; k += 2) {
    const x = xy[k]!, y = xy[k + 1]!;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

export const boxesMeet = (a: Box, b: Box) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
export const unionBox = (a: Box | null, b: Box): Box => (a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b });

/** The eraser's sweep from a to b (a === b for a single sample). */
export type Capsule = { ax: number; ay: number; bx: number; by: number; r: number };

const capBox = (c: Capsule, pad: number): Box => ({ x0: Math.min(c.ax, c.bx) - c.r - pad, y0: Math.min(c.ay, c.by) - c.r - pad, x1: Math.max(c.ax, c.bx) + c.r + pad, y1: Math.max(c.ay, c.by) + c.r + pad });

/** Does the capsule touch a stroke (centreline xy, width w)? */
export function capsuleHits(xy: ArrayLike<number>, w: number, c: Capsule): boolean {
  const R = c.r + w / 2;
  if (!boxesMeet(xyBox(xy), capBox(c, w / 2))) return false;
  if (xy.length === 2) return ptSeg(xy[0]!, xy[1]!, c.ax, c.ay, c.bx, c.by) < R;
  for (let k = 0; k + 3 < xy.length; k += 2) if (segSeg(xy[k]!, xy[k + 1]!, xy[k + 2]!, xy[k + 3]!, c.ax, c.ay, c.bx, c.by) < R) return true;
  return false;
}

const len = (xy: number[]) => {
  let l = 0;
  for (let k = 0; k + 3 < xy.length; k += 2) l += Math.hypot(xy[k + 2]! - xy[k]!, xy[k + 3]! - xy[k + 1]!);
  return l;
};

/**
 * Cut the capsule out of a stroke's centreline. Returns null when the stroke
 * is untouched, else the pieces left (possibly none), each a flat [x, y, …].
 * Pieces shorter than `minLen` are dropped (a sliver would draw as a dot);
 * a graze (a gap narrower than the stroke) cuts nothing.
 */
export function cutStroke(xy: ArrayLike<number>, w: number, c: Capsule, minLen = 0.5): number[][] | null {
  if (!capsuleHits(xy, w, c)) return null;
  const R = c.r + w / 2;
  const n = xy.length / 2;
  if (n === 1) return [];
  const f = (x: number, y: number) => ptSeg(x, y, c.ax, c.ay, c.bx, c.by);
  const inside: boolean[] = [];
  for (let i = 0; i < n; i++) inside.push(f(xy[i * 2]!, xy[i * 2 + 1]!) < R);
  const pieces: number[][] = [];
  let cur: number[] | null = inside[0] ? null : [xy[0]!, xy[1]!];
  const at = (i: number, t: number): [number, number] => {
    const ax = xy[i * 2]!, ay = xy[i * 2 + 1]!, bx = xy[i * 2 + 2]!, by = xy[i * 2 + 3]!;
    return [ax + (bx - ax) * t, ay + (by - ay) * t];
  };
  const g = (i: number, t: number) => {
    const [x, y] = at(i, t);
    return f(x, y);
  };
  // g(i, ·) is convex (distance from a moving point to a convex set), so each
  // segment is inside on one interval; its ends are found by bisection.
  const edge = (i: number, lo: number, hi: number, loInside: boolean) => {
    for (let k = 0; k < 40; k++) {
      const m = (lo + hi) / 2;
      if (g(i, m) < R === loInside) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  };
  for (let i = 0; i < n - 1; i++) {
    const a = inside[i]!, b = inside[i + 1]!;
    const B = [xy[i * 2 + 2]!, xy[i * 2 + 3]!];
    if (!a && !b) {
      // Both ends outside: the middle may still dip in.
      let lo = 0, hi = 1;
      for (let k = 0; k < 40; k++) {
        const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
        if (g(i, m1) < g(i, m2)) hi = m2;
        else lo = m1;
      }
      const tm = (lo + hi) / 2;
      if (g(i, tm) < R) {
        const t0 = edge(i, 0, tm, false), t1 = edge(i, tm, 1, true);
        cur!.push(...at(i, t0));
        pieces.push(cur!);
        cur = [...at(i, t1), B[0]!, B[1]!];
      } else cur!.push(B[0]!, B[1]!);
    } else if (!a && b) {
      cur!.push(...at(i, edge(i, 0, 1, false)));
      pieces.push(cur!);
      cur = null;
    } else if (a && !b) {
      cur = [...at(i, edge(i, 0, 1, true)), B[0]!, B[1]!];
    }
    // a && b: the whole segment is inside (convexity), nothing kept.
  }
  if (cur) pieces.push(cur);
  // A graze: a gap narrower than the stroke would leave the two caps
  // overlapping (a dark spot under a highlighter's multiply), and no real
  // eraser cuts a line it only touched. Rejoin across it.
  const joined: number[][] = [];
  for (const p of pieces) {
    const q = joined[joined.length - 1];
    if (q && Math.hypot(p[0]! - q[q.length - 2]!, p[1]! - q[q.length - 1]!) < w) q.push(...p);
    else joined.push(p);
  }
  if (joined.length === 1 && !inside[0] && !inside[n - 1]) return null;
  const r1 = (v: number) => Math.round(v * 100) / 100;
  return joined.map((p) => p.map(r1)).filter((p) => p.length >= 4 && len(p) >= minLen);
}

export function pointInPoly(x: number, y: number, poly: ReadonlyArray<XY>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A stroke is lassoed when most of its points are inside the loop. */
export function lassoedXY(xy: ArrayLike<number>, poly: ReadonlyArray<XY>): boolean {
  let n = 0, inside = 0;
  for (let k = 0; k + 1 < xy.length; k += 2) {
    n++;
    if (pointInPoly(xy[k]!, xy[k + 1]!, poly)) inside++;
  }
  return n > 0 && inside / n >= 0.6;
}

/** A box is lassoed when most of a 3 × 3 grid of its points is inside the loop. */
export function lassoedBox(b: { x: number; y: number; w: number; h: number }, poly: ReadonlyArray<XY>): boolean {
  let inside = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (pointInPoly(b.x + (b.w * (i + 0.5)) / 3, b.y + (b.h * (j + 0.5)) / 3, poly)) inside++;
  return inside >= 6;
}
