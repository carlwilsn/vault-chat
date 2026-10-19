// Recorded-shape pen traces for the scribble classifier (scribble.ts): scribbles as people make them over writing,
// and normal writing that must never be taken for one (letters, math symbols, zigzags). Each is sampled as a
// Pencil delivers it (240 Hz), with the hand's speed (slower in the turns) and a little tremor; screen css px.
// Used by test/harness/board-scribble.test.ts and the WebKit proof (board/preview/ink.mjs). Not imported by the app.
import type { TP } from "./scribble";

type Pt = [number, number];
export type ScribbleTrace = { name: string; scribble: boolean; pts: TP[] };

/** A deterministic tremor. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** Round a polyline's corners: each corner becomes a curve from `r` px before it to `r` px after (at most 45% of a side). */
function roundCorners(p: Pt[], r: number): Pt[] {
  if (r <= 0 || p.length < 3) return p;
  const o: Pt[] = [p[0]!];
  for (let i = 1; i + 1 < p.length; i++) {
    const [ax, ay] = p[i - 1]!, [cx, cy] = p[i]!, [bx, by] = p[i + 1]!;
    const la = Math.hypot(cx - ax, cy - ay), lb = Math.hypot(bx - cx, by - cy);
    if (!la || !lb) continue;
    const ra = Math.min(r, la * 0.45), rb = Math.min(r, lb * 0.45);
    const s0: Pt = [cx - ((cx - ax) / la) * ra, cy - ((cy - ay) / la) * ra], s1: Pt = [cx + ((bx - cx) / lb) * rb, cy + ((by - cy) / lb) * rb];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6, u = 1 - t;
      o.push([u * u * s0[0] + 2 * u * t * cx + t * t * s1[0], u * u * s0[1] + 2 * u * t * cy + t * t * s1[1]]);
    }
  }
  o.push(p[p.length - 1]!);
  return o;
}

/**
 * The pen along a path: `speed` px/ms on the straights, slowing to a third in sharp turns; a sample every 1/240 s;
 * `tremor` px of noise. `round` rounds the corners first (a radius, px).
 */
export function penAlong(path: Pt[], o: { speed: number; round?: number; tremor?: number; seed?: number; t0?: number }): TP[] {
  const p = roundCorners(path, o.round ?? 2);
  // Dense resampling with the local turn.
  const dense: { x: number; y: number; turn: number }[] = [];
  for (let i = 0; i + 1 < p.length; i++) {
    const [ax, ay] = p[i]!, [bx, by] = p[i + 1]!;
    const d = Math.hypot(bx - ax, by - ay);
    const m = Math.max(1, Math.ceil(d / 0.5));
    for (let j = i ? 1 : 0; j <= m; j++) dense.push({ x: ax + ((bx - ax) * j) / m, y: ay + ((by - ay) * j) / m, turn: 0 });
  }
  const W = 6;
  for (let i = W; i < dense.length - W; i++) {
    const a = dense[i - W]!, c = dense[i]!, b = dense[i + W]!;
    const ux = c.x - a.x, uy = c.y - a.y, vx = b.x - c.x, vy = b.y - c.y;
    const l = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    c.turn = l ? Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / l))) / Math.PI : 0;
  }
  const rand = rng(o.seed ?? 7);
  const tremor = o.tremor ?? 0.3;
  const out: TP[] = [];
  const dt = 1000 / 240;
  let t = o.t0 ?? 0, acc = 0;
  out.push({ x: dense[0]!.x, y: dense[0]!.y, t });
  let elapsed = 0;
  for (let i = 1; i < dense.length; i++) {
    const a = dense[i - 1]!, b = dense[i]!;
    const v = o.speed * (1 - 0.66 * b.turn);
    elapsed += Math.hypot(b.x - a.x, b.y - a.y) / v;
    acc = elapsed;
    if (acc >= dt || i === dense.length - 1) {
      t += acc;
      elapsed = 0;
      out.push({ x: b.x + rand() * tremor, y: b.y + rand() * tremor, t });
    }
  }
  return out;
}

