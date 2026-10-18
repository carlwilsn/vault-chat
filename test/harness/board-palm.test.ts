// The whiteboard's palm rejection (board/src/palm.ts), driven by the scripted
// traces in board/src/palmTraces.ts: no palm case may ink with a touch, pan,
// zoom or undo; the deliberate gestures must still work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Arbiter } from "../../board/src/palm.ts";
import { PALM_CASES, TRACES, Trace, line, rest, simulate, writing } from "../../board/src/palmTraces.ts";

const still = (r: ReturnType<typeof simulate>) => r.cam.x === 0 && r.cam.y === 0 && r.cam.z === 1;

for (const name of PALM_CASES) {
  for (const pan1 of [false, true]) {
    test(`palm: ${TRACES[name]!().name}${pan1 ? " (one-finger scroll on)" : ""}`, () => {
      const tr = TRACES[name]!();
      const r = simulate(tr, { pan1 });
      assert.equal(r.inkBy.touch, 0, "a touch inked");
      assert.equal(r.undos, 0, "undo fired");
      assert.ok(still(r), `the camera moved: ${JSON.stringify(r.cam)}`);
      // Strict: nothing even started to move, except the one documented hard case
      // (finger-sized palm contacts that settle before the pen lands: started, then undone by the pen).
      if (name !== "palmBeforePenSmall") assert.equal(r.viewStarts, 0, "a view gesture started");
      else assert.ok(r.actions.some((a) => a.a === "view-abort") || r.viewStarts === 0);
      if (tr.expect === "ink-only") assert.ok(r.inkBy.pen > 10, "the pen did not write");
    });
  }
}

test("a deliberate two-finger pinch zooms", () => {
  const r = simulate(TRACES.pinch!());
  assert.equal(r.viewStarts, 1);
  assert.ok(r.cam.z > 1.5, `zoom ${r.cam.z}`);
  assert.equal(r.undos, 0);
});

test("a two-finger pan pans without zooming", () => {
  const r = simulate(TRACES.twoFingerPan!());
  assert.equal(r.viewStarts, 1);
  assert.equal(r.cam.z, 1);
  assert.ok(r.cam.y > 220 && Math.abs(r.cam.x) < 2, `pan ${JSON.stringify(r.cam)}`);
  assert.ok(r.actions.some((a) => a.a === "view-end"));
});

test("a two-finger tap undoes once; not within a second of the pen", () => {
  assert.equal(simulate(TRACES.undoTap!()).undos, 1);
  const r = simulate(TRACES.undoTapAfterPen!());
  assert.equal(r.undos, 0);
  assert.equal(r.viewStarts, 0);
});

test("a pinch soon after writing works on either side of the pen (the hand side stops one finger only)", () => {
  const ok = simulate(TRACES.pinchAfterWriting!());
  assert.equal(ok.viewStarts, 1);
  assert.ok(ok.cam.z > 1.2);
  for (const hand of ["left", "right"] as const) {
    const r = simulate(TRACES.handSidePinch!(), { hand });
    assert.equal(r.viewStarts, 1, hand);
  }
  // One finger on the hand side right after writing is still a palm, even with one-finger scroll on.
  const one = new Trace("one finger, hand side", "nothing").pen(writing([600, 380], 40), 0).touch(1, line([520, 520], [420, 600], 20), 1220, 12, 40);
  assert.equal(simulate(one, { pan1: true }).viewStarts, 0);
});

// iPadOS reports a contact as twice UITouch.majorRadius, in steps of ~20.9 px: 41.75, 62.6, 83.5 for fingers and
// thumbs, 104+ for a palm. Carl (2026-10-18): "I can't pan and zoom with my fingers" — 62.6 and 83.5 were palms at 56.
test("real iPad finger sizes pan and pinch: 62.6 px fingertips, an 83.5 px thumb, a contact that grows as it presses", () => {
  const pan = new Trace("fingertips 62.6", "pan").touch(21, line([700, 300], [700, 560], 30), 0, 12, 62.6).touch(22, line([800, 310], [800, 570], 30), 25, 12, 62.6);
  const r1 = simulate(pan);
  assert.equal(r1.viewStarts, 1);
  assert.ok(r1.cam.y > 220, JSON.stringify(r1.cam));
  const pinch = new Trace("thumb + index", "pinch").touch(21, line([800, 400], [680, 460], 25), 0, 12, 83.5).touch(22, line([880, 380], [1000, 320], 25), 30, 12, 41.75);
  assert.ok(simulate(pinch).cam.z > 1.8);
  const grow = new Trace("pressing harder", "pinch").touch(21, line([700, 400], [780, 400], 25), 0, 12, (i) => 41.75 + i * 1.7).touch(22, line([950, 400], [870, 400], 25), 20, 12, (i) => 41.75 + i * 1.7);
  const r3 = simulate(grow);
  assert.ok(!r3.actions.some((a) => a.a === "view-abort"), "a growing contact undid the pinch");
  assert.ok(r3.cam.z < 0.5, JSON.stringify(r3.cam));
  // A palm-sized contact is still a palm.
  assert.equal(simulate(new Trace("palm", "nothing").touch(21, line([700, 300], [700, 560], 30), 0, 12, 104.4), { pan1: true }).viewStarts, 0);
});

