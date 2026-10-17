// The whiteboard's file format (src/boardFormat.ts): one infinite canvas of
// uniform-width strokes and items; a version-1 board (pages, pressure) migrates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankBoard, contentBounds, imageSize, packXY, parseBoard, serializeBoard, slugify, validSlug, V1_PAGE } from "../../src/boardFormat.ts";

test("points pack to 0.1 unit pairs", () => {
  assert.deepEqual(
    packXY([
      { x: 10.04, y: 20.06 },
      { x: -3.21, y: 0 },
    ]),
    [10, 20.1, -3.2, 0],
  );
});

test("a board round-trips through its file, one stroke and one item per line", () => {
  const b = blankBoard("Lecture 3", 1000);
  const random = (n: number) => Array.from({ length: n }, () => ({ x: Math.random() * 3000 - 1000, y: Math.random() * 5000 }));
  b.strokes.push({ id: "s1", tool: "pen", color: "#1f1f24", w: 2.4, xy: packXY(random(200)) });
  b.strokes.push({ id: "s2", tool: "hl", color: "#ffd21f", w: 18, xy: packXY(random(2)) });
  b.strokes.push({ id: "dot", tool: "pen", color: "#d23a2c", w: 4, xy: packXY(random(1)) });
  b.items.push({ id: "i1", kind: "image", x: 10, y: 20, w: 300, h: 200, src: "assets/a.jpg" });
  b.grid = "dots";
  const text = serializeBoard(b);
  assert.equal(text.split("\n").filter((l) => l.startsWith('{"id"')).length, 4);
  assert.ok(text.startsWith('{"v":2,'));
  const back = parseBoard(text);
  assert.deepEqual(back, b);
  assert.equal(serializeBoard(back), text);
  assert.deepEqual(JSON.parse(text), b);
});

test("a version-1 board loads with its pages stacked and its pressure dropped", () => {
  const v1 = {
    v: 1,
    name: "Old",
    rev: 4,
    page: { w: 1000, h: 1294 },
    pages: [{ strokes: [{ id: "a", tool: "pen", color: "#000", w: 2.2, pts: [10, 20, 0.5, 11.5, 21, 0.62] }] }, { strokes: [] }, { strokes: [{ id: "b", tool: "hl", color: "#ffd21f", w: 18, pts: [5, 5, 0.5] }] }],
    items: [],
  };
  const b = parseBoard(v1);
  assert.equal(b.v, 2);
  assert.equal(b.rev, 4);
  assert.deepEqual(b.strokes[0]!.xy, [10, 20, 11.5, 21]);
  assert.deepEqual(b.strokes[1]!.xy, [5, 5 + 2 * (V1_PAGE.h + V1_PAGE.gap)]);
  assert.equal(b.grid, "plain");
});

test("parse refuses what is not a board", () => {
  assert.throws(() => parseBoard({ pages: [] }), /pages/);
  assert.throws(() => parseBoard({}), /strokes/);
  assert.throws(() => parseBoard({ strokes: [{ id: "a", tool: "brush", color: "#000", w: 1, xy: [1, 2] }] }), /tool/);
  assert.throws(() => parseBoard({ strokes: [{ id: "a", tool: "pen", color: "#000", w: 1, xy: [1, 2, "3", 4] }] }), /points/);
  assert.throws(() => parseBoard({ strokes: [{ id: "a", tool: "pen", color: "#000", w: 1, xy: [1, 2, 3] }] }), /points/);
  assert.throws(() => parseBoard({ strokes: [], items: [{ id: "i", kind: "image", x: 0, y: 0, w: 0, h: 1 }] }), /size/);
  for (const src of ["../x.png", "assets/../../x", "/etc/passwd", "assets/a/b.png", "x.png"]) assert.throws(() => parseBoard({ strokes: [], items: [{ id: "i", kind: "image", x: 0, y: 0, w: 1, h: 1, src }] }), /src/, src);
  assert.throws(() => parseBoard("not json"));
  const b = parseBoard({ strokes: [] });
  assert.equal(b.name, "Untitled board");
  assert.deepEqual(b.items, []);
});

test("content bounds cover ink (with its width) and items", () => {
  assert.equal(contentBounds(blankBoard("x")), null);
  const b = blankBoard("x");
  b.strokes.push({ id: "s", tool: "pen", color: "#000", w: 4, xy: [0, 0, 100, 50] });
  b.items.push({ id: "i", kind: "image", x: -50, y: 10, w: 20, h: 300 });
  assert.deepEqual(contentBounds(b), { x0: -50, y0: -2, x1: 102, y1: 310 });
});

test("image sizes from PNG and JPEG headers", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
  assert.deepEqual(imageSize(png), { type: "png", w: 1, h: 1 });
  // SOI, an APP0 segment, then SOF0 with 480 × 640.
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x80, 0x01, 0xe0, 0x03, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { type: "jpeg", w: 480, h: 640 });
  assert.equal(imageSize(Buffer.from("<svg/>")), null);
});

test("slugs", () => {
  assert.equal(slugify("Lecture 3: Fourier"), "lecture-3-fourier");
  assert.equal(slugify("Économie — été"), "economie-ete");
  assert.equal(slugify("!!!"), "board");
  assert.ok(validSlug(slugify("x".repeat(200))));
  for (const bad of ["..", "a/b", "A", "-a", "", "a".repeat(65), "a\\b"]) assert.equal(validSlug(bad), false, bad);
});
