// Strokes, items and the background to pixels, in canvas units. A stroke is stored as the pen's own samples (raw,
// in canvas units) and drawn by perfect-freehand (the established freehand-ink algorithm: tldraw, Excalidraw): its
// input stabilisation (`streamline`) irons out the hand's tremor and the samples' whole-px steps, and its outline
// (`smoothing`) is a smooth polygon of uniform width (`thinning: 0`, no pressure) with round caps, filled with the
// nonzero rule (a stroke that crosses itself is filled once: no holes, no darker overlap). The stroke being written
// and the finished stroke are the same function of the same samples, so nothing moves when the pen lifts.
// Dashed and dotted lines are stroked along perfect-freehand's stabilised centreline with the dash pattern.
// A committed stroke's outline and bounds are computed once and cached.
import { getStrokeOutlinePoints, getStrokePoints } from "perfect-freehand";
import type { Grid, Item, LineStyle, Stroke } from "../../src/boardFormat";
import { xyBox, type Box } from "./geom";

/** The highlighter's opacity: one value for the whole stroke, drawn as one path (no darkening where it overlaps itself). */
export const HL_ALPHA = 0.35;

/**
 * perfect-freehand's settings (board/README.md "Ink"; measured on board/src/inkTraces.ts by
 * test/harness/board-ink.test.ts). It runs in a space where the stroke is `SIZE` wide, so every length it uses (its
 * minimum stroke length, the outline's point spacing, the end's last few units) is relative to the stroke's own width:
 * a stroke looks the same at any zoom it was written at and after it is scaled. `minStep` (css px): a sample closer
 * than this to the last one kept is left out as it is written (view.ts).
 */
export const INK = { size: 16, streamline: 0.5, smoothing: 0.6, spacing: 0.6, maxSpacing: 1.5, minStep: 0.5 };

/**
 * A flat [x, y, …] array as perfect-freehand's points, in its space (`k`: its units per canvas unit), spaced evenly
 * along the path (`INK.spacing` of the width apart, at most `INK.maxSpacing` canvas units: a wide highlighter keeps its
 * shape; the first and last sample kept). perfect-freehand's streamline
 * moves each point part of the way from the last one, so on the Pencil's raw samples (one every 1/240 s: a fraction
 * of a px apart when slow, 10 px when fast) it would smooth slow writing too little and cut fast corners; on even
 * spacing it is the same smoothing over the same distance at every speed.
 */
function pfIn(xy: ArrayLike<number>, k: number, w: number): number[][] {
  const n = xy.length >> 1;
  const out: number[][] = [];
  if (!n) return out;
  const step = Math.min(INK.spacing * w, INK.maxSpacing);
  out.push([xy[0]! * k, xy[1]! * k]);
  let carry = 0;
  for (let i = 1; i < n; i++) {
    const ax = xy[i * 2 - 2]!, ay = xy[i * 2 - 1]!, bx = xy[i * 2]!, by = xy[i * 2 + 1]!;
    const d = Math.hypot(bx - ax, by - ay);
    if (!d) continue;
    let s = step - carry;
    while (s <= d) {
      out.push([(ax + ((bx - ax) * s) / d) * k, (ay + ((by - ay) * s) / d) * k]);
      s += step;
    }
    carry = d - (s - step);
  }
  const lx = xy[n * 2 - 2]! * k, ly = xy[n * 2 - 1]! * k, l = out[out.length - 1]!;
  if (n > 1 && (l[0] !== lx || l[1] !== ly)) out.push([lx, ly]);
  return out;
}

/** The stroke's stabilised centreline (flat, canvas units): what a dashed line is stroked along. */
export function inkCentre(xy: ArrayLike<number>, w: number): number[] {
  const k = INK.size / w;
  const out: number[] = [];
  for (const p of getStrokePoints(pfIn(xy, k, w), { size: INK.size, streamline: INK.streamline, last: true })) out.push(p.point[0]! / k, p.point[1]! / k);
  return out;
}

/** The stroke's outline polygon (flat, canvas units), to fill with the nonzero rule. */
export function inkOutline(xy: ArrayLike<number>, w: number): number[] {
  const k = INK.size / w;
  const pts = getStrokePoints(pfIn(xy, k, w), { size: INK.size, streamline: INK.streamline, last: true });
  const poly = getStrokeOutlinePoints(pts, { size: INK.size, thinning: 0, smoothing: INK.smoothing, simulatePressure: false, last: true, start: { cap: true }, end: { cap: true } });
  const out: number[] = [];
  for (const p of poly) out.push(p[0]! / k, p[1]! / k);
  return out;
}

/**
 * A closed polygon as a smooth path: quadratic curves through the midpoints of its sides, each controlled by the
 * vertex between them (perfect-freehand's own rendering, its README's getSvgPathFromStroke), so the outline has no
 * facets however far apart its points are.
 */
