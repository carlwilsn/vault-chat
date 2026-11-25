// Inline web pages in the chat (src/inlineWeb.ts): which srcs are pages, which addresses may load, where the native
// view goes, and which images are pages on a line of their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkBreaks from "remark-breaks";
import remarkRehype from "remark-rehype";
import { displayHost, isWebPageSrc, nativeBounds, pickToRest, probePoints, publicWebUrl, sameBounds, SETTLE_MS, soloWebImages, viewPlacer, visibleBox, type Bounds } from "../../src/inlineWeb.ts";

test("a page is an http(s) address that is not a picture, video, audio or PDF file", () => {
  assert.ok(isWebPageSrc("https://www.geoffreylitt.com/2023/03/25/llm-end-user-programming.html"));
  assert.ok(isWebPageSrc("https://example.com/"));
  assert.ok(isWebPageSrc("http://example.com/post?id=3"));
  for (const no of ["https://x.com/a.png", "https://x.com/a.JPG?w=2", "https://x.com/v.mp4", "https://x.com/doc.pdf", ".vault-chat/visuals/a.html", "data:text/html,x", "", null, "ftp://x.com/"])
    assert.equal(isWebPageSrc(no), false, String(no));
});

test("only public hosts load inline: never the laptop, the LAN, the tailnet (the box) or the app's own schemes", () => {
  assert.ok(publicWebUrl("https://www.geoffreylitt.com/"));
  assert.ok(publicWebUrl("http://93.184.215.14/"));
  for (const bad of [
    "http://localhost:5173/", "http://127.0.0.1/", "http://0x7f.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
    "http://10.1.2.3/", "http://192.168.0.1/", "http://172.16.5.4/", "http://169.254.169.254/", "http://100.100.1.1/",
    "http://[fd7a:115c:a1e0::1]/", "https://thinkbox.tail0a1b2.ts.net/p/x.html", "http://tauri.localhost/", "http://asset.localhost/C:/x",
    "http://printer.local/", "http://intranet/", "https://u:p@example.com/", "file:///C:/x", "javascript:alert(1)",
  ]) assert.equal(publicWebUrl(bad), false, bad);
});

test("the view covers the visible part of the placeholder, in logical pixels, and hides when (nearly) none shows", () => {
  const win = { w: 1200, h: 800 };
  const chat = { left: 700, top: 40, right: 1200, bottom: 740 };
  assert.deepEqual(visibleBox({ left: 710, top: 100, right: 1190, bottom: 600 }, [chat], win), { left: 710, top: 100, right: 1190, bottom: 600 });
  // Scrolled up under the chat's header: only the part inside the scroller.
  assert.deepEqual(visibleBox({ left: 710, top: -200, right: 1190, bottom: 300 }, [chat], win), { left: 710, top: 40, right: 1190, bottom: 300 });
  assert.equal(visibleBox({ left: 710, top: 730, right: 1190, bottom: 1200 }, [chat], win), null, "a 10px sliver hides");
  assert.equal(visibleBox({ left: 10, top: 100, right: 600, bottom: 600 }, [chat], win), null, "outside the chat");
  assert.deepEqual(nativeBounds({ left: 10.4, top: 20.6, right: 110.2, bottom: 220.1 }), { x: 10, y: 20, width: 101, height: 201 });
  assert.deepEqual(nativeBounds({ left: 100, top: 100, right: 200, bottom: 200 }, 1.25), { x: 125, y: 125, width: 125, height: 125 });
  assert.equal(probePoints({ left: 0, top: 0, right: 100, bottom: 100 }).length, 9);
  // A viewer-sized view is probed at most 140 px apart: a title-bar menu opening over its middle is seen.
  const grid = probePoints({ left: 160, top: 60, right: 1260, bottom: 960 });
  const xs = [...new Set(grid.map(([x]) => x))].sort((a, b) => a - b), ys = [...new Set(grid.map(([, y]) => y))].sort((a, b) => a - b);
  for (const axis of [xs, ys]) for (let i = 1; i < axis.length; i++) assert.ok(axis[i]! - axis[i - 1]! <= 140, `probes ${axis[i - 1]} and ${axis[i]} too far apart`);
  assert.ok(grid.some(([x, y]) => x >= 700 && x <= 880 && y <= 200), "a 180 x 140 menu under the title bar is hit");
  assert.ok(sameBounds({ x: 1, y: 2, width: 3, height: 4, visible: true }, { x: 1, y: 2, width: 3, height: 4, visible: true }));
  assert.ok(sameBounds({ x: 1, y: 2, width: 3, height: 4, visible: false }, { x: 9, y: 9, width: 9, height: 9, visible: false }), "hidden is hidden");
  assert.ok(!sameBounds(null, { x: 0, y: 0, width: 1, height: 1, visible: false }));
  assert.equal(displayHost("https://www.geoffreylitt.com/a"), "geoffreylitt.com");
});