const deg = Math.PI / 180;

/** A scribble: `legs` strokes back and forth of length `len` at angle `angle`, moving `drift` px per leg across. */
function scribble(o: { cx: number; cy: number; len: number; legs: number; angle?: number; drift?: number; vary?: number; legMs: number; seed: number; round?: number }): TP[] {
  const rand = rng(o.seed * 31 + 3);
  const a = (o.angle ?? 0) * deg, ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
  const pts: Pt[] = [];
  const total = (o.legs - 1) * (o.drift ?? 0);
  for (let i = 0; i <= o.legs; i++) {
    const half = (o.len / 2) * (1 + (o.vary ?? 0.1) * rand());
    const side = i % 2 ? 1 : -1;
    const d = i * (o.drift ?? 0) - total / 2 + rand() * 1.5;
    pts.push([o.cx + ux * half * side + px * d, o.cy + uy * half * side + py * d]);
  }
  return penAlong(pts, { speed: o.len / o.legMs, round: o.round ?? 3, tremor: 0.35, seed: o.seed });
}

/** A letter or a symbol from its control polyline, `h` px tall at (x, y) (its top-left), written at `speed`. */
let glyphSeed = 11;
function glyph(shape: Pt[], o: { x: number; y: number; h: number; speed?: number; round?: number; seed?: number }): TP[] {
  return penAlong(
    shape.map(([u, v]) => [o.x + u * o.h, o.y + v * o.h]),
    { speed: o.speed ?? 0.25, round: o.round ?? 1.5, tremor: 0.3, seed: o.seed ?? glyphSeed },
  );
}

