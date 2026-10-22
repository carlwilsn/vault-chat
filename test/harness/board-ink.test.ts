// How ink is drawn (board/src/ink.ts: the pen's samples stabilised by perfect-freehand, the centreline stroked at the
// stroke's width; board/preview/ink-band.mjs checks the pixels are one band of that width), measured on recorded-shape
// handwriting (board/src/inkTraces.ts: tremor, sensor noise, whole-px samples) against the path the hand meant
// (board/src/inkMetrics.ts). Before (the bend-point simplifier and Catmull–Rom curve, 25dc8c2) on the same traces:
// dev 0.326 px, max 2.08 px, wiggle 0.161, and a jump of up to 2.5 px when the pen lifted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { INK, inkCentre } from "../../board/src/ink.ts";
import { inkTraces } from "../../board/src/inkTraces.ts";
import { inkMetrics, type P } from "../../board/src/inkMetrics.ts";

const W = 2.4;
const flat = (pts: { x: number; y: number }[]) => pts.flatMap((p) => [p.x, p.y]);
const unflat = (f: number[]) => {
  const o: P[] = [];
  for (let i = 0; i + 1 < f.length; i += 2) o.push([f[i]!, f[i + 1]!]);
  return o;
};
/** As ink.ts draws through points: quadratic curves between midpoints (flattened). */
function drawn(c: P[]): P[] {
  if (c.length < 3) return c;
  const out: P[] = [c[0]!];
  let s: P = c[0]!;
  for (let i = 1; i < c.length - 1; i++) {
    const m: P = [(c[i]![0] + c[i + 1]![0]) / 2, (c[i]![1] + c[i + 1]![1]) / 2];
    for (let k = 1; k <= 8; k++) {
      const t = k / 8, u = 1 - t;
      out.push([u * u * s[0] + 2 * u * t * c[i]![0] + t * t * m[0], u * u * s[1] + 2 * u * t * c[i]![1] + t * t * m[1]]);
    }
    s = m;
  }
  out.push(c[c.length - 1]!);
  return out;
}

test("the drawn line follows the hand closely and smoothly (handwriting, small letters, fast strokes)", () => {
  const traces = [0, 1, 2].flatMap((v) => inkTraces(v));
  let dev = 0, max = 0, wiggle = 0, rawWiggle = 0;
  const per: string[] = [];
  for (const t of traces) {
    const m = inkMetrics(drawn(unflat(inkCentre(flat(t.pts), W))), t.truth);
    dev += m.dev;
    max = Math.max(max, m.max);
    wiggle += m.wiggle;
    rawWiggle += inkMetrics(t.pts.map((p) => [p.x, p.y] as P), t.truth).wiggle;
    per.push(`${t.name}: dev ${m.dev.toFixed(2)} max ${m.max.toFixed(2)} wiggle ${m.wiggle.toFixed(3)}`);
  }
  const n = traces.length;
  const r = { dev: dev / n, max, wiggle: wiggle / n, rawWiggle: rawWiggle / n };
  console.log(JSON.stringify(r), "\n  " + per.join("\n  "));
  // Closer to the hand's path than the samples themselves (0.30 px) and than before (0.33), never far off it
  // (corners kept: before, 2.1 px), and smooth (the samples: 0.80; before: 0.16).
  assert.ok(r.dev <= 0.29, `dev ${r.dev}`);
  assert.ok(r.max <= 1.1, `max ${r.max}`);
  assert.ok(r.wiggle <= 0.17, `wiggle ${r.wiggle}`);
  assert.ok(r.wiggle < r.rawWiggle / 4);
});

test("written and finished are one: the line already drawn never moves as the pen goes on, or when it lifts", () => {
  for (const t of inkTraces(0)) {
    const xy = flat(t.pts);
    const final = inkCentre(xy, W);
    // At every 10th sample, the stroke so far: all but its last stretch (the tip, within a few widths of the pen)
    // is exactly where the finished stroke has it.
    for (let k = 20; k < t.pts.length; k += 10) {
      const live = unflat(inkCentre(xy.slice(0, k * 2), W));
      const fin = unflat(final);
      let moved = 0;
      for (let i = 0; i < live.length - 8; i++) moved = Math.max(moved, Math.hypot(live[i]![0] - fin[i]![0], live[i]![1] - fin[i]![1]));
      assert.ok(moved < 1e-9, `${t.name} at ${k}: ${moved}`);
    }
    // And the line the pen leaves is the one it was drawing (same function, same samples).
    assert.deepEqual(inkCentre(xy, W), inkCentre(xy.slice(), W));
  }
});

test("a stroke keeps its look when scaled (every length relative to its width, up to the highlighter cap)", () => {
  const t = inkTraces(0).find((x) => x.name === "2 (24 px)")!;
  const a = inkCentre(flat(t.pts), W);
  const b = inkCentre(flat(t.pts).map((v) => v * 0.5), W * 0.5);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i]! * 0.5 - b[i]!) < 1e-6);
});

test("a dot, a two-point line and an older board's sparse stroke all draw", () => {
  // A one-sample stroke: a centreline a tiny fraction of the width long, so its round caps make a dot W across.
  const dot = unflat(inkCentre([10, 10], W));
  assert.ok(dot.length >= 1 && dot.every(([x, y]) => Math.hypot(x - 10, y - 10) < W / 10), JSON.stringify(dot));
  const line = unflat(inkCentre([0, 0, 100, 0], W));
  assert.ok(line.length >= 2 && line.every(([, y]) => Math.abs(y) < 1e-9) && line[0]![0] === 0 && line[line.length - 1]![0] === 100, JSON.stringify(line.slice(0, 6)));
  // Bend points a few px apart (how strokes were stored before): the shape is kept, its corner too.
  const v = unflat(inkCentre([0, 0, 20, 40, 40, 0], W));
  assert.ok(v.some(([x, y]) => Math.abs(x - 20) < 2 && y > 37), JSON.stringify(v));
  assert.ok(INK.streamline > 0 && INK.streamline < 1);
});
