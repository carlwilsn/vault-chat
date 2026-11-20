// The Screen tool drew every live HTML page in the viewer as a grey labelled box (2026-11-20): the page runs in a
// sandboxed frame with an opaque origin, which the window's own drawing cannot read. Now a viewer page draws itself
// on request (src/pageSnap.ts PAGE_SNAP_BRIDGE, injected into its head) and src/screenCapture.ts puts that picture
// where the frame is. The drawing itself needs a real webview (checked in headless Chromium with a sandboxed srcdoc
// page: radio, canvas and typed input all drawn); here: the request/answer protocol, and that viewer pages carry it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { PAGE_SNAP_BRIDGE, SNAP_FRAME_SELECTOR, snapFrame } = await import("../../src/pageSnap.ts");

/** A window and a page frame: the frame answers a snap request (or not) with `answer`. */
function fakes(answer: (id: string, frameWin: object) => { source: object; data: unknown } | null, delay = 5) {
  const listeners = new Set<(e: MessageEvent) => void>();
  const win = {
    addEventListener: (_t: "message", f: (e: MessageEvent) => void) => void listeners.add(f),
    removeEventListener: (_t: "message", f: (e: MessageEvent) => void) => void listeners.delete(f),
  };
  const frameWin = {
    postMessage: (m: any) => {
      const r = answer(m.__vc_snap, frameWin);
      if (r) setTimeout(() => listeners.forEach((f) => f({ source: r.source, data: r.data } as MessageEvent)), delay);
    },
  };
  return { win, frame: { contentWindow: frameWin }, listeners };
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("a page frame that draws itself: its PNG comes back, and the listener is gone after", async () => {
  const f = fakes((id, src) => ({ source: src, data: { __vc_snap_result: { id, dataUrl: PNG } } }));
  assert.equal(await snapFrame(f.frame, 1000, f.win), PNG);
  assert.equal(f.listeners.size, 0);
});

test("only that frame's own answer to this request counts; no answer, an error or a non-PNG is null", async () => {
  const other = { postMessage() {} };
  const wrongSource = fakes((id) => ({ source: other, data: { __vc_snap_result: { id, dataUrl: PNG } } }));
  assert.equal(await snapFrame(wrongSource.frame, 100, wrongSource.win), null);
  const wrongId = fakes((_id, src) => ({ source: src, data: { __vc_snap_result: { id: "old", dataUrl: PNG } } }));
  assert.equal(await snapFrame(wrongId.frame, 100, wrongId.win), null);
  const silent = fakes(() => null);
  assert.equal(await snapFrame(silent.frame, 50, silent.win), null);
  assert.equal(silent.listeners.size, 0);
  const err = fakes((id, src) => ({ source: src, data: { __vc_snap_result: { id, error: "could not draw" } } }));
  assert.equal(await snapFrame(err.frame, 1000, err.win), null);
  const notPng = fakes((id, src) => ({ source: src, data: { __vc_snap_result: { id, dataUrl: "javascript:alert(1)" } } }));
  assert.equal(await snapFrame(notPng.frame, 1000, notPng.win), null);
  assert.equal(await snapFrame({ contentWindow: null }, 50, silent.win), null);
});

test("the page's side is valid script, answers only its parent, and every viewer page carries it", () => {
  const body = PAGE_SNAP_BRIDGE.replace(/^<script>/, "").replace(/<\/script>$/, "");
  assert.doesNotThrow(() => new Function(body), "the injected bridge parses");
  assert.match(body, /e\.source === parent/);
  assert.match(body, /__vc_snap_result/);
  const view = readFileSync(new URL("../../src/HtmlView.tsx", import.meta.url), "utf8");
  assert.match(view, /SCROLL_BRIDGE \+ PAGE_SNAP_BRIDGE \+/, "injectHeadScripts puts it in every viewer page's head");
  assert.match(view, /data-look-frame/, "the viewer frame carries the attribute the capture asks");
  assert.equal(SNAP_FRAME_SELECTOR, "iframe[data-look-frame]");
  const cap = readFileSync(new URL("../../src/screenCapture.ts", import.meta.url), "utf8");
  assert.match(cap, /el\.matches\(SNAP_FRAME_SELECTOR\)[\s\S]*snapFrame\(/, "the window's drawing asks each viewer frame");
});
