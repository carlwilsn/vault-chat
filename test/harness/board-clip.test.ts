// The board's clipboard (board/src/clip.ts) and the one-finger long-press the select tool's Paste uses
// (board/src/palm.ts Arbiter.hold): a clip keeps the selection's layout and style and lands centred where asked with
// new ids; its files are copied only across boards; a palm, a moving finger, a pair or a pen nearby never holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clipAssets, itemAssets, loadClip, makeClip, placeClip, saveClip } from "../../board/src/clip.ts";
import { Arbiter, P, type PEvent } from "../../board/src/palm.ts";
import type { Item, Stroke } from "../../src/boardFormat.ts";

const stroke: Stroke = { id: "s1", tool: "pen", color: "#012f7b", w: 1.4, xy: [0, 0, 10, 0, 10, 10], style: "dash" };
const hl: Stroke = { id: "s2", tool: "hl", color: "#ffd60a", w: 18, xy: [0, 20, 40, 20] };
const pdf = { id: "i1", kind: "pdf", x: 20, y: 0, w: 40, h: 50, src: "assets/a.pdf", snap: "assets/a-1.png", page: 1, label: "p. 1", inbox: { id: "e", part: 0 } } as Item;
const box = { x0: -1, y0: -1, x1: 61, y1: 51 };

test("a clip keeps the selection's layout and style, and pastes centred where asked, with new ids", () => {
  const c = makeClip("games", [stroke, hl], [pdf], box, 1);
  stroke.xy[0] = 99; // the board changes after the copy: the clip does not
  stroke.xy[0] = 0;
  let n = 0;
  const { strokes, items } = placeClip(c, { x: 1000, y: 500 }, () => `n${++n}`);
  // The box's centre (30, 25) lands on (1000, 500): everything moves by (970, 475).
  assert.deepEqual(strokes[0]!.xy, [970, 475, 980, 475, 980, 485]);
  assert.equal(strokes[0]!.style, "dash");
  assert.equal(strokes[0]!.color, "#012f7b");
  assert.equal(strokes[0]!.w, 1.4);
  assert.equal(strokes[1]!.tool, "hl");
  assert.deepEqual([items[0]!.x, items[0]!.y, items[0]!.w, items[0]!.h], [990, 475, 40, 50]);
  assert.equal(items[0]!.snap, "assets/a-1.png");
  assert.equal(items[0]!.label, "p. 1");
  assert.equal(items[0]!.inbox, undefined, "a copy is not the inbox's part");
  assert.deepEqual([strokes[0]!.id, strokes[1]!.id, items[0]!.id], ["n1", "n2", "n3"]);
  // Pasting twice makes two copies.
  const again = placeClip(c, { x: 0, y: 0 }, () => `m${++n}`);
  assert.notEqual(again.strokes[0]!.id, strokes[0]!.id);
});

test("the files to copy: only across boards, each once", () => {
  assert.deepEqual(itemAssets(pdf).sort(), ["assets/a-1.png", "assets/a.pdf"]);
  const c = makeClip("games", [stroke], [pdf, { ...pdf, id: "i2", page: 2 }], box);
  assert.deepEqual(clipAssets(c, "games"), []);
  assert.deepEqual(clipAssets(c, "other").sort(), ["assets/a-1.png", "assets/a.pdf"]);
});

test("the clip is kept in localStorage (any board on the device), and a broken one is no clip", () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(loadClip(), null);
  assert.ok(saveClip(makeClip("games", [stroke], [], box)));
  assert.equal(loadClip()!.strokes[0]!.id, "s1");
  store.set("vc_board_clip", "{nope");
  assert.equal(loadClip(), null);
  delete (globalThis as any).localStorage;
});

const touch = (type: PEvent["type"], id: number, x: number, y: number, t: number, w = 42): PEvent => ({ type, id, kind: "touch", x, y, w, h: w, t });
const pen = (type: PEvent["type"], x: number, y: number, t: number, buttons = 1): PEvent => ({ type, id: 900, kind: "pen", x, y, t, buttons });

test("one still finger holds; then lifting or moving it does nothing more", () => {
  const a = new Arbiter({ hand: "right", pan1: true, penSeen: true });
  a.handle(touch("down", 1, 300, 300, 0));
  a.handle(touch("move", 1, 302, 301, 200));
  assert.ok(a.hold(1, 520));
  assert.deepEqual(a.handle(touch("move", 1, 400, 400, 600)), [], "no pan after the hold");
  assert.deepEqual(a.handle(touch("up", 1, 400, 400, 700)), []);
});

test("never a hold: a palm, a finger that moved, a pair, the pen near, the writing hand's side", () => {
  const big = new Arbiter({ hand: "right", pan1: true, penSeen: true });
  big.handle(touch("down", 1, 300, 300, 0, P.PALM_MIN + 10));
  assert.equal(big.hold(1, 520), false, "palm-sized");

  const moved = new Arbiter({ hand: "right", pan1: true, penSeen: true });
  moved.handle(touch("down", 1, 300, 300, 0));
  moved.handle(touch("move", 1, 330, 300, 100));
  assert.equal(moved.hold(1, 520), false, "moved");

  const pair = new Arbiter({ hand: "right", pan1: true, penSeen: true });
  pair.handle(touch("down", 1, 300, 300, 0));
  pair.handle(touch("down", 2, 400, 300, 50));
  assert.equal(pair.hold(1, 520), false, "two fingers");

  const writing = new Arbiter({ hand: "right", pan1: true, penSeen: true });
  writing.handle(pen("down", 500, 300, 0));
  writing.handle(touch("down", 1, 100, 300, 10));
  assert.equal(writing.hold(1, 520), false, "the pen is down");

  const side = new Arbiter({ hand: "right", pan1: true, penSeen: true });
  side.handle(pen("down", 300, 300, 0));
  side.handle(pen("up", 300, 300, 100, 0));
  side.handle(touch("down", 1, 420, 380, 1000)); // right of and below the tip, after the lock: the hand
  assert.equal(side.hold(1, 1520), false, "the writing hand's side");
});
