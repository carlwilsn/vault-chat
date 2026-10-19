// Strokes, items and the background to pixels, in canvas units. A stroke is a polyline of the points where it
// bends (geom.ts Simplifier) drawn as the smooth curve through them (centripetal Catmull–Rom, as cubic Béziers:
// no loops or overshoot at a sharp turn), with a uniform width and round caps and joins. The curve stays within a
// fraction of a px of the polyline, so what geom.ts computes against is what is drawn.
// A committed stroke's path and bounds are computed once and cached.
import type { Grid, Item, LineStyle, Stroke } from "../../src/boardFormat";
import { xyBox, type Box } from "./geom";

/** The highlighter's opacity: one value for the whole stroke, drawn as one path (no darkening where it crosses itself). */
export const HL_ALPHA = 0.35;

/** A turn sharper than this (radians, ~65°) that stands out from its neighbours' is a corner. */
const CORNER = 1.13;

export function xyPath(xy: ArrayLike<number>): Path2D {
  const p = new Path2D();
  const n = xy.length / 2;
  if (n < 1) return p;
  const X = (i: number) => xy[i * 2]!, Y = (i: number) => xy[i * 2 + 1]!;
  p.moveTo(X(0), Y(0));
  if (n === 1) {
    p.lineTo(X(0) + 0.01, Y(0)); // a dot: the round caps draw it
    return p;
  }
  if (n === 2) {
    p.lineTo(X(1), Y(1));
    return p;
  }
  // The turn at each point (radians). A corner — a sharp turn between gentle ones, the peak of an "M" or the
  // corner of a "z" — stays sharp: the curve is broken there, as at an end.
  const turn = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const ux = X(i) - X(i - 1), uy = Y(i) - Y(i - 1), vx = X(i + 1) - X(i), vy = Y(i + 1) - Y(i);
    const l = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    turn[i] = l ? Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / l))) : 0;
  }
  const corner = (i: number) => i > 0 && i < n - 1 && turn[i]! > CORNER && turn[i]! > 1.8 * Math.max(turn[i - 1]!, turn[i + 1]!);
  for (let i = 0; i < n - 1; i++) {
    // p0 p1 p2 p3 around the segment p1 → p2; past an end or a corner, the far point reflected.
    const x1 = X(i), y1 = Y(i), x2 = X(i + 1), y2 = Y(i + 1);
    const c0 = i === 0 || corner(i), c3 = i + 2 >= n || corner(i + 1);
    const x0 = c0 ? 2 * x1 - x2 : X(i - 1), y0 = c0 ? 2 * y1 - y2 : Y(i - 1);
    const x3 = c3 ? 2 * x2 - x1 : X(i + 2), y3 = c3 ? 2 * y2 - y1 : Y(i + 2);
    const d1 = Math.sqrt(Math.hypot(x1 - x0, y1 - y0)), d2 = Math.sqrt(Math.hypot(x2 - x1, y2 - y1)), d3 = Math.sqrt(Math.hypot(x3 - x2, y3 - y2));
    if (d2 < 1e-6) continue;
    let c1x = x1, c1y = y1, c2x = x2, c2y = y2;
    if (d1 > 1e-6) {
      const a = 2 * d1 * d1 + 3 * d1 * d2 + d2 * d2, k = 3 * d1 * (d1 + d2);
      c1x = (d1 * d1 * x2 - d2 * d2 * x0 + a * x1) / k;
      c1y = (d1 * d1 * y2 - d2 * d2 * y0 + a * y1) / k;
    }
    if (d3 > 1e-6) {
      const b = 2 * d3 * d3 + 3 * d3 * d2 + d2 * d2, k = 3 * d3 * (d3 + d2);
      c2x = (d3 * d3 * x1 - d2 * d2 * x3 + b * x2) / k;
      c2y = (d3 * d3 * y1 - d2 * d2 * y3 + b * y2) / k;
    }
    p.bezierCurveTo(c1x, c1y, c2x, c2y, x2, y2);
  }
  return p;
}

type Cached = { path: Path2D; box: Box };
const cache = new WeakMap<Stroke, Cached>();

export function strokeInfo(s: Stroke): Cached {
  let c = cache.get(s);
  if (!c) {
    c = { path: xyPath(s.xy), box: xyBox(s.xy, s.w / 2 + 2) };
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
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (style && tool === "pen") ctx.setLineDash(dashFor(style, w));
  if (tool === "hl") {
    ctx.globalAlpha = HL_ALPHA;
    ctx.globalCompositeOperation = "multiply";
  }
}

/** Stroke one stroke (ctx already transformed to canvas units); `minW` keeps ink legible in a small snapshot. */
export function drawStroke(ctx: Ctx, s: Stroke, minW = 0, path = strokeInfo(s).path): void {
  ctx.save();
  inkStyle(ctx, s.tool, s.color, Math.max(s.w, minW), s.style);
  ctx.stroke(path);
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
    xy[k] = Math.round((xy[k]! + dx) * 10) / 10;
    xy[k + 1] = Math.round((xy[k + 1]! + dy) * 10) / 10;
  }
  return { ...s, xy };
}