test("past the cap, the views seen longest ago that are off screen rest", () => {
  const live = new Map([
    ["a", { lastSeen: 1, visible: false }], ["b", { lastSeen: 5, visible: true }], ["c", { lastSeen: 2, visible: false }],
    ["d", { lastSeen: 3, visible: false }], ["e", { lastSeen: 9, visible: true }],
  ]);
  assert.deepEqual(pickToRest(live, 4), ["a"]);
  assert.deepEqual(pickToRest(live, 3), ["a", "c"]);
  assert.deepEqual(pickToRest(live, 5), []);
});

function para(md: string, breaks = false) {
  const p = unified().use(remarkParse);
  if (breaks) p.use(remarkBreaks);
  const tree = p.use(remarkRehype).runSync(p.parse(md)) as any;
  return tree.children.find((c: any) => c.tagName === "p");
}

test("a page on a line of its own is a page; an image inside a sentence (a badge) stays an image", () => {
  assert.deepEqual(soloWebImages(para("![Geoffrey Litt's blog](https://www.geoffreylitt.com/)")), [0]);
  for (const breaks of [false, true]) {
    const p = para("Here it is:\n![Blog](https://www.geoffreylitt.com/)\nEnjoy.", breaks);
    const i = p.children.findIndex((c: any) => c.tagName === "img");
    assert.deepEqual(soloWebImages(p), [i], `breaks=${breaks}`);
  }
  assert.deepEqual(soloWebImages(para("Build ![status](https://img.shields.io/badge/build-passing-green) today")), []);
  assert.deepEqual(soloWebImages(para("![chart](https://x.com/chart.png)")), [], "a picture stays a picture");
  assert.deepEqual(soloWebImages(para("![page](.vault-chat/visuals/a.html)")), [], "a vault page is InlineHtmlFrame's");
});

// ---- where the native view sits: always its own pane's placeholder (viewPlacer) ----

/** The desktop shell as web_embed.rs behaves: a move for a view that does not exist yet is dropped; each call answers
 *  after `ms`. `at` is where each view is now. */
function fakeShell(ms = 5) {
  const at = new Map<string, Bounds>();
  const log: string[] = [];
  const wait = () => new Promise((r) => setTimeout(r, ms));
  const calls = (id: string) => ({
    open: async (b: Bounds) => { log.push(`open ${b.x},${b.width}`); await wait(); at.set(id, b); },
    place: async (b: Bounds) => { log.push(`place ${b.x},${b.width}`); await wait(); if (at.has(id)) at.set(id, b); },
    close: async () => { log.push("close"); await wait(); at.delete(id); },
  });
  return { at, log, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 60));
const box = (x: number, width: number, visible = true): Bounds => ({ x, y: 60, width, height: 800, visible });
/** A body rect (CSS px) as the pane measures it: the visible part inside the viewer, in the window's pixels. */
const body = (left: number, right: number, viewer = { left: 160, top: 60, right: 1400, bottom: 900 }) =>
  ({ ...nativeBounds(visibleBox({ left, top: 60, right, bottom: 900 }, [viewer], { w: 1400, h: 900 })!), visible: true });

test("two panes, an iframe left and a native view right: the view lands on the right pane even when the split settles while it is being made", async () => {
  const shell = fakeShell();
  // The start-over close (ready()) is still on its way when the pane is first seen.
  let release!: () => void;
  const before = new Promise<void>((r) => { release = r; });
  const right = viewPlacer("right-pane", shell.calls("right-pane"), () => before);
  // The split's first layout: the new right pane drawn narrow at the left pane's place (Carl's laptop, 11-24) ...
  right.to(body(160, 436));
  // ... then settled beside the iframe pane (160..780), before the view exists.
  right.to(body(780, 1400));
  release();
  await settle();
  assert.deepEqual(shell.at.get("right-pane"), body(780, 1400), "on the right pane, not the left pane's place");
  assert.equal(shell.log[0]?.startsWith("open"), true, "nothing is sent before the view exists (the shell would drop it)");
  // The left (iframe) pane has no native view: only the right one exists.
  assert.deepEqual([...shell.at.keys()], ["right-pane"]);
});

