// The voice's waiting line (src/voiceWaitLine.ts): one thin line under the voice bars while the voice waits on work.
// Carl: "wait until the bar is complete for the voice to talk back to me" — so it never lies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPLETE_HOLD_MS, LONG_MS, WaitTracker, calibFrom, expectedMs, waitView } from "../../src/voiceWaitLine.ts";

const T0 = 1_000_000;

test("nothing running: no line", () => {
  assert.equal(waitView({ works: [], calib: {}, now: T0 }), null);
});

test("a quick read is short, a Delegate worker is long, by default", () => {
  assert.deepEqual(waitView({ works: [{ key: "t", kind: "turn", startedAt: T0 }], calib: {}, now: T0 + 500 }), { frac: null, pace: "short" });
  assert.deepEqual(waitView({ works: [{ key: "d", kind: "Delegate", startedAt: T0 }], calib: {}, now: T0 + 500 }), { frac: null, pace: "long" });
});

test("the agent's word decides, unless history says that kind of work is systematically long", () => {
  const w = { key: "d", kind: "Delegate", startedAt: T0, expect: "short" as const };
  assert.equal(waitView({ works: [w], calib: {}, now: T0 + 1000 })!.pace, "short");
  const calib = calibFrom({ Delegate: [70_000, 80_000, 90_000, 65_000, 75_000] });
  assert.equal(waitView({ works: [w], calib, now: T0 + 1000 })!.pace, "long");
  assert.ok(expectedMs(w, calib) >= LONG_MS);
});

test("calibration: a kind that usually takes seconds is short without a word from the agent", () => {
  const calib = calibFrom({ Delegate: [6_000, 7_000, 9_000, 8_000] });
  assert.equal(waitView({ works: [{ key: "d", kind: "Delegate", startedAt: T0 }], calib, now: T0 + 1000 })!.pace, "short");
});

test("overrun: short work that runs past its expectation turns long (never stuck at 99%)", () => {
  const w = { key: "t", kind: "turn", startedAt: T0 };
  assert.equal(waitView({ works: [w], calib: {}, now: T0 + 7_000 })!.pace, "short");
  assert.equal(waitView({ works: [w], calib: {}, now: T0 + 9_000 })!.pace, "long");
});

test("determinate only with real steps; all steps done but still working is indeterminate, not 100%", () => {
  const works = [{ key: "t", kind: "turn", startedAt: T0 }];
  assert.equal(waitView({ works, plan: { done: 1, total: 4 }, calib: {}, now: T0 })!.frac, 0.25);
  assert.equal(waitView({ works, plan: { done: 4, total: 4 }, calib: {}, now: T0 })!.frac, null);
  assert.equal(waitView({ works, plan: { done: 0, total: 0 }, calib: {}, now: T0 })!.frac, null);
});

test("several jobs are one line: long if any is long", () => {
  const v = waitView({ works: [{ key: "t", kind: "turn", startedAt: T0 }, { key: "d", kind: "Delegate", startedAt: T0 }], calib: {}, now: T0 + 100 });
  assert.deepEqual(v, { frac: null, pace: "long" });
});

test("lifecycle: running → complete (held) → gone when the voice speaks", () => {
  const tr = new WaitTracker();
  const works = [{ key: "d", kind: "Delegate", startedAt: T0 }];
  assert.deepEqual(tr.update({ works, calib: {}, now: T0 + 100, speaking: false }), { frac: null, pace: "long" });
  // The work ends: the line completes and stays complete while the result is on its way (he may be talking).
  assert.deepEqual(tr.update({ works: [], calib: {}, now: T0 + 5_000, speaking: false }), { frac: 1, pace: "long" });
  assert.deepEqual(tr.update({ works: [], calib: {}, now: T0 + 15_000, speaking: false }), { frac: 1, pace: "long" });
  // The voice talks back: the line goes.
  assert.equal(tr.update({ works: [], calib: {}, now: T0 + 16_000, speaking: true }), null);
  assert.equal(tr.update({ works: [], calib: {}, now: T0 + 17_000, speaking: false }), null);
});

test("a completed line that no speech follows goes after the hold (never a stale done)", () => {
  const tr = new WaitTracker();
  tr.update({ works: [{ key: "t", kind: "turn", startedAt: T0 }], calib: {}, now: T0, speaking: false });
  assert.equal(tr.update({ works: [], calib: {}, now: T0 + 1000, speaking: false })!.frac, 1);
  assert.equal(tr.update({ works: [], calib: {}, now: T0 + 1000 + COMPLETE_HOLD_MS, speaking: false }), null);
});

test("no line before any work: him talking and the voice answering at once never show it", () => {
  const tr = new WaitTracker();
  assert.equal(tr.update({ works: [], calib: {}, now: T0, speaking: false }), null);
  assert.equal(tr.update({ works: [], calib: {}, now: T0 + 2000, speaking: true }), null);
});
