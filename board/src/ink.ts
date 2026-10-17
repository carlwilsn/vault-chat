// Strokes, items and the background to pixels, in canvas units. A stroke is a
// smoothed polyline (quadratics through the midpoints) stroked with a uniform
// width and round caps: what geom.ts computes against is what is drawn.
// A committed stroke's path and bounds are computed once and cached.
import type { Grid, Item, Stroke } from "../../src/boardFormat";
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

export function inkStyle(ctx: Ctx, tool: Stroke["tool"], color: string, w: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (tool === "hl") {
    ctx.globalAlpha = HL_ALPHA;
    ctx.globalCompositeOperation = "multiply";
  }
}

/** Stroke one stroke (ctx already transformed to canvas units). */
export function drawStroke(ctx: Ctx, s: Stroke, path = strokeInfo(s).path): void {
  ctx.save();
  inkStyle(ctx, s.tool, s.color, s.w);
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

/** The background pattern over a rect of canvas units (spacing 40 units). */
export function drawGrid(ctx: Ctx, grid: Grid, b: Box, z: number): void {
  if (grid === "plain") return;
  const step = 40 * Math.pow(2, Math.max(0, Math.ceil(Math.log2(6 / (40 * z))))); // never denser than 6 px
  const x0 = Math.floor(b.x0 / step) * step, y0 = Math.floor(b.y0 / step) * step;
  ctx.save();
  if (grid === "dots") {
    ctx.fillStyle = "#c9c9d1";
    const r = Math.max(0.6 / z, 1.1);
    for (let x = x0; x <= b.x1; x += step) for (let y = y0; y <= b.y1; y += step) ctx.fillRect(x - r / 2, y - r / 2, r, r);
  } else {
    ctx.strokeStyle = "#e2e2e8";
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
