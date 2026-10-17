// The whiteboard's palm rejection (board/src/palm.ts), driven by the scripted
// traces in board/src/palmTraces.ts: no palm case may ink with a touch, pan,
// zoom or undo; the deliberate gestures must still work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Arbiter } from "../../board/src/palm.ts";
import { PALM_CASES, TRACES, Trace, line, simulate, writing } from "../../board/src/palmTraces.ts";

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

test("a right-hand pinch on the right works soon after writing; the same on the hand side is a palm", () => {
  const ok = simulate(TRACES.pinchAfterWriting!());
  assert.equal(ok.viewStarts, 1);
  assert.ok(ok.cam.z > 1.2);
  const palm = simulate(TRACES.handSidePinch!());
  assert.equal(palm.viewStarts, 0);
  // A right-handed writer's hand side is the other side: the same contacts are fingers.
  const rh = simulate(TRACES.handSidePinch!(), { hand: "right" });
  assert.equal(rh.viewStarts, 1);
});

test("touch never draws once a pen was seen; before that one finger draws and two pinch", () => {
  const tr = new Trace("finger", "nothing").touch(1, line([300, 300], [500, 300], 20), 0, 16, 30);
  assert.equal(simulate(tr).inkBy.touch, 0);
  assert.ok(simulate(tr, { penSeen: false }).inkBy.touch > 10);
  const r = simulate(TRACES.pinch!(), { penSeen: false });
  assert.ok(r.actions.some((a) => a.a === "tool-cancel"));
  assert.ok(r.cam.z > 1.5);
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

test("the toolbar takes a finger tap, not a palm, nor anything while the pen writes", () => {
  const arb = new Arbiter({ hand: "left", pan1: false, penSeen: true });
  const tap = { type: "down" as const, id: 5, kind: "touch" as const, x: 400, y: 30, w: 30, h: 30, t: 0 };
  assert.equal(arb.toolbarTouch(tap), true);
  assert.equal(arb.toolbarTouch({ ...tap, w: 90, h: 90 }), false);
  arb.handle({ type: "down", id: 1, kind: "pen", x: 600, y: 400, t: 10, buttons: 1 });
  assert.equal(arb.toolbarTouch({ ...tap, t: 20 }), false);
  arb.handle({ type: "up", id: 1, kind: "pen", x: 600, y: 400, t: 30 });
  assert.equal(arb.toolbarTouch({ ...tap, t: 40 }), true);
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
