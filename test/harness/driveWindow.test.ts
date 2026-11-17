// The agent's Drive window must never be seen. On 2026-11-17 (v0.9.38) a Timing run right after the laptop updated put
// it on Carl's screen as a second full app window ("vault-chat (agent check)"), with no close of its own, kept alive
// after he closed his main window. Cause: it was created `visible: true` at x/y -30000, and Windows (tao) drops a
// creation position that is on no monitor and uses the default spot on screen. These checks run src/driveHost.ts's
// placement against a window that behaves like tao's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DRIVE_WINDOW_OPTIONS, offScreenSpot, onAnyMonitor, placeOffScreen, type ScreenRect } from "../../src/driveHost.ts";

const MONITORS: ScreenRect[] = [
  { x: 0, y: 0, width: 2560, height: 1440 },
  { x: -1920, y: 200, width: 1920, height: 1080 },
];

/** A native window as tao makes it on Windows: a creation position on no monitor becomes CW_USEDEFAULT (on screen);
 * set_outer_position (SetWindowPos) is not clamped. Records whether it was ever visible while on a monitor. */
function taoWindow(opts: { x?: number; y?: number; visible: boolean; width: number; height: number }, monitors: ScreenRect[], stuck = false) {
  const size = { width: opts.width, height: opts.height };
  const asked = opts.x !== undefined && opts.y !== undefined ? { x: opts.x, y: opts.y } : null;
  let pos = asked && monitors.some((m) => asked.x >= m.x && asked.x <= m.x + m.width && asked.y >= m.y && asked.y <= m.y + m.height) ? asked : { x: 26, y: 26 };
  let visible = opts.visible;
  let seenOnScreen = false;
  const check = () => {
    if (visible && onAnyMonitor({ ...pos, ...size }, monitors)) seenOnScreen = true;
  };
  check();
  return {
    win: {
      setPosition: async (x: number, y: number) => {
        if (!stuck) pos = { x, y };
        check();
      },
      outerPosition: async () => ({ ...pos }),
      outerSize: async () => ({ ...size }),
      show: async () => {
        visible = true;
        check();
      },
    },
    seen: () => seenOnScreen,
    visible: () => visible,
  };
}

test("the old way (visible at x/y -30000) lands on Carl's screen under tao's rule", () => {
  const w = taoWindow({ x: -30000, y: -30000, visible: true, width: 1400, height: 900 }, MONITORS);
  assert.equal(w.seen(), true);
});

test("the Drive window is created hidden, with no creation position", () => {
  assert.equal(DRIVE_WINDOW_OPTIONS.visible, false);
  assert.equal(DRIVE_WINDOW_OPTIONS.focus, false);
  assert.equal("x" in DRIVE_WINDOW_OPTIONS || "y" in DRIVE_WINDOW_OPTIONS, false);
});

test("placed off every monitor, then shown: never seen", async () => {
  const w = taoWindow({ visible: DRIVE_WINDOW_OPTIONS.visible, width: 1400, height: 900 }, MONITORS);
  assert.equal(await placeOffScreen(w.win, MONITORS), null);
  assert.equal(w.visible(), true, "shown (WebView2 keeps rendering it)");
  assert.equal(w.seen(), false);
});

test("a window that cannot be moved off the screen is never shown", async () => {
  const w = taoWindow({ visible: false, width: 1400, height: 900 }, MONITORS, true);
  const why = await placeOffScreen(w.win, MONITORS);
  assert.match(why ?? "", /could not be moved off the screen/);
  assert.equal(w.visible(), false);
  assert.equal(w.seen(), false);
});

test("the off-screen spot clears monitors far up and left", () => {
  const far: ScreenRect[] = [{ x: -40000, y: -35000, width: 3840, height: 2160 }, ...MONITORS];
  const spot = offScreenSpot({ width: 1400, height: 900 }, far);
  assert.equal(onAnyMonitor({ ...spot, width: 1400, height: 900 }, far), false);
});
