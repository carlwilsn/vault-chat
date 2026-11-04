// Focused source-runtime regressions, NOT real-UI acceptance. Execute the actual small
// browser closures from boot.ts; the real production phone check covers browser layout/input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
const boot = readFileSync(process.env.VC_PHONE_SCROLL_SOURCE || new URL("../../phone/src/boot.ts", import.meta.url), "utf8");
function scrolling() {
  const listeners: Record<string, (e?: any) => void> = {};
  const el = { scrollTop: 600, scrollHeight: 1000, clientHeight: 400, children: [], addEventListener: (n: string, fn: any) => { listeners[n] = fn; } };
  let resize!: () => void;
  const code = boot.slice(boot.indexOf("  const atBottom ="), boot.indexOf("\n  let streamEl ="));
  const api = runInNewContext(transformSync(code, { loader: "ts" }).code + "\n({ scrollDown, atBottom })", { msgsEl: el, page: "chat", document: { addEventListener: (n: string, fn: any) => { listeners[n] = fn; } }, ResizeObserver: class { constructor(fn: () => void) { resize = fn; } observe() {} disconnect() {} } });
  return { el, listeners, resize: () => resize(), ...api };
}
test("phone: a pre-update false never rechecks a shortened DOM and jumps", () => {
  const s = scrolling(); s.el.scrollTop = 500;
  const before = s.atBottom(); assert.equal(before, false);
  s.el.scrollHeight = 920; // replacing the streaming tail temporarily shrinks it
  s.scrollDown(before); assert.equal(s.el.scrollTop, 500);
});
test("phone: 50px above the bottom is reading history, not permission to follow", () => {
  const s = scrolling(); s.el.scrollTop = 550; assert.equal(s.atBottom(), false);
});
test("phone: a whole reply taller than the viewport follows from the pre-insert bottom", () => {
  const s = scrolling(); const before = s.atBottom(); s.el.scrollHeight += 900;
  s.scrollDown(before); assert.equal(s.el.scrollTop, 1900);
});
test("phone: late media/font growth follows only while at bottom", () => {
  const s = scrolling(); s.el.scrollHeight += 500; s.resize(); assert.equal(s.el.scrollTop, 1500);
  s.el.scrollTop = 300; s.listeners.scroll(); s.el.scrollHeight += 500; s.resize(); assert.equal(s.el.scrollTop, 300);
});
test("phone: upward wheel and touch cancel a pending layout pin before scroll fires", () => {
  for (const kind of ["wheel", "touch"]) {
    const s = scrolling();
    if (kind === "wheel") s.listeners.wheel({ deltaY: -20 });
    else { s.listeners.touchstart({ touches: [{ clientY: 200 }] }); s.listeners.touchmove({ touches: [{ clientY: 230 }] }); }
    s.el.scrollHeight += 500; s.resize(); assert.equal(s.el.scrollTop, 600, kind);
  }
});
test("phone: returning to bottom resumes following without a per-thread scroll registry", () => {
  const s = scrolling(); s.el.scrollTop = 100; s.listeners.scroll();
  s.el.scrollTop = 600; s.listeners.scroll(); s.el.scrollHeight += 500; s.resize(); assert.equal(s.el.scrollTop, 1500);
});
test("phone: a background-tab fallback flush does not leave a second rAF render", () => {
  const frames: (() => void)[] = [], timers: (() => void)[] = []; let renders = 0;
  const code = boot.slice(boot.indexOf("  let renderQueued ="), boot.indexOf("\n  async function openThread"));
  const schedule = runInNewContext(code + "\nscheduleRender", { requestAnimationFrame: (fn: () => void) => frames.push(fn), setTimeout: (fn: () => void) => timers.push(fn), renderThread: () => renders++ });
  schedule(); schedule(); timers[0](); frames[0](); assert.equal(renders, 1);
});
test("phone: keyboard upward navigation cancels a pending resize pin, not typing", () => {
  for (const key of ["ArrowUp", "PageUp", "Home", " "]) {
    const s = scrolling();
    s.listeners.keydown({ key, shiftKey: true, target: { closest: () => null } });
    s.el.scrollHeight += 500; s.resize(); assert.equal(s.el.scrollTop, 600, key);
  }
  const s = scrolling();
  s.listeners.keydown({ key: "ArrowUp", target: { closest: () => ({}) } });
  s.el.scrollHeight += 500; s.resize(); assert.equal(s.el.scrollTop, 1500);
});
test("phone: Clear and thread switches reset only the viewport latch; send does not force it", () => {
  assert.match(boot, /function clearThreadUi\(\) \{ followBottom = true;/);
  assert.match(boot, /shownNodes.clear\(\);\n    followBottom = true;[^\n]*\n    renderThread\(\);/);
  assert.doesNotMatch(boot.slice(boot.indexOf("  async function send("), boot.indexOf("  // The real text's height")), /scrollDown\(true\)/);
});
test("phone: a queued programmatic scroll after image growth does not release the bottom latch", () => {
  const s = scrolling();
  s.el.scrollHeight += 500; // pixels decode before the queued scroll event arrives
  s.listeners.scroll(); s.resize(); assert.equal(s.el.scrollTop, 1500);
});