function polyPath(f: ArrayLike<number>): Path2D {
  const p = new Path2D();
  const n = f.length >> 1;
  if (n < 3) return p;
  const X = (i: number) => f[(i % n) * 2]!, Y = (i: number) => f[(i % n) * 2 + 1]!;
  p.moveTo((X(0) + X(1)) / 2, (Y(0) + Y(1)) / 2);
  for (let i = 1; i <= n; i++) p.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
  p.closePath();
  return p;
}
/** An open polyline as a smooth path (the same midpoint curves, from its first point to its last). */
function linePath(f: ArrayLike<number>): Path2D {
  const p = new Path2D();
  const n = f.length >> 1;
  if (n < 1) return p;
  p.moveTo(f[0]!, f[1]!);
  if (n === 1) p.lineTo(f[0]! + 0.01, f[1]!);
  else if (n === 2) p.lineTo(f[2]!, f[3]!);
  else {
    for (let i = 1; i < n - 1; i++) p.quadraticCurveTo(f[i * 2]!, f[i * 2 + 1]!, (f[i * 2]! + f[i * 2 + 2]!) / 2, (f[i * 2 + 1]! + f[i * 2 + 3]!) / 2);
    p.lineTo(f[(n - 1) * 2]!, f[(n - 1) * 2 + 1]!);
  }
  return p;
}

/** How a stroke is painted: a filled outline, or (dashed, dotted) a stroked centreline. */
export type InkPath = { fill: boolean; path: Path2D };

/** The path that paints these samples at width `w` (the live stroke and the finished one use this same function). */
export function inkPath(xy: ArrayLike<number>, w: number, style?: LineStyle): InkPath {
  if (style) return { fill: false, path: linePath(inkCentre(xy, w)) };
  return { fill: true, path: polyPath(inkOutline(xy, w)) };
}

type Cached = { ink: InkPath; box: Box; centre?: Path2D };
const cache = new WeakMap<Stroke, Cached>();