// Control polylines in units of the letter's height (0 = top, 1 = baseline). Arches are a few points each.
const arch = (x0: number, x1: number, top: number, bottom: number): Pt[] => {
  const o: Pt[] = [];
  for (let k = 0; k <= 8; k++) {
    const a = Math.PI - (k / 8) * Math.PI;
    o.push([(x0 + x1) / 2 + ((x1 - x0) / 2) * Math.cos(a), bottom - (bottom - top) * Math.sin(a) * (k === 0 || k === 8 ? 0.6 : 1)]);
  }
  return o;
};
const M_PRINT: Pt[] = [[0, 0.35], [0, 1], [0, 0.45], ...arch(0, 0.45, 0.3, 0.55), [0.45, 1], [0.45, 0.45], ...arch(0.45, 0.9, 0.3, 0.55), [0.9, 1]];
const mCursive = (n: number): Pt[] => {
  const o: Pt[] = [[-0.2, 1], [0, 0.35], [0, 1]];
  for (let i = 0; i < n * 2; i++) o.push(...arch(i * 0.38, (i + 1) * 0.38, 0.3, 0.5), [(i + 1) * 0.38, 1]);
  o.push([n * 0.76 + 0.2, 0.8]);
  return o;
};
const nCursive = (n: number): Pt[] => {
  const o: Pt[] = [[-0.15, 1], [0, 0.35], [0, 1]];
  for (let i = 0; i < n; i++) o.push(...arch(i * 0.55, (i + 1) * 0.55, 0.3, 0.5), [(i + 1) * 0.55, 1], [(i + 1) * 0.55 + 0.15, 0.85]);
  return o;
};
const W_PRINT: Pt[] = [[0, 0.3], [0.2, 1], [0.4, 0.4], [0.6, 1], [0.8, 0.3]];
const wRow = (n: number, slant = 0.2): Pt[] => {
  const o: Pt[] = [[0, 0.3]];
  for (let i = 0; i < n; i++) {
    const x = i * 4 * slant;
    o.push([x + slant, 1], [x + 2 * slant, 0.35], [x + 3 * slant, 1], [x + 4 * slant, 0.3]);
  }
  return o;
};
const vRow = (n: number, slant = 0.22): Pt[] => {
  const o: Pt[] = [[0, 0.3]];
  for (let i = 0; i < n; i++) o.push([i * 2 * slant + slant, 1], [i * 2 * slant + 2 * slant, 0.3]);
  return o;
};
const Z: Pt[] = [[0, 0.3], [0.6, 0.3], [0, 1], [0.6, 1]];
const Z_CAP: Pt[] = [[0, 0], [0.7, 0], [0, 1], [0.7, 1]];
const SIGMA: Pt[] = [[0.75, 0.02], [0, 0], [0.4, 0.5], [0, 1], [0.8, 1]];
const M_CAP: Pt[] = [[0, 1], [0.02, 0], [0.4, 0.75], [0.78, 0], [0.8, 1]];
const N_CAP: Pt[] = [[0, 1], [0, 0], [0.6, 1], [0.6, 0]];
const E_CAP: Pt[] = [[0.6, 0], [0, 0], [0, 0.5], [0.45, 0.5], [0, 0.5], [0, 1], [0.6, 1]];
const STAR: Pt[] = [0, 1, 2, 3, 4, 5].map((k) => {
  const a = -Math.PI / 2 + k * ((4 * Math.PI) / 5);
  return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)] as Pt;
});
const zigzag = (n: number, slope = 60): Pt[] => {
  const o: Pt[] = [[0, 0.5]];
  const dx = 0.5 / Math.tan(slope * deg);
  for (let i = 0; i < n; i++) o.push([(i + 0.5) * dx * 2, i % 2 ? 1 : 0]);
  o.push([(n + 0.5) * dx * 2, 0.5]);
  return o;
};
const loops = (n: number): Pt[] => {
  const o: Pt[] = [];
  for (let i = 0; i <= n * 24; i++) {
    const a = (i / 24) * 2 * Math.PI;
    o.push([i / 24 * 0.45 + 0.25 * Math.sin(a), 0.55 - 0.4 * (1 - Math.cos(a)) / 2 * 2 + 0.4]);
  }
  return o;
};
const INF: Pt[] = Array.from({ length: 49 }, (_, i) => {
  const a = (i / 48) * 2 * Math.PI;
  return [0.6 + 0.6 * Math.sin(a), 0.5 + 0.3 * Math.sin(2 * a)] as Pt;
});
const wave = (n: number): Pt[] => Array.from({ length: n * 12 + 1 }, (_, i) => [i / 12 * 0.5, 0.5 + 0.25 * Math.sin((i / 12) * 2 * Math.PI)] as Pt);
const DOUBLE_UNDERLINE: Pt[] = [[0, 0.9], [3, 0.92], [0.1, 1.05], [3, 1.08]];
const EIGHT: Pt[] = Array.from({ length: 49 }, (_, i) => {
  const a = (i / 48) * 2 * Math.PI;
  return [0.35 + 0.3 * Math.sin(2 * a), 0.5 - 0.5 * Math.cos(a)] as Pt;
});