test("two fingers pan while the pen hovers and right after it lifts; never while it touches", () => {
  const hover = new Trace("hover + pan", "pan").hover(line([300, 300], [320, 300], 30), 0).touch(21, line([700, 300], [700, 500], 25), 40, 12, 41.75).touch(22, line([800, 300], [800, 500], 25), 60, 12, 41.75);
  const r1 = simulate(hover);
  assert.equal(r1.viewStarts, 1);
  assert.ok(r1.cam.y > 150, JSON.stringify(r1.cam));
  const after = new Trace("pan 150 ms after the pen", "pan").pen(writing([600, 380], 20), 0).touch(21, line([500, 500], [500, 700], 25), 310, 12, 41.75).touch(22, line([600, 500], [600, 700], 25), 330, 12, 41.75);
  assert.ok(simulate(after).cam.y > 150);
  const writingNow = new Trace("pan while writing", "nothing").pen(writing([300, 600], 80), 0).touch(21, line([700, 300], [700, 500], 25), 100, 12, 41.75).touch(22, line([800, 300], [800, 500], 25), 120, 12, 41.75);
  const r3 = simulate(writingNow);
  assert.equal(r3.viewStarts, 0);
  assert.ok(still(r3));
});

test("a second finger up to 280 ms after the first makes a pair; later it is a palm", () => {
  const ok = new Trace("late-ish", "pan").touch(21, [[700, 300], ...line([700, 300], [700, 500], 25)], 0, 12, 41.75).touch(22, line([800, 300], [800, 500], 24), 250, 12, 41.75);
  assert.equal(simulate(ok).viewStarts, 1);
  const late = new Trace("too late", "nothing").touch(21, [...rest([700, 300], 40, 1), ...line([700, 300], [700, 500], 25)], 0, 12, 41.75).touch(22, line([800, 300], [800, 500], 24), 400, 12, 41.75);
  assert.equal(simulate(late).viewStarts, 0);
});

test("the arbiter counts what the fingers did, and each palm by its reason (the board's log)", () => {
  const arb = new Arbiter({ hand: "left", pan1: true, penSeen: true });
  const feed = (tr: Trace) => tr.sorted().forEach((e) => arb.handle(e));
  feed(TRACES.pinch!());
  feed(TRACES.twoFingerPan!());
  feed(new Trace("palm", "nothing").touch(31, line([100, 100], [200, 200], 10), 5000, 12, 120));
  feed(new Trace("pan while writing", "nothing").pen(writing([300, 600], 80), 6000).touch(41, line([700, 300], [700, 500], 25), 6100, 12, 41.75));
  const st = arb.takeStats();
  assert.equal(st.pan, 2);
  assert.equal(st.pinch, 1);
  assert.equal(st.palm.size, 1);
  assert.equal(st.palm["pen-down"], 1);
  assert.equal(st.maxSize, 120);
  assert.deepEqual(arb.takeStats().palm, {});
});

test("touch never draws once a pen was seen; before that one finger draws and two pinch", () => {
  const tr = new Trace("finger", "nothing").touch(1, line([300, 300], [500, 300], 20), 0, 16, 30);
  assert.equal(simulate(tr).inkBy.touch, 0);
  assert.ok(simulate(tr, { penSeen: false }).inkBy.touch > 10);
  const r = simulate(TRACES.pinch!(), { penSeen: false });
  assert.ok(r.actions.some((a) => a.a === "tool-cancel"));
  assert.ok(r.cam.z > 1.5);
  // With one-finger scroll on (the default), one finger pans before a Pencil is seen too.
  const pan = simulate(new Trace("finger", "pan").touch(1, line([300, 300], [300, 500], 20), 0, 16, 41.75), { penSeen: false, pan1: true });
  assert.equal(pan.inkBy.touch, 0);
  assert.equal(pan.viewStarts, 1);
  // The pen arriving (even hovering) marks it seen.
  const arb = new Arbiter({ hand: "left", pan1: false, penSeen: false });
  assert.deepEqual(arb.handle({ type: "move", id: 1, kind: "pen", x: 1, y: 1, t: 0, buttons: 0 }), [{ a: "pen-seen" }]);
  assert.equal(arb.settings.penSeen, true);
});

test("one-finger scroll (the option) pans with a finger that moves at once", () => {
  const tr = new Trace("one finger", "pan").touch(1, line([600, 600], [600, 300], 25), 0, 12, 30);
  assert.equal(simulate(tr).viewStarts, 0);
  const r = simulate(tr, { pan1: true });
  assert.equal(r.viewStarts, 1);
  assert.ok(Math.abs(r.cam.y + 300) < 2);
  // Not during the lockout after the pen.
  const after = new Trace("one finger after pen", "nothing").pen(writing([600, 300], 20), 0).touch(1, line([900, 600], [900, 300], 25), 300, 12, 30);
  assert.equal(simulate(after, { pan1: true }).viewStarts, 0);
});

test("the pen landing during a finger pan ends it; a young one is undone", () => {
  const tr = new Trace("pan then pen", "nothing")
    .touch(21, line([700, 300], [700, 400], 10), 0, 12, 30)
    .touch(22, line([790, 310], [790, 410], 10), 20, 12, 30)
    .pen(writing([300, 300], 10), 100);
  const r = simulate(tr);
  assert.equal(r.viewStarts, 1);
  assert.ok(r.actions.some((a) => a.a === "view-abort"));
  assert.ok(still(r));
});
