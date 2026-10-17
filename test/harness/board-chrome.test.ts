// The whiteboard's chrome taps (board/src/chrome.ts) after the pen has written: every control —
// toolbar, popover items, the ⋯ menu, the inbox and its sheet, the selection pill, the mic and the voice pill — presses exactly
// once for a Pencil tap and a finger tap, with or without the click iOS may synthesise after it,
// with a pen hover going on, and even with a pen contact the board never saw lift. The canvas
// pointers still go to the palm arbiter (board-palm.test.ts holds it to its rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Arbiter, type Action, type PEvent } from "../../board/src/palm.ts";
import { ChromeTaps, routeChrome } from "../../board/src/chrome.ts";

type Btn = { name: string; x: number; y: number };
// A 1180×820 board: the bars along the top, a popover under the size button, the menu, the inbox sheet, the pill.
const CONTROLS: Btn[] = [
  ...["back", "pen", "hl", "eraser", "lasso", "size", "colour", "undo", "redo", "voice", "inbox", "menu"].map((name, i) => ({ name, x: 40 + i * 90, y: 34 })),
  ...["size-1", "size-2", "size-3", "colour-red", "colour-blue"].map((name, i) => ({ name, x: 480 + i * 50, y: 120 })),
  ...["insert", "grid-dots", "hand-right", "scroll-on"].map((name, i) => ({ name, x: 1000, y: 120 + i * 50 })),
  ...["inbox-entry", "inbox-add-all", "inbox-back"].map((name, i) => ({ name, x: 800, y: 300 + i * 60 })),
  { name: "pill-delete", x: 600, y: 600 },
  // The voice pill under the top-right controls (voicePill.ts: its own ChromeTaps, the same rule) and its chat list.
  ...["voice-chats", "voice-mute", "voice-end", "voice-chat-row", "voice-dismiss"].map((name, i) => ({ name, x: 60 + i * 70, y: 480 })),
];
const hit = (x: number, y: number) => CONTROLS.find((b) => Math.abs(b.x - x) < 22 && Math.abs(b.y - y) < 22) ?? null;

/** view.ts in miniature: chrome first, the canvas's pointers to the arbiter; a native click deduped against the pointerup. */
function board() {
  const presses = new Map<string, number>();
  const press = (b: Btn) => presses.set(b.name, (presses.get(b.name) ?? 0) + 1);
  const chrome = new ChromeTaps<Btn>(press);
  const arb = new Arbiter({ hand: "right", pan1: false, penSeen: true });
  const actions: Action[] = [];
  let t = 0;
  const ev = (type: PEvent["type"], id: number, kind: PEvent["kind"], x: number, y: number, extra: Partial<PEvent> = {}) => {
    t += 8;
    const e: PEvent = { type, id, kind, x, y, t, w: kind === "touch" ? 30 : 0, h: kind === "touch" ? 30 : 0, buttons: type === "down" || type === "move" ? 1 : 0, ...extra };
    const onCanvas = !hit(x, y);
    if (routeChrome(chrome, { type, id, x, y, t }, onCanvas, () => hit(x, y))) return;
    actions.push(...arb.handle(e));
  };
  /** A native click landing on `b` (or on something with no press of its own, e.g. a scrim: `onScrim`). */
  let scrimCloses = 0;
  const click = (b: Btn | null) => {
    t += 4;
    if (!chrome.click(t)) return;
    if (b) press(b);
    else scrimCloses++;
  };
  const stroke = (id = 2) => {
    ev("down", id, "pen", 300, 400);
    for (let k = 1; k <= 20; k++) ev("move", id, "pen", 300 + k * 10, 400 + Math.sin(k) * 20);
    ev("up", id, "pen", 500, 400);
  };
  const hover = (id = 2) => ev("move", id, "pen", 520 + (t % 30), 420, { buttons: 0 });
  /** A tap as iOS sends it: pointerdown → pointerup → (click, when it synthesises one). */
  const tap = (b: Btn, kind: "pen" | "touch", id: number, withClick: boolean) => {
    ev("down", id, kind, b.x, b.y);
    ev("up", id, kind, b.x + 1, b.y + 1);
    if (withClick) click(b);
  };
  return { presses, actions, ev, stroke, hover, tap, click, arb, advance: (ms: number) => (t += ms), scrimCloses: () => scrimCloses };
}