export function strokeInfo(s: Stroke): Cached {
  let c = cache.get(s);
  if (!c) {
    c = { ink: inkPath(s.xy, s.w, s.tool === "pen" ? s.style : undefined), box: xyBox(s.xy, s.w / 2 + 2) };
    cache.set(s, c);
  }
  return c;
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * A dashed or dotted pen line's pattern, in canvas units (so it stays even at any zoom), scaled to the width.
 * The caps are round, so a dash shows `on + w` long and a gap `off - w`; a dot is a zero-length dash (its cap).
 */
export function dashFor(style: LineStyle | undefined, w: number): number[] {
  if (style === "dash") return [Math.max(3 * w, 7), Math.max(2.4 * w, 5) + w];
  if (style === "dot") return [0.001, Math.max(2.2 * w, 4)];
  return [];
}

export function inkStyle(ctx: Ctx, tool: Stroke["tool"], color: string, w: number, style?: LineStyle): void {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (style && tool === "pen") ctx.setLineDash(dashFor(style, w));
  if (tool === "hl") {
    ctx.globalAlpha = HL_ALPHA;
    ctx.globalCompositeOperation = "multiply";
  }
}

/** Paint an ink path with the context's style set (inkStyle). */
export function paintInk(ctx: Ctx, ink: InkPath): void {
  if (ink.fill) ctx.fill(ink.path, "nonzero");
  else ctx.stroke(ink.path);
}

/**
 * Paint one stroke (ctx already transformed to canvas units); `minW` keeps ink legible in a small snapshot (the
 * overview, a thumbnail): there the stroke is its stabilised centreline stroked that wide (cached: a snapshot of the
 * whole board stays cheap).
 */
export function drawStroke(ctx: Ctx, s: Stroke, minW = 0, ink?: InkPath): void {
  ctx.save();
  const info = strokeInfo(s);
  if (minW > s.w) {
    inkStyle(ctx, s.tool, s.color, minW, s.tool === "pen" ? s.style : undefined);
    ctx.stroke((info.centre ??= linePath(inkCentre(s.xy, s.w))));
  } else {
    inkStyle(ctx, s.tool, s.color, s.w, s.style);
    paintInk(ctx, ink ?? info.ink);
  }
  ctx.restore();
}

/** Strokes in the order they are painted: the highlighter's under the pen's (each group in the order written). */
export function paintOrder<S extends { tool: Stroke["tool"] }>(strokes: Iterable<S>): S[] {
  const hl: S[] = [], pen: S[] = [];
  for (const s of strokes) (s.tool === "hl" ? hl : pen).push(s);
  return hl.concat(pen);
}

export const itemBox = (it: Item): Box => ({ x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h });

/** An item: its image when loaded, else a quiet placeholder. */
export function drawItem(ctx: Ctx, it: Item, img: CanvasImageSource | null): void {
  if (img) {
    ctx.drawImage(img, it.x, it.y, it.w, it.h);
    return;
  }
  ctx.save();
  ctx.fillStyle = "#f3f3f5";
  ctx.fillRect(it.x, it.y, it.w, it.h);
  ctx.restore();
}

/**
 * The background, GoodNotes' grid paper: 40-unit squares (or dots) in a quiet blue-grey, clearly there but behind
 * the ink. Density follows the zoom: a level's lines fade out as they close in below GRID_MIN css px and every
 * other line carries on, so zooming out never turns it into a solid fill or a moiré.
 */
export const GRID_INK = "#c3cddb";
const GRID_DOT = "#a9b4c4";
const GRID_MIN = 14; // css px: the closest the lines come

/** The steps in canvas units at zoom `z` (css px per unit): the fine one with its opacity, and the one above it. */
export function gridSteps(z: number): { fine: number; coarse: number; fade: number } {
  let fine = 40;
  while (fine * z < GRID_MIN) fine *= 2;
  const fade = Math.min(1, (fine * z - GRID_MIN) / GRID_MIN);
  return { fine, coarse: fine * 2, fade };
}

/**
 * The grid straight onto a screen canvas (device px), every frame: `cam` is the view's top-left in canvas units and
 * its zoom; w × h css px; d the device pixel ratio. Lines land on whole device pixels, one css px wide.
 */
export function drawGridScreen(ctx: CanvasRenderingContext2D, grid: Grid, cam: { x: number; y: number; z: number }, w: number, h: number, d: number): void {
  if (grid === "plain") return;
  const { z } = cam;
  const { fine, coarse, fade } = gridSteps(z);
  const x0 = cam.x, y0 = cam.y, x1 = cam.x + w / z, y1 = cam.y + h / z;
  const lw = Math.max(1, Math.round(d));
  const half = lw % 2 ? 0.5 : 0;
  const sx = (x: number) => Math.round((x - x0) * z * d) + half, sy = (y: number) => Math.round((y - y0) * z * d) + half;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const [step, alpha, skip] of [[fine, fade, coarse], [coarse, 1, 0]] as const) {
    if (alpha <= 0.02) continue;
    const isMajor = (v: number) => skip > 0 && Math.abs(v / skip - Math.round(v / skip)) < 1e-6;
    if (grid === "dots") {
      ctx.fillStyle = GRID_DOT;
      ctx.globalAlpha = alpha;
      const r = Math.max(1.5 * d, Math.min(2.2 * d, 0.06 * step * z * d));
      for (let x = Math.floor(x0 / step) * step; x <= x1; x += step)
        for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) if (!(isMajor(x) && isMajor(y))) ctx.fillRect(Math.round((x - x0) * z * d - r / 2), Math.round((y - y0) * z * d - r / 2), r, r);
      continue;
    }
    ctx.strokeStyle = GRID_INK;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) if (!isMajor(x)) (ctx.moveTo(sx(x), 0), ctx.lineTo(sx(x), h * d));
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) if (!isMajor(y)) (ctx.moveTo(0, sy(y)), ctx.lineTo(w * d, sy(y)));
    ctx.stroke();
  }
  ctx.restore();
}

/** The background over a rect of canvas units, for a snapshot (ctx in canvas units at scale `z` px per unit). */
export function drawGrid(ctx: Ctx, grid: Grid, b: Box, z: number): void {
  if (grid === "plain") return;
  const step = gridSteps(z).coarse / (gridSteps(z).fade > 0.5 ? 2 : 1);
  const x0 = Math.floor(b.x0 / step) * step, y0 = Math.floor(b.y0 / step) * step;
  ctx.save();
  if (grid === "dots") {
    ctx.fillStyle = GRID_DOT;
    const r = Math.max(1.5 / z, 0.06 * step);
    for (let x = x0; x <= b.x1; x += step) for (let y = y0; y <= b.y1; y += step) ctx.fillRect(x - r / 2, y - r / 2, r, r);
  } else {
    ctx.strokeStyle = GRID_INK;
    ctx.lineWidth = 1 / z;
    ctx.beginPath();
    for (let x = x0; x <= b.x1; x += step) ctx.moveTo(x, b.y0), ctx.lineTo(x, b.y1);
    for (let y = y0; y <= b.y1; y += step) ctx.moveTo(b.x0, y), ctx.lineTo(b.x1, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Move a stroke (a new object, so the cache recomputes). */
export function translated(s: Stroke, dx: number, dy: number): Stroke {
  const xy = s.xy.slice();
  for (let k = 0; k < xy.length; k += 2) {
    xy[k] = Math.round((xy[k]! + dx) * 100) / 100;
    xy[k + 1] = Math.round((xy[k + 1]! + dy) * 100) / 100;
  }
  return { ...s, xy };
}
