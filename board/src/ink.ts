// Strokes, items and the background to pixels, in canvas units. A stroke is a
// smoothed polyline (quadratics through the midpoints) stroked with a uniform
// width and round caps: what geom.ts computes against is what is drawn.
// A committed stroke's path and bounds are computed once and cached.
import type { Grid, Item, LineStyle, Stroke } from "../../src/boardFormat";
import { xyBox, type Box } from "./geom";

export const HL_ALPHA = 0.35;

export function xyPath(xy: ArrayLike<number>): Path2D {
  const p = new Path2D();
  const n = xy.length / 2;
  if (n < 1) return p;
  p.moveTo(xy[0]!, xy[1]!);
  if (n === 1) {
    p.lineTo(xy[0]! + 0.01, xy[1]!); // a dot: the round caps draw it
    return p;
  }
  for (let i = 1; i < n - 1; i++) {
    const x = xy[i * 2]!, y = xy[i * 2 + 1]!;
    p.quadraticCurveTo(x, y, (x + xy[i * 2 + 2]!) / 2, (y + xy[i * 2 + 3]!) / 2);
  }
  p.lineTo(xy[n * 2 - 2]!, xy[n * 2 - 1]!);
  return p;
}

type Cached = { path: Path2D; box: Box };
const cache = new WeakMap<Stroke, Cached>();

export function strokeInfo(s: Stroke): Cached {
  let c = cache.get(s);
  if (!c) {
    c = { path: xyPath(s.xy), box: xyBox(s.xy, s.w / 2 + 1) };
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