for (const kind of ["pen", "touch"] as const) {
  for (const withClick of [true, false]) {
    test(`after a pen stroke, a ${kind === "pen" ? "Pencil" : "finger"} tap presses every control once (${withClick ? "with" : "without"} a synthesised click)`, () => {
      const b = board();
      b.stroke();
      let id = 10;
      for (const c of CONTROLS) {
        b.hover();
        b.tap(c, kind, kind === "pen" ? 2 : id++, withClick);
        b.stroke();
        assert.equal(b.presses.get(c.name), 1, `${c.name}: pressed ${b.presses.get(c.name) ?? 0} times`);
      }
      // The canvas still inks with the pen between the taps.
      assert.ok(b.actions.filter((a) => a.a === "tool-start").length > CONTROLS.length);
    });
  }
}

test("a finger tap on the toolbar presses while the pen hovers, and right after it lifts (inside the palm lockout)", () => {
  const b = board();
  b.stroke();
  for (let k = 0; k < 5; k++) b.hover();
  const pen = CONTROLS.find((c) => c.name === "size")!;
  b.tap(pen, "touch", 40, true);
  assert.equal(b.presses.get("size"), 1);
  b.stroke();
  b.tap(CONTROLS.find((c) => c.name === "menu")!, "touch", 41, true);
  assert.equal(b.presses.get("menu"), 1);
});

test("a pen contact the board never saw lift does not lock the chrome", () => {
  const b = board();
  b.ev("down", 2, "pen", 300, 400);
  b.ev("move", 2, "pen", 320, 410);
  // (no pen up)
  b.tap(CONTROLS.find((c) => c.name === "undo")!, "touch", 50, true);
  b.tap(CONTROLS.find((c) => c.name === "eraser")!, "pen", 2, false);
  assert.equal(b.presses.get("undo"), 1);
  assert.equal(b.presses.get("eraser"), 1);
});

test("a click with no pointer before it (keyboard, element.click()) presses once; a click long after a tap is its own", () => {
  const b = board();
  const redo = CONTROLS.find((c) => c.name === "redo")!;
  b.click(redo);
  assert.equal(b.presses.get("redo"), 1);
  b.tap(redo, "touch", 60, false);
  b.advance(2000);
  b.click(redo);
  assert.equal(b.presses.get("redo"), 3);
});

test("the click after a tap that opened the inbox lands on its scrim and is dropped (the sheet stays open)", () => {
  const b = board();
  b.stroke();
  const inbox = CONTROLS.find((c) => c.name === "inbox")!;
  b.ev("down", 80, "touch", inbox.x, inbox.y);
  b.ev("up", 80, "touch", inbox.x, inbox.y);
  b.click(null); // iOS hit-tests the click after the press: the scrim is under the finger now
  assert.equal(b.presses.get("inbox"), 1);
  assert.equal(b.scrimCloses(), 0);
  b.advance(1000);
  b.click(null); // a later tap on the scrim closes it, as before
  assert.equal(b.scrimCloses(), 1);
});

test("no press: lifting off the button, a drag (a scroll), a cancelled pointer", () => {
  const b = board();
  const inbox = CONTROLS.find((c) => c.name === "inbox-add-all")!;
  b.ev("down", 70, "touch", inbox.x, inbox.y);
  b.ev("up", 70, "touch", inbox.x + 200, inbox.y);
  b.ev("down", 71, "touch", inbox.x, inbox.y);
  b.ev("move", 71, "touch", inbox.x, inbox.y + 6);
  b.ev("up", 71, "touch", inbox.x + 15, inbox.y + 15);
  b.ev("down", 72, "touch", inbox.x, inbox.y);
  b.ev("cancel", 72, "touch", inbox.x, inbox.y);
  assert.equal(b.presses.get("inbox-add-all") ?? 0, 0);
});

test("chrome pointers never reach the arbiter; a canvas down with a reused id is the canvas's", () => {
  const b = board();
  const n = b.actions.length;
  b.tap(CONTROLS.find((c) => c.name === "lasso")!, "pen", 2, true);
  assert.equal(b.actions.length, n);
  // The mouse keeps one id: a press on the toolbar whose up was lost, then a down on the canvas draws.
  b.ev("down", 1, "mouse", CONTROLS[1]!.x, CONTROLS[1]!.y, { button: 0 });
  b.ev("down", 1, "mouse", 600, 500, { button: 0 });
  assert.equal(b.actions.at(-1)?.a, "tool-start");
});
