// The whiteboard's file format (src/boardFormat.ts): strokes survive a
// serialize → parse round trip at the stored precision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankBoard, packPoints, parseBoard, serializeBoard, slugify, unpackPoints, validSlug } from "../../src/boardFormat.ts";

test("points pack to 0.1 unit and 0.01 pressure, and unpack to triples", () => {
  const pts = [
    { x: 10.04, y: 20.06, p: 0.123 },
    { x: 11.55, y: 21, p: 1.7 },
    { x: -3.21, y: 0, p: -1 },
  ];
  const packed = packPoints(pts);
  assert.deepEqual(packed, [10, 20.1, 0.12, 11.6, 21, 1, -3.2, 0, 0]);
  assert.deepEqual(unpackPoints(packed), [
    [10, 20.1, 0.12],
    [11.6, 21, 1],
    [-3.2, 0, 0],
  ]);
});

test("a board round-trips through its file", () => {
  const b = blankBoard("Lecture 3", 1000);
  const random = (n: number) => Array.from({ length: n }, (_, i) => ({ x: Math.random() * 1000, y: Math.random() * 1294, p: Math.random() + i * 0 }));
  b.pages[0]!.strokes.push({ id: "s1", tool: "pen", color: "#1f1f24", w: 2.2, pts: packPoints(random(200)) });
  b.pages[0]!.strokes.push({ id: "s2", tool: "hl", color: "#ffd21f", w: 18, pts: packPoints(random(2)) });
  b.pages.push({ strokes: [] });
  b.pages.push({ strokes: [{ id: "dot", tool: "pen", color: "#d23a2c", w: 4.6, pts: packPoints(random(1)) }] });
  const text = serializeBoard(b);
  // One stroke per line: small diffs.
  assert.equal(text.split("\n").filter((l) => l.startsWith('{"id"')).length, 3);
  const back = parseBoard(text);
  assert.deepEqual(back, b);
  // And again: stable bytes.
  assert.equal(serializeBoard(back), text);
  assert.deepEqual(JSON.parse(text), b);
});

test("parse refuses what is not a board", () => {
  assert.throws(() => parseBoard({ pages: [] }), /pages/);
  assert.throws(() => parseBoard({ pages: [{ strokes: [{ id: "a", tool: "brush", color: "#000", w: 1, pts: [] }] }] }), /tool/);
  assert.throws(() => parseBoard({ pages: [{ strokes: [{ id: "a", tool: "pen", color: "#000", w: 1, pts: [1, 2, "3"] }] }] }), /points/);
  assert.throws(() => parseBoard("not json"));
  // Missing fields get defaults; items are kept for later milestones.
  const b = parseBoard({ pages: [{ strokes: [] }], items: [{ id: "i1", kind: "text", page: 1 }] });
  assert.equal(b.name, "Untitled board");
  assert.equal(b.items.length, 1);
});

test("slugs", () => {
  assert.equal(slugify("Lecture 3: Fourier"), "lecture-3-fourier");
  assert.equal(slugify("Économie — été"), "economie-ete");
  assert.equal(slugify("!!!"), "board");
  assert.ok(validSlug(slugify("x".repeat(200))));
  for (const bad of ["..", "a/b", "A", "-a", "", "a".repeat(65), "a\\b"]) assert.equal(validSlug(bad), false, bad);
});
