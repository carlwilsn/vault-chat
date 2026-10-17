// Where inbox parts land on the board (board/src/place.ts): centred in the
// view, uniform (each keeps its aspect ratio), and always inside the view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeParts } from "../../board/src/place.ts";

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
