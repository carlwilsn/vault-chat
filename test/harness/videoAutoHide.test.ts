// The viewer's video bar comes back like YouTube's (src/VideoPlayer.tsx), mounted in a DOM and driven by events:
// while playing it hides after its idle time, and any mouse move over the video, tap, wheel, key or keyboard focus
// brings it back at once, even when something between the video and the app's root stops the move on its way up
// (the shipped version woke only on React handlers on the player, so a stopped move never reached it: the bar stayed
// gone). It stays while paused, while the pointer rests on the bar and while seeking; a mouse leaving hides it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { parseHTML } from "linkedom";

const G = globalThis as any;
const { window: lw, document } = parseHTML("<!doctype html><html><head></head><body><div id=app></div></body></html>");
G.window ??= G;
G.document = document;
G.IS_REACT_ACT_ENVIRONMENT = true;
(document as any).defaultView ??= lw;
G.React = React;

// linkedom has no capture phase: give the document's capture listeners their turn first, as a browser does.
const capturing = new Map<string, Set<EventListener>>();
const docAdd = document.addEventListener.bind(document);
const docRemove = document.removeEventListener.bind(document);
const isCapture = (o: unknown) => o === true || (typeof o === "object" && !!o && (o as AddEventListenerOptions).capture === true);
(document as any).addEventListener = (t: string, fn: EventListener, o?: unknown) => {
  if (!isCapture(o)) return docAdd(t, fn, o as never);
  if (!capturing.has(t)) capturing.set(t, new Set());
  capturing.get(t)!.add(fn);
};
(document as any).removeEventListener = (t: string, fn: EventListener, o?: unknown) => (isCapture(o) ? capturing.get(t)?.delete(fn) : docRemove(t, fn));
const elProto = Object.getPrototypeOf(document.createElement("div"));
let owner = elProto;
while (owner && !Object.prototype.hasOwnProperty.call(owner, "dispatchEvent")) owner = Object.getPrototypeOf(owner);
const nativeDispatch = owner.dispatchEvent;
owner.dispatchEvent = function (this: Node, e: Event) {
  if ((this as any).ownerDocument === document) {
    Object.defineProperty(e, "target", { value: this, configurable: true });
    for (const fn of capturing.get(e.type) ?? []) fn.call(document, e);
    delete (e as any).target;
  }
  return nativeDispatch.call(this, e);
};
const capturedCount = () => [...capturing.values()].reduce((n, s) => n + s.size, 0);

const { VideoPlayer, pointerPlace, inBox } = await import("../../src/VideoPlayer.tsx");

const IDLE = 60;
const tick = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

type Ev = Event & { clientX?: number; clientY?: number; pointerType?: string; relatedTarget?: unknown };
function ev(type: string, init: { clientX?: number; clientY?: number; pointerType?: string; relatedTarget?: unknown } = {}): Ev {
  const e = new (lw as any).Event(type, { bubbles: true, cancelable: true }) as Ev;
  for (const [k, v] of Object.entries(init)) Object.defineProperty(e, k, { value: v });
  return e;
}
async function fire(node: Element, type: string, init?: Parameters<typeof ev>[1]) {
  await act(async () => {
    node.dispatchEvent(ev(type, init));
  });
}

async function mountViewer() {
  const host = document.createElement("div");
  // A layer between the player and the app's root that stops every move on its way up (as any pane, plugin host or
  // overlay may): React's own handlers, at the root, never hear them.
  const pane = document.createElement("div");
  host.appendChild(pane);
  document.getElementById("app")!.appendChild(host);
  const stopper = (el: HTMLElement | null) => {
    if (!el || (el as any).__stops) return;
    (el as any).__stops = true;
    for (const t of ["pointermove", "mousemove", "pointerdown", "mousedown", "wheel", "touchstart", "pointerover", "pointerout"]) el.addEventListener(t, (e: Event) => e.stopPropagation());
  };
  const root = createRoot(pane as unknown as HTMLElement);
  await act(async () =>
    root.render(createElement("div", { ref: stopper, "data-el": "stopping-layer" }, createElement(VideoPlayer, { src: "asset://v.mp4", fill: true, dataEl: "viewer-video", idleMs: IDLE }))),
  );
  const q = (sel: string) => pane.querySelector(sel) as unknown as HTMLElement;
  const wrap = q('[data-el="video-player"]');
  const video = q('[data-el="viewer-video"]');
  const bar = q('[data-el="video-bar"]');
  const chrome = () => wrap.getAttribute("data-chrome");
  const play = async () => {
    await act(async () => {
      video.dispatchEvent(new (lw as any).Event("play"));
    });
  };
  const pause = async () => {
    await act(async () => {
      video.dispatchEvent(new (lw as any).Event("pause"));
    });
  };
  const unmount = async () => {
    await act(() => root.unmount());
    assert.equal(capturedCount(), 0, "unmounted: no listener left on the document");
  };
  return { wrap, video, bar, chrome, play, pause, unmount, pane };
}

