// Strokes to pixels: perfect-freehand outlines filled as Path2D, in page units.
// A committed stroke's path and bounds are computed once and cached.
import { getStroke } from "perfect-freehand";
import { unpackPoints, type Stroke, type Tool } from "../../src/boardFormat";

export const HL_ALPHA = 0.35;

/** perfect-freehand's options for a tool. Width ≈ `w` at mid pressure. */
function options(tool: Tool, w: number, last: boolean) {
  if (tool === "hl") {
    return { size: w, thinning: 0, smoothing: 0.5, streamline: 0.45, simulatePressure: false, last, start: { cap: true }, end: { cap: true } };
  }
  // radius = size/2 · (0.5 − thinning·(0.5 − p)): at p = 0.5 the width is size/2.
  return { size: w * 2, thinning: 0.55, smoothing: 0.55, streamline: 0.3, simulatePressure: false, last, easing: (t: number) => t };
}

export function outlinePath(points: ArrayLike<number[]> & Iterable<number[]>, tool: Tool, w: number, last: boolean): Path2D {
  const out = getStroke(Array.from(points), options(tool, w, last));
  const p = new Path2D();
  const n = out.length;
  if (n < 2) return p;
  p.moveTo(out[0]![0]!, out[0]![1]!);
  for (let i = 0; i < n; i++) {
    const a = out[i]!;
    const b = out[(i + 1) % n]!;
    p.quadraticCurveTo(a[0]!, a[1]!, (a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2);
  }
  p.closePath();
  return p;
}

export type BBox = { x0: number; y0: number; x1: number; y1: number };

type Cached = { path: Path2D; box: BBox };
const cache = new WeakMap<Stroke, Cached>();

export function strokeInfo(s: Stroke): Cached {
  let c = cache.get(s);
  if (!c) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < s.pts.length; i += 3) {
      const x = s.pts[i]!, y = s.pts[i + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const pad = s.w * (s.tool === "hl" ? 0.6 : 1.2);
    c = { path: outlinePath(unpackPoints(s.pts), s.tool, s.w, true), box: { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad } };
    cache.set(s, c);
  }
  return c;
}

/** Fill one stroke (ctx already transformed to page units). */
export function drawStroke(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, s: Stroke, path = strokeInfo(s).path): void {
  ctx.fillStyle = s.color;
  if (s.tool === "hl") {
    ctx.save();
    ctx.globalAlpha = HL_ALPHA;
    ctx.globalCompositeOperation = "multiply";
    ctx.fill(path);
    ctx.restore();
  } else ctx.fill(path);
}

/** Distance from (px, py) to segment ab. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

/** Does a circle of radius r at (x, y) touch the stroke? */
export function hitStroke(s: Stroke, x: number, y: number, r: number): boolean {
  const b = strokeInfo(s).box;
  if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) return false;
  const reach = r + s.w * (s.tool === "hl" ? 0.5 : 0.6);
  const p = s.pts;
  if (p.length === 3) return Math.hypot(p[0]! - x, p[1]! - y) <= reach;
  for (let i = 0; i + 5 < p.length; i += 3) if (segDist(x, y, p[i]!, p[i + 1]!, p[i + 3]!, p[i + 4]!) <= reach) return true;
  return false;
}

export function pointInPoly(x: number, y: number, poly: ReadonlyArray<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A stroke is lassoed when most of its points are inside the loop. */
export function lassoed(s: Stroke, poly: ReadonlyArray<{ x: number; y: number }>): boolean {
  let n = 0, inside = 0;
  for (let i = 0; i < s.pts.length; i += 3) {
    n++;
    if (pointInPoly(s.pts[i]!, s.pts[i + 1]!, poly)) inside++;
  }
  return n > 0 && inside / n >= 0.6;
}

/** Move a stroke's points (a new object, so the cache recomputes). */
export function translated(s: Stroke, dx: number, dy: number): Stroke {
  const pts = s.pts.slice();
  for (let i = 0; i < pts.length; i += 3) {
    pts[i] = Math.round((pts[i]! + dx) * 10) / 10;
    pts[i + 1] = Math.round((pts[i + 1]! + dy) * 10) / 10;
  }
  return { ...s, pts };
}