test("after a split change, a resize or a swap the view follows its own pane; a lost move is sent again", async () => {
  const shell = fakeShell(2);
  const v = viewPlacer("p", shell.calls("p"));
  v.to(body(780, 1400));
  await settle();
  v.to(body(630, 1100)); // the window narrower
  v.to(body(160, 1400)); // the other pane closed: the split is gone
  await new Promise((r) => setTimeout(r, SETTLE_MS + 60)); // two size changes at once: hidden until they settle
  assert.deepEqual(shell.at.get("p"), body(160, 1400));
  assert.equal(v.to(body(160, 1400)), null, "no call when nothing moved (the 200 ms tick is free)");
  // A move the shell refused is not taken as done: the next measure sends it again.
  const flaky = fakeShell(1);
  let fail = true;
  const c = flaky.calls("q");
  const w = viewPlacer("q", { ...c, place: async (b) => { if (fail) { fail = false; throw new Error("busy"); } return c.place(b); } });
  w.to(box(0, 300));
  await settle();
  w.to(box(400, 300));
  await settle();
  assert.deepEqual(flaky.at.get("q"), box(0, 300));
  w.to(box(400, 300));
  await settle();
  assert.deepEqual(flaky.at.get("q"), box(400, 300));
});

test("a pane that goes while its view is still being made leaves no view behind; a hidden pane makes none", async () => {
  const shell = fakeShell(5);
  const v = viewPlacer("gone", shell.calls("gone"));
  v.to(box(780, 620));
  v.close(); // the pane closed before the shell answered the open
  await settle();
  assert.equal(shell.at.has("gone"), false);
  assert.deepEqual(shell.log, ["open 780,620", "close"], "the close comes after the open, never before it");
  const hidden = fakeShell();
  const h = viewPlacer("h", hidden.calls("h"));
  assert.equal(h.to(box(0, 1, false)), null);
  await settle();
  assert.deepEqual(hidden.log, []);
});

// ---- the view keeps up with a drag: no queue of stale places, hidden while its size keeps changing ----

test("a busy shell never gets a queue of old places: one call on its way, the newest place next", async () => {
  const shell = fakeShell(40); // the laptop's main thread busy: 40 ms a call
  const v = viewPlacer("s", shell.calls("s"));
  v.to(box(100, 600));
  await settle();
  shell.log.length = 0;
  // The chat scrolls the view up 10 px a frame for half a second (moves without resizing: it never hides).
  let y = 60;
  for (let i = 0; i < 30; i++) {
    y -= 10;
    v.to({ x: 100, y, width: 600, height: 800, visible: true });
    await new Promise((r) => setTimeout(r, 16));
  }
  assert.ok(shell.log.length <= 16, `${shell.log.length} places sent for 30 frames (a queue would send all 30)`);
  await new Promise((r) => setTimeout(r, 100)); // at most the call on its way, then the newest
  assert.deepEqual(shell.at.get("s"), { x: 100, y, width: 600, height: 800, visible: true }, "where the placeholder is now");
  assert.equal(v.moving, false);
});

test("a sash drag: the view hides once its size keeps changing and shows at the final size; one change just moves it", async () => {
  const shell = fakeShell(40);
  let movingSeen = 0;
  const v = viewPlacer("d", shell.calls("d"), undefined, { onMoving: (m) => { if (m) movingSeen++; } });
  v.to(body(160, 1100));
  await settle();
  // The chat sash dragged left 20 px a frame: the viewer's right edge 1100 -> 500. Sample where the view is each ms.
  let right = 1100, bleed = 0;
  const sample = setInterval(() => {
    const at = shell.at.get("d");
    if (at?.visible) bleed = Math.max(bleed, at.x + at.width - right);
  }, 1);
  for (let i = 0; i < 30; i++) {
    right -= 20;
    v.to(body(160, right));
    await new Promise((r) => setTimeout(r, 16));
  }
  // The view showed nothing over the chat beyond the first moves of the drag (a queue left it 385 px over at 40 ms).
  assert.ok(bleed <= 80, `the view reached ${bleed} px into the chat column`);
  assert.equal(shell.at.get("d")?.visible, false, "hidden while the sash moves");
  assert.equal(movingSeen, 1);
  await new Promise((r) => setTimeout(r, SETTLE_MS + 100));
  clearInterval(sample);
  assert.deepEqual(shell.at.get("d"), body(160, 500), "back, at the final size, once the drag stopped");
  assert.equal(v.moving, false);
  // A panel toggled (one change): moved, never hidden.
  shell.log.length = 0;
  v.to(body(400, 500));
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(shell.at.get("d"), body(400, 500));
  assert.deepEqual(shell.log, ["place 400,100"]);
  v.close();
});
