// Recorded-shape pen traces for measuring how ink is drawn (ink.ts): handwriting as a Pencil delivers it, the
// true path the hand meant and the samples the page gets. Samples come every 1/240 s, at the hand's speed (slower in
// the turns), with physiological tremor (8–12 Hz, a few tenths of a px) and sensor noise, rounded to whole css px
// as WebKit delivers them. Screen css px. Used by test/harness/board-ink.test.ts and board/preview/ink.mjs.
// Not imported by the app.

export type Sample = { x: number; y: number; t: number };
export type InkTrace = { name: string; truth: [number, number][]; pts: Sample[] };

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/**
 * The pen along a true path (dense, css px): `speed` px/ms, slowing in the turns; tremor `tremor` px (a smooth
 * 10 Hz wobble) plus `noise` px per sample; `whole`: rounded to whole px.
 */
export function sampleAlong(truth: [number, number][], o: { speed: number; tremor?: number; noise?: number; whole?: boolean; seed?: number }): Sample[] {
  const r = rng(o.seed ?? 3);
  const tremor = o.tremor ?? 0.35, noise = o.noise ?? 0.15, whole = o.whole ?? true;
  // The local turn, for the speed.
  const n = truth.length;
  const turn = new Float64Array(n);
  for (let i = 3; i < n - 3; i++) {
    const a = truth[i - 3]!, c = truth[i]!, b = truth[i + 3]!;
    const ux = c[0] - a[0], uy = c[1] - a[1], vx = b[0] - c[0], vy = b[1] - c[1];
    const l = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    turn[i] = l ? Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / l))) / Math.PI : 0;
  }
  // Tremor: two slow sinusoids per axis with random phases (8–12 Hz).
  const ph = [r(), r(), r(), r()].map((v) => v * Math.PI);
  const fq = [8 + 2 * r(), 11 + r(), 9 + 2 * r(), 12 + r()];
  const wob = (t: number) => [
    tremor * 0.7 * (Math.sin(2 * Math.PI * fq[0]! * t / 1000 + ph[0]!) + 0.5 * Math.sin(2 * Math.PI * fq[1]! * t / 1000 + ph[1]!)),
    tremor * 0.7 * (Math.sin(2 * Math.PI * fq[2]! * t / 1000 + ph[2]!) + 0.5 * Math.sin(2 * Math.PI * fq[3]! * t / 1000 + ph[3]!)),
  ];
  const q = (v: number) => (whole ? Math.round(v) : Math.round(v * 100) / 100);
  const out: Sample[] = [];
  const dt = 1000 / 240;
  let t = 0, acc = 0;
  const push = (x: number, y: number) => {
    const [wx, wy] = wob(t);
    out.push({ x: q(x + wx! + r() * noise), y: q(y + wy! + r() * noise), t });
  };
  push(truth[0]![0], truth[0]![1]);
  for (let i = 1; i < n; i++) {
    const a = truth[i - 1]!, b = truth[i]!;
    acc += Math.hypot(b[0] - a[0], b[1] - a[1]) / (o.speed * (1 - 0.6 * turn[i]!));
    if (acc >= dt || i === n - 1) {
      t += acc;
      acc = 0;
      push(b[0], b[1]);
    }
  }
  return out;
}

/** A dense path from a parametric curve, about every 0.25 px. */
function curve(f: (u: number) => [number, number], approxLen: number): [number, number][] {
  const n = Math.max(8, Math.ceil(approxLen / 0.25));
  return Array.from({ length: n + 1 }, (_, i) => f(i / n));
}
/** A dense polyline through points (sharp corners). */
function polyline(ps: [number, number][]): [number, number][] {
  const o: [number, number][] = [ps[0]!];
  for (let i = 0; i + 1 < ps.length; i++) {
    const [ax, ay] = ps[i]!, [bx, by] = ps[i + 1]!;
    const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.25));
    for (let j = 1; j <= m; j++) o.push([ax + ((bx - ax) * j) / m, ay + ((by - ay) * j) / m]);
  }
  return o;
}

/** Handwriting (math), small letters and fast long strokes; `v` varies the noise. */
export function inkTraces(v = 0): InkTrace[] {
  const T = (name: string, truth: [number, number][], speed: number, extra: { tremor?: number; noise?: number; whole?: boolean } = {}): InkTrace => ({ name, truth, pts: sampleAlong(truth, { speed, seed: 7 + v * 31 + name.length, ...extra }) });
  // x(t) letters about 24 px tall (writing at home zoom), "small" ones 9 px.
  const loopsE = (h: number, x0: number, y0: number) => curve((u) => { const a = u * 3 * 2 * Math.PI; return [x0 + u * h * 2.4 + h * 0.35 * Math.sin(a), y0 + h * 0.5 - h * 0.45 * (1 - Math.cos(a)) / 2 * 2 + h * 0.4]; }, h * 9);
  const two = (h: number, x0: number, y0: number): [number, number][] => [
    ...curve((u) => { const a = Math.PI * (1.1 - 1.25 * u); return [x0 + h * 0.3 + h * 0.3 * Math.cos(a), y0 + h * 0.3 - h * 0.3 * Math.sin(a)]; }, h * 1.2),
    ...polyline([[x0 + h * 0.5, y0 + h * 0.5], [x0, y0 + h], [x0 + h * 0.65, y0 + h]]).slice(1),
  ];
  const integral = (h: number, x0: number, y0: number) => curve((u) => [x0 + h * 0.2 * Math.sin((u - 0.5) * Math.PI) + h * 0.12 * Math.sin(u * 2 * Math.PI) * -1, y0 + u * h + h * 0.08 * Math.sin(u * 2 * Math.PI)], h * 1.4);
  const x = (h: number, x0: number, y0: number) => polyline([[x0, y0], [x0 + h * 0.6, y0 + h]]);
  const sqrtSign = (h: number, x0: number, y0: number) => polyline([[x0, y0 + h * 0.6], [x0 + h * 0.15, y0 + h * 0.5], [x0 + h * 0.35, y0 + h], [x0 + h * 0.6, y0], [x0 + h * 2.5, y0]]);
  const circle = (r: number, cx: number, cy: number) => curve((u) => [cx + r * Math.cos(u * 2 * Math.PI), cy + r * Math.sin(u * 2 * Math.PI)], 2 * Math.PI * r);
  return [
    T("eee loops (24 px)", loopsE(24, 100, 100), 0.25),
    T("2 (24 px)", two(24, 100, 100), 0.2),
    T("∫ (30 px)", integral(30, 100, 100), 0.25),
    T("√ with its bar (20 px)", sqrtSign(20, 100, 100), 0.3),
    T("x stroke (24 px)", x(24, 100, 100), 0.2),
    T("small eee (9 px)", loopsE(9, 100, 100), 0.12),
    T("small 2 (9 px)", two(9, 100, 100), 0.1),
    T("small o (4 px radius)", circle(4, 100, 100), 0.08),
    T("slow shallow line (a staircase)", polyline([[100, 100], [400, 112]]), 0.08),
    T("fast long arc", curve((u) => [100 + 700 * u, 300 - 220 * Math.sin(u * Math.PI)], 1000), 2.2),
    T("fast long line", polyline([[100, 100], [900, 160]]), 3),
    T("underline flick", curve((u) => [100 + 300 * u, 100 + 6 * u * u], 300), 1.5),
  ];
}