/** Every trace, scribbles first (`v` varies the tremor and the scribbles' uneven legs). Screen css px. */
export function scribbleTraces(v = 0): ScribbleTrace[] {
  const S = (name: string, pts: TP[]): ScribbleTrace => ({ name, scribble: true, pts });
  const N = (name: string, pts: TP[]): ScribbleTrace => ({ name, scribble: false, pts });
  glyphSeed = 11 + v * 13;
  return [
    S("horizontal scribble over a word, drifting down", scribble({ cx: 300, cy: 300, len: 70, legs: 9, angle: 0, drift: 2.5, legMs: 75, seed: 1 + v * 17 })),
    S("vertical scribble moving along a word", scribble({ cx: 300, cy: 300, len: 32, legs: 12, angle: 90, drift: 4.5, legMs: 70, seed: 2 + v * 17 })),
    S("small scribble over one letter", scribble({ cx: 300, cy: 300, len: 16, legs: 7, angle: 10, drift: 1, legMs: 45, seed: 3 + v * 17 })),
    S("large scribble over a diagram", scribble({ cx: 400, cy: 400, len: 170, legs: 7, angle: -15, drift: 12, legMs: 140, seed: 4 + v * 17 })),
    S("sloppy diagonal scribble, uneven legs", scribble({ cx: 300, cy: 300, len: 55, legs: 10, angle: 35, drift: 4, vary: 0.3, legMs: 85, seed: 5 + v * 17 })),
    S("loopy scribble (round turns)", scribble({ cx: 300, cy: 300, len: 45, legs: 8, angle: 0, drift: 3, legMs: 70, seed: 6 + v * 17, round: 7 })),
    S("unhurried scribble", scribble({ cx: 300, cy: 300, len: 50, legs: 6, angle: 5, drift: 3, legMs: 150, seed: 7 + v * 17 })),
    S("scribble along a line of writing", scribble({ cx: 400, cy: 300, len: 26, legs: 16, angle: 80, drift: 4, legMs: 60, seed: 8 + v * 17 })),
    N("m (printed)", glyph(M_PRINT, { x: 100, y: 100, h: 30 })),
    N("m (printed, fast)", glyph(M_PRINT, { x: 100, y: 100, h: 30, speed: 0.6 })),
    N("mmm (cursive)", glyph(mCursive(3), { x: 100, y: 100, h: 30 })),
    N("mmm (cursive, fast and small)", glyph(mCursive(3), { x: 100, y: 100, h: 14, speed: 0.5 })),
    N("nnnn (cursive)", glyph(nCursive(4), { x: 100, y: 100, h: 28, speed: 0.35 })),
    N("w", glyph(W_PRINT, { x: 100, y: 100, h: 30 })),
    N("www (cursive)", glyph(wRow(3), { x: 100, y: 100, h: 30, speed: 0.35 })),
    N("www (steep, fast)", glyph(wRow(3, 0.16), { x: 100, y: 100, h: 30, speed: 0.5 })),
    N("vvvv", glyph(vRow(4), { x: 100, y: 100, h: 30, speed: 0.4 })),
    N("W", glyph(W_PRINT, { x: 100, y: 100, h: 60 })),
    N("z", glyph(Z, { x: 100, y: 100, h: 30 })),
    N("Z", glyph(Z_CAP, { x: 100, y: 100, h: 40, speed: 0.4 })),
    N("∑", glyph(SIGMA, { x: 100, y: 100, h: 40 })),
    N("∑ (fast)", glyph(SIGMA, { x: 100, y: 100, h: 24, speed: 0.5 })),
    N("M", glyph(M_CAP, { x: 100, y: 100, h: 40 })),
    N("N", glyph(N_CAP, { x: 100, y: 100, h: 40 })),
    N("E in one stroke", glyph(E_CAP, { x: 100, y: 100, h: 40 })),
    N("☆ in one stroke", glyph(STAR, { x: 100, y: 100, h: 50, speed: 0.45 })),
    N("resistor zigzag", glyph(zigzag(8, 60), { x: 100, y: 100, h: 24, speed: 0.45 })),
    N("steep zigzag (a spring drawn fast)", glyph(zigzag(8, 70), { x: 100, y: 100, h: 30, speed: 0.6 })),
    N("eeee loops", glyph(loops(4), { x: 100, y: 100, h: 30, speed: 0.35 })),
    N("∞", glyph(INF, { x: 100, y: 100, h: 30, speed: 0.3, round: 0 })),
    N("8", glyph(EIGHT, { x: 100, y: 100, h: 35, speed: 0.3, round: 0 })),
    N("~~~ wave", glyph(wave(4), { x: 100, y: 100, h: 30, speed: 0.35, round: 0 })),
    N("double underline in one stroke", glyph(DOUBLE_UNDERLINE, { x: 100, y: 100, h: 30, speed: 0.6 })),
  ];
}
