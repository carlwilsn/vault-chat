// Scribble to erase (board/src/scribble.ts): the classifier on recorded-shape traces (board/src/scribbleTraces.ts),
// scribbles as people make them and normal writing that must never erase (letters, math symbols, zigzags), each in
// twelve variants (tremor, uneven legs); and which strokes a scribble covers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyScribble, coveredShare, scribbleRegion, SCRIBBLE_COVER } from "../../board/src/scribble.ts";
import { scribbleTraces } from "../../board/src/scribbleTraces.ts";

const VARIANTS = 12;

test("every scribble is a scribble, every letter and symbol is writing (12 variants each)", () => {
  const wrong: string[] = [];
  let n = 0;
  for (let v = 0; v < VARIANTS; v++)
    for (const t of scribbleTraces(v)) {
      n++;
      const r = classifyScribble(t.pts);
      if (r.ok !== t.scribble) wrong.push(`${t.name} #${v}: ${r.why} (reversals ${r.reversals}, turn ${r.medianTurn.toFixed(0)}°, straight ${r.straight.toFixed(2)}, ratio ${r.ratio.toFixed(2)}, leg ${r.legMs.toFixed(0)} ms)`);
    }
  assert.ok(n > 300, String(n));
  assert.deepEqual(wrong, []);
});

test("the shapes the brief names stay writing: m, w, z, ∑ and zigzags", () => {
  for (const name of ["m (printed)", "mmm (cursive)", "w", "www (cursive)", "z", "Z", "∑", "∑ (fast)", "resistor zigzag", "steep zigzag (a spring drawn fast)"]) {
    const t = scribbleTraces().find((x) => x.name === name);
    assert.ok(t, name);
    assert.equal(classifyScribble(t.pts).ok, false, name);
  }
});

test("a slow back-and-forth is not a scribble (it has to be quick)", () => {
  const t = scribbleTraces().find((x) => x.name === "horizontal scribble over a word, drifting down")!;
  const slow = t.pts.map((p) => ({ ...p, t: p.t * 4 }));
  assert.equal(classifyScribble(t.pts).ok, true);
  assert.equal(classifyScribble(slow).ok, false);
  assert.equal(classifyScribble(slow).why, "too slow");
});

test("the classifier is the same at every zoom (it works in screen px; the caller scales)", () => {
  const t = scribbleTraces().find((x) => x.name === "sloppy diagonal scribble, uneven legs")!;
  assert.equal(classifyScribble(t.pts.map((p) => ({ x: p.x * 1.0, y: p.y * 1.0, t: p.t }))).ok, true);
});

// Coverage, in canvas units: a word under a scribble, a word beside it, a long line through it.
const flat = (pts: { x: number; y: number }[]) => pts.flatMap((p) => [p.x, p.y]);
const wordAt = (x0: number, y0: number) => {
  const strokes: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const s: number[] = [];
    for (let k = 0; k <= 12; k++) s.push(x0 + i * 14 + k, y0 + 10 * Math.sin((k / 12) * Math.PI));
    strokes.push(s);
  }
  return strokes;
};

test("a scribble covers the strokes under it, not the word beside it or a line passing through", () => {
  const t = scribbleTraces().find((x) => x.name === "horizontal scribble over a word, drifting down")!;
  // The scribble around (300, 300), 70 wide: a word at 270–330 under it.
  const xy = flat(t.pts);
  const region = scribbleRegion(xy, 2, classifyScribble(t.pts).legPx);
  const under = wordAt(270, 292);
  const beside = wordAt(360, 292);
  const line: number[] = [];
  for (let x = 100; x <= 600; x += 5) line.push(x, 300);
  for (const s of under) assert.ok(coveredShare(s, region, 1) >= SCRIBBLE_COVER, `under: ${coveredShare(s, region, 1)}`);
  for (const s of beside) assert.ok(coveredShare(s, region, 1) < SCRIBBLE_COVER, `beside: ${coveredShare(s, region, 1)}`);
  assert.ok(coveredShare(line, region, 1) < SCRIBBLE_COVER);
  // A dot (one point) is covered when it is inside.
  assert.equal(coveredShare([300, 300], region, 1), 1);
});

test("a scribble moving along a line of writing covers the letters along its path", () => {
  const t = scribbleTraces().find((x) => x.name === "scribble along a line of writing")!;
  const region = scribbleRegion(flat(t.pts), 2, classifyScribble(t.pts).legPx);
  let x0 = Infinity, x1 = -Infinity;
  for (const p of t.pts) (x0 = Math.min(x0, p.x)), (x1 = Math.max(x1, p.x));
  // Small letters along its middle.
  for (let x = x0 + 6; x < x1 - 10; x += 12) {
    const s = [x, 298, x + 4, 303, x + 8, 298];
    assert.ok(coveredShare(s, region, 1) >= SCRIBBLE_COVER, `letter at ${x}`);
  }
  // A letter well above it is not.
  assert.ok(coveredShare([x0 + 20, 250, x0 + 28, 255], region, 1) < SCRIBBLE_COVER);
});
