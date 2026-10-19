// Where inbox parts land on the board (board/src/place.ts): centred in the
// view, uniform (each keeps its aspect ratio), and always inside the view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pillSpot, placeParts } from "../../board/src/place.ts";

const view = { cx: 500, cy: 400, w: 1000, h: 700 };
const inside = (b: { x: number; y: number; w: number; h: number }) =>
  b.x >= view.cx - view.w / 2 - 0.2 && b.y >= view.cy - view.h / 2 - 0.2 && b.x + b.w <= view.cx + view.w / 2 + 0.2 && b.y + b.h <= view.cy + view.h / 2 + 0.2;

test("one part lands at the centre, 60% of the view wide, its aspect kept", () => {
  const [b] = placeParts([{ lw: 560, lh: 140 }], view);
  assert.equal(b!.w, 600);
  assert.equal(b!.h, 150);
  assert.ok(Math.abs(b!.x + b!.w / 2 - 500) < 0.2 && Math.abs(b!.y + b!.h / 2 - 400) < 0.2);
});

test("a tall part is fitted to 80% of the view's height; a sent width is used", () => {
  const [tall] = placeParts([{ lw: 612, lh: 792 }], view);
  assert.ok(Math.abs(tall!.h - 560) < 0.2);
  assert.ok(Math.abs(tall!.w / tall!.h - 612 / 792) < 0.002);
  const [sent] = placeParts([{ lw: 400, lh: 300, width: 200 }], view);
  assert.equal(sent!.w, 200);
  assert.equal(sent!.h, 150);
});

test("several parts: two to a row, scaled down together to fit the view, aspect kept, no overlaps", () => {
  const pages = [3, 4, 5].map(() => ({ lw: 612, lh: 792 }));
  const bs = placeParts(pages, view);
  assert.equal(bs.length, 3);
  for (const b of bs) {
    assert.ok(inside(b), JSON.stringify(b));
    assert.ok(Math.abs(b.w / b.h - 612 / 792) < 0.002);
  }
  assert.equal(bs[0]!.y, bs[1]!.y); // the first two share a row
  assert.ok(bs[2]!.y > bs[0]!.y + bs[0]!.h); // the third below them
  const overlap = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) assert.ok(!overlap(bs[i], bs[j]));
  const many = placeParts(Array.from({ length: 9 }, () => ({ lw: 560, lh: 200 })), view);
  for (const b of many) assert.ok(inside(b));
});

const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x0: number; y0: number; x1: number; y1: number }) => a.x < b.x1 && b.x0 < a.x + a.w && a.y < b.y1 && b.y0 < a.y + a.h;

test("Add all keeps clear of what is on the board: nearest free spot in view, send order kept", () => {
  const parts = Array.from({ length: 4 }, () => ({ lw: 560, lh: 140 }));
  // Ink across the middle of the view.
  const avoid = [{ x0: 200, y0: 330, x1: 800, y1: 470 }];
  const bs = placeParts(parts, view, avoid);
  for (const b of bs) {
    assert.ok(inside(b), JSON.stringify(b));
    assert.ok(!overlap(b, avoid[0]!), JSON.stringify(b));
  }
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) assert.ok(!overlap(bs[i]!, { x0: bs[j]!.x, y0: bs[j]!.y, x1: bs[j]!.x + bs[j]!.w, y1: bs[j]!.y + bs[j]!.h }));
  // Send order: reading order (rows top to bottom, left to right in a row).
  const order = bs.map((b, i) => ({ i, y: Math.round(b.y), x: b.x })).sort((a, b) => a.y - b.y || a.x - b.x).map((o) => o.i);
  assert.deepEqual(order, [0, 1, 2, 3]);
  // Nothing in the way: exactly the centred arrangement.
  assert.deepEqual(placeParts(parts, view, [{ x0: 5000, y0: 5000, x1: 5100, y1: 5100 }]), placeParts(parts, view));
});

test("Add all with no room in view lands beside what is there, at full size, on nothing", () => {
  const parts = [{ lw: 560, lh: 400 }, { lw: 560, lh: 400 }];
  const full = [{ x0: 0, y0: 50, x1: 1000, y1: 750 }];
  const bs = placeParts(parts, view, full);
  const fitted = placeParts(parts, view);
  for (const [k, b] of bs.entries()) {
    assert.ok(!overlap(b, full[0]!), JSON.stringify(b));
    assert.equal(b.w, fitted[k]!.w);
  }
});

test("the selection pill: centred above at a fixed gap, flipped below, inside when it fills the view, clamped, null off-screen", () => {
  const v = { w: 1180, h: 820, top: 76 };
  const pill = { w: 120, h: 48 };
  const a = pillSpot({ x0: 400, y0: 300, x1: 600, y1: 400 }, pill, v)!;
  assert.deepEqual(a, { x: 440, y: 300 - 18 - 48, side: "above" });
  // Near the top: below, same gap.
  const b = pillSpot({ x0: 400, y0: 90, x1: 600, y1: 300 }, pill, v)!;
  assert.deepEqual(b, { x: 440, y: 318, side: "below" });
  // Fills the view: inside, under its top handles and the controls.
  const c = pillSpot({ x0: -100, y0: 20, x1: 1300, y1: 900 }, pill, v)!;
  assert.equal(c.side, "inside");
  assert.ok(c.y >= v.top && c.y >= 20 + 18 + 10);
  // Near the left and right edges: clamped inside the view.
  assert.equal(pillSpot({ x0: -300, y0: 300, x1: 30, y1: 400 }, pill, v)!.x, 10);
  assert.equal(pillSpot({ x0: 1150, y0: 300, x1: 1500, y1: 400 }, pill, v)!.x, 1180 - 10 - 120);
  // Above never covers the top handles (drawn 9 px round the corners); below never the bottom ones.
  for (const s of [a, b]) {
    const sel = s === a ? { x0: 400, y0: 300, x1: 600, y1: 400 } : { x0: 400, y0: 90, x1: 600, y1: 300 };
    for (const [hx, hy] of [[sel.x0, sel.y0], [sel.x1, sel.y0], [sel.x0, sel.y1], [sel.x1, sel.y1]] as const) {
      const nx = Math.max(s.x, Math.min(hx, s.x + pill.w)), ny = Math.max(s.y, Math.min(hy, s.y + pill.h));
      assert.ok(Math.hypot(hx - nx, hy - ny) > 9, `handle ${hx},${hy}`);
    }
  }
  // Out of view: no pill.
  assert.equal(pillSpot({ x0: 400, y0: 900, x1: 600, y1: 1000 }, pill, v), null);
});
