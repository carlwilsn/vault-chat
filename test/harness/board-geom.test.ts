// The whiteboard's ink geometry (board/src/geom.ts): the precise eraser cuts
// a stroke into clean pieces, the stroke eraser's hit test, the lasso.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capsuleHits, cutStroke, lassoedBox, lassoedXY, ptSeg, Simplifier, Smoother } from "../../board/src/geom.ts";

const horiz = (x0: number, x1: number, y = 0, step = 10) => {
  const out: number[] = [];
  for (let x = x0; x <= x1; x += step) out.push(x, y);
  return out;
};
const dot = (cx: number, cy: number, r: number) => ({ ax: cx, ay: cy, bx: cx, by: cy, r });

test("the precise eraser splits a stroke through its middle; caps end on the eraser's edge", () => {
  const xy = horiz(0, 200);
  const w = 4;
  const pieces = cutStroke(xy, w, dot(100, 0, 10))!;
  assert.equal(pieces.length, 2);
  const [a, b] = pieces as [number[], number[]];
  assert.deepEqual(a.slice(0, 2), [0, 0]);
  assert.deepEqual(b.slice(-2), [200, 0]);
  // The cut is at R = 10 + w/2 from the centre: the round caps (radius 2) just reach the circle.
  assert.ok(Math.abs(a[a.length - 2]! - 88) < 0.11, String(a[a.length - 2]));
  assert.ok(Math.abs(b[0]! - 112) < 0.11, String(b[0]));
  // Nothing kept is within the eraser (allowing the stored 0.1 rounding).
  for (const p of pieces) for (let k = 0; k < p.length; k += 2) assert.ok(Math.hypot(p[k]! - 100, p[k + 1]!) >= 12 - 0.11);
});

test("a cut between two samples (a long segment) is found geometrically", () => {
  const pieces = cutStroke([0, 0, 300, 0], 2, dot(150, 3, 5))!;
  assert.equal(pieces.length, 2);
  // R = 6, the centre 3 off the line: half-chord sqrt(36 - 9).
  assert.ok(Math.abs(pieces[0]![2]! - (150 - Math.sqrt(27))) < 0.11);
  assert.ok(Math.abs(pieces[1]![0]! - (150 + Math.sqrt(27))) < 0.11);
});

test("a swept eraser (a drag) cuts a crossing stroke once; an end erases from that end", () => {
  const vertical = [100, -100, 100, 100];
  const sweep = { ax: 0, ay: 0, bx: 200, by: 0, r: 8 };
  const pieces = cutStroke(vertical, 2, sweep)!;
  assert.equal(pieces.length, 2);
  assert.ok(Math.abs(pieces[0]![3]! + 9) < 0.11);
  assert.ok(Math.abs(pieces[1]![1]! - 9) < 0.11);
  const end = cutStroke(horiz(0, 100), 2, dot(0, 0, 20))!;
  assert.equal(end.length, 1);
  assert.ok(Math.abs(end[0]![0]! - 21) < 0.11);
});

test("untouched strokes come back null; a fully covered one comes back empty; slivers are dropped", () => {
  assert.equal(cutStroke(horiz(0, 100), 2, dot(50, 40, 10)), null);
  assert.deepEqual(cutStroke(horiz(0, 20), 2, dot(10, 0, 30)), []);
  assert.deepEqual(cutStroke([5, 5], 2, dot(5, 6, 3)), []);
  // A piece shorter than 0.5 left at an end is not kept.
  assert.equal(cutStroke(horiz(0, 100), 2, dot(11.2, 0, 10))!.length, 1);
});

test("a graze (the eraser touching a wide stroke's edge) cuts nothing; a real cut through it does", () => {
  const hl = horiz(0, 200);
  // Width 18: the circle (r 10) dips 2 into the band — the centreline gap would be ~12 < 18.
  assert.equal(cutStroke(hl, 18, dot(100, 17, 10)), null);
  const through = cutStroke(hl, 18, dot(100, 0, 10))!;
  assert.equal(through.length, 2);
});

test("the stroke eraser hits along the sweep, not just at samples", () => {
  const xy = [0, 0, 0, 100];
  assert.equal(capsuleHits(xy, 2, dot(50, 50, 5)), false);
  assert.equal(capsuleHits(xy, 2, { ax: -50, ay: 50, bx: 50, by: 50, r: 1 }), true);
  assert.equal(capsuleHits(xy, 2, dot(5, 50, 4.2)), true);
  assert.equal(ptSeg(5, 5, 0, 0, 10, 0), 5);
});

test("the lasso takes most-inside strokes and boxes", () => {
  const poly = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  assert.equal(lassoedXY(horiz(10, 90, 50), poly), true);
  assert.equal(lassoedXY(horiz(60, 200, 50), poly), false);
  assert.equal(lassoedBox({ x: 10, y: 10, w: 60, h: 60 }, poly), true);
  assert.equal(lassoedBox({ x: 60, y: 60, w: 100, h: 100 }, poly), false);
});

test("the smoother follows the pen and skips tiny steps", () => {
  const s = new Smoother(0.5, 0.3);
  assert.deepEqual(s.push(0, 0), { x: 0, y: 0 });
  assert.deepEqual(s.push(10, 0), { x: 5, y: 0 });
  assert.equal(s.push(5.2, 0), null);
});

test("ink written on an item moves with it; ink that crosses its edge stays", async () => {
  const { carriedInk } = await import("../../board/src/geom.ts");
  const item = { x: 100, y: 100, w: 200, h: 100 };
  const on = { xy: [120, 120, 180, 150, 290, 190] };
  const crossing = { xy: [150, 150, 350, 150] };
  const outside = { xy: [0, 0, 10, 10] };
  const selected = { xy: [110, 110, 120, 120] };
  const got = carriedInk([on, crossing, outside, selected], new Set([selected]), [item]);
  assert.deepEqual(got, [on]);
  assert.deepEqual(carriedInk([on], new Set(), []), []);
});

test("the simplifier straightens a staircase of whole-px samples and keeps a corner where it is", () => {
  // A shallow line sampled in whole px (WebKit's clientX/Y): y steps 1 px every 80.
  const s = new Simplifier(0.75);
  for (let x = 0; x <= 400; x += 3) s.push({ x, y: Math.round(x / 80) });
  const pts = s.final();
  assert.ok(pts.length <= 3, `${pts.length} points`);
  // A "v": the corner is kept, within a sample.
  const v = new Simplifier(0.75);
  for (let i = 0; i <= 40; i++) v.push({ x: i, y: i * 2 });
  for (let i = 1; i <= 40; i++) v.push({ x: 40 + i, y: 80 - i * 2 });
  const vp = v.final();
  // Live, the kept points too stay within eps.
  assert.ok(v.points().length >= vp.length);
  assert.ok(vp.some((p) => Math.abs(p.x - 40) <= 1 && Math.abs(p.y - 80) <= 2), JSON.stringify(vp));
  // Every sample stays within eps of the kept polyline.
  for (let i = 0; i <= 80; i++) {
    const q = i <= 40 ? { x: i, y: i * 2 } : { x: i, y: 80 - (i - 40) * 2 };
    let d = Infinity;
    for (let k = 0; k + 1 < vp.length; k++) d = Math.min(d, ptSeg(q.x, q.y, vp[k]!.x, vp[k]!.y, vp[k + 1]!.x, vp[k + 1]!.y));
    assert.ok(d <= 0.75 + 1e-9, `${i}: ${d}`);
  }
});