after(() => {
  delete G.IS_REACT_ACT_ENVIRONMENT;
});

test("a mouse move over the playing video brings the hidden bar (and the cursor) back, even past a layer that stops it", async () => {
  const p = await mountViewer();
  await p.play();
  assert.equal(p.chrome(), "shown", "just started: the bar shows");
  await tick(IDLE * 2.5);
  assert.equal(p.chrome(), "hidden", "still for its idle time: hidden");
  assert.match(p.wrap.className, /cursor-none/, "and the cursor with it");
  assert.match(p.bar.className, /opacity-0/);
  await fire(p.video, "pointermove", { clientX: 300, clientY: 200, pointerType: "mouse" });
  assert.equal(p.chrome(), "shown", "a move brings it back at once");
  assert.doesNotMatch(p.wrap.className, /cursor-none/);
  assert.doesNotMatch(p.bar.className, /opacity-0/);
  await tick(IDLE * 2.5);
  assert.equal(p.chrome(), "hidden", "and it hides again once the mouse rests");
  // A move that only reaches the document as a mouse event (no pointer event) counts too.
  await fire(p.video, "mousemove", { clientX: 310, clientY: 210 });
  assert.equal(p.chrome(), "shown");
  await p.unmount();
});

test("a tap, the wheel, a key or keyboard focus brings the bar back too", async () => {
  const p = await mountViewer();
  await p.play();
  for (const wakeBy of ["pointerdown", "wheel", "touchstart", "keydown", "focus"] as const) {
    await tick(IDLE * 2.5);
    assert.equal(p.chrome(), "hidden", `hidden before ${wakeBy}`);
    if (wakeBy === "focus") {
      await act(async () => {
        p.wrap.dispatchEvent(new (lw as any).Event("focusin", { bubbles: true }));
      });
    } else await fire(p.video, wakeBy, { clientX: 300, clientY: 200, pointerType: "mouse" });
    assert.equal(p.chrome(), "shown", `${wakeBy} brings it back`);
  }
  await p.unmount();
});

test("paused, the bar stays; resting on the bar keeps it; a mouse leaving the video hides it at once", async () => {
  const p = await mountViewer();
  await tick(IDLE * 2.5);
  assert.equal(p.chrome(), "shown", "never played: shown");
  await p.play();
  await p.pause();
  await tick(IDLE * 2.5);
  assert.equal(p.chrome(), "shown", "paused: shown however long the mouse rests");
  await p.play();
  await fire(p.bar, "pointermove", { clientX: 300, clientY: 690, pointerType: "mouse" });
  await tick(IDLE * 2.5);
  assert.equal(p.chrome(), "shown", "the pointer rests on the bar: shown");
  await fire(p.video, "pointermove", { clientX: 300, clientY: 200, pointerType: "mouse" });
  await tick(IDLE * 2.5);
  assert.equal(p.chrome(), "hidden", "off the bar and still: hidden");
  // Leaving: a move that lands outside the player's box.
  (p.wrap as any).getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 700, width: 800, height: 700 });
  await fire(p.video, "pointermove", { clientX: 300, clientY: 200, pointerType: "mouse" });
  assert.equal(p.chrome(), "shown");
  const outside = document.createElement("div");
  document.body.appendChild(outside);
  await fire(outside as unknown as Element, "pointermove", { clientX: 900, clientY: 200, pointerType: "mouse" });
  assert.equal(p.chrome(), "hidden", "the mouse left the playing video: hidden at once");
  // A layer laid over the player (its own element, outside the player) still has the pointer over the video.
  await fire(outside as unknown as Element, "pointermove", { clientX: 400, clientY: 300, pointerType: "mouse" });
  assert.equal(p.chrome(), "shown", "a move over the player's box wakes it whatever element is on top");
  await p.unmount();
});

test("pointerPlace judges by the target first, then by the player's box", () => {
  const inside = {};
  const player = { contains: (n: unknown) => n === inside, getBoundingClientRect: () => ({ left: 10, top: 10, right: 110, bottom: 60, width: 100, height: 50 }) };
  assert.equal(pointerPlace({ target: inside }, player), "in");
  assert.equal(pointerPlace({ target: {}, clientX: 50, clientY: 30 }, player), "in");
  assert.equal(pointerPlace({ target: {}, clientX: 5, clientY: 30 }, player), "out");
  assert.equal(pointerPlace({ target: {} }, player), "none", "no point to judge by");
  assert.equal(pointerPlace({ target: {}, clientX: 5, clientY: 5 }, { contains: () => false }), "none", "no layout: no verdict");
  assert.equal(inBox(0, 0, { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }), false);
});
