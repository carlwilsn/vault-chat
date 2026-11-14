// Inline HTML pages in the chat (src/inlineHtml.ts): the document a frame gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HTML_CSP, HTML_MAX_H, inlineHtmlDocument, inlineHtmlHeight, isHtmlSrc } from "../../src/inlineHtml.ts";

const CSS = ".bg-card{background:red} </style><script>bad()</script>";

test("the CSP comes first in <head>, after the doctype; the app stylesheet link becomes the inlined CSS", () => {
  const doc = inlineHtmlDocument('<!DOCTYPE html><html><head><link rel="stylesheet" href="/app-styles.css"><title>t</title></head><body>x</body></html>', { css: CSS, theme: "light" });
  assert.ok(doc.startsWith("<!DOCTYPE html><html><head><meta http-equiv=\"Content-Security-Policy\""));
  assert.ok(doc.includes(HTML_CSP));
  assert.ok(!doc.includes('href="/app-styles.css"'));
  assert.ok(doc.includes("<style data-vc-app-styles>.bg-card{background:red} <\\/style><script>bad()"), "the CSS cannot close its <style>");
  assert.ok(doc.includes('d.setAttribute("data-theme","light")'));
});

test("a fragment gets a doctype and a head; no link means no app CSS; no theme means the page's own", () => {
  const doc = inlineHtmlDocument("<div>hi</div>", { css: CSS });
  assert.match(doc, /^<!doctype html><head><meta http-equiv="Content-Security-Policy"/);
  assert.ok(!doc.includes("data-vc-app-styles"));
  assert.ok(!doc.includes("data-theme"));
  assert.ok(doc.endsWith("<div>hi</div>"));
  assert.ok(inlineHtmlDocument('<html lang="en"><body>y</body></html>', { css: "" }).startsWith('<!doctype html><html lang="en"><head><meta'));
  assert.ok(inlineHtmlDocument("<link href='app-styles.css' rel=stylesheet><p>z</p>", { css: CSS }).includes("data-vc-app-styles"));
});

test("only size reports are heights, clamped", () => {
  assert.equal(inlineHtmlHeight({ type: "vc-inline-html-size", h: 211.2 }), 212);
  assert.equal(inlineHtmlHeight({ type: "vc-inline-html-size", h: 1e9 }), HTML_MAX_H);
  assert.equal(inlineHtmlHeight({ type: "vc-inline-html-size", h: 3 }), 40);
  assert.equal(inlineHtmlHeight({ type: "other", h: 100 }), null);
  assert.equal(inlineHtmlHeight({ type: "vc-inline-html-size", h: "100" }), null);
  assert.equal(inlineHtmlHeight(null), null);
  assert.ok(isHtmlSrc(".vault-chat/visuals/a.html") && isHtmlSrc("a.HTM?x=1") && !isHtmlSrc("a.html.png") && !isHtmlSrc("a.svg"));
});

test("an inline page collapses to the note only when chat and the viewer showing it are visible together", async () => {
  const { inlineHtmlCollapses: c } = await import("../../src/inlineHtml.ts");
  const split = { chatFullscreen: false, rightCollapsed: false, popoutOpen: false };
  assert.equal(c(split, true), true, "viewer beside chat: note");
  assert.equal(c(split, false), false, "file not open in the viewer: page");
  assert.equal(c({ ...split, rightCollapsed: true }, true), false, "viewer fullscreen (chat hidden): page");
  assert.equal(c({ ...split, chatFullscreen: true }, true), false, "chat fullscreen (viewer hidden): page");
  assert.equal(c({ ...split, popoutOpen: true }, true), true, "chat popped out beside the viewer: note");
});

test("relative image refs (attribute, script string, url()) become data: URIs; absolute, http and missing ones stay", async () => {
  const { embedRelativeImages, joinPagePath, relativeImageRefs } = await import("../../src/inlineHtml.ts");
  const html = `<img src="a.png"><script>var p=['b/c.jpg',"http://x/d.png","/e.png"];</script><div style="background:url(f.svg)"></div><img src="gone.png">`;
  assert.deepEqual(relativeImageRefs(html).sort(), ["a.png", "b/c.jpg", "f.svg", "gone.png"]);
  const out = embedRelativeImages(html, new Map([["a.png", new Uint8Array([1, 2, 3])], ["b/c.jpg", new Uint8Array([4])], ["f.svg", new Uint8Array([5])]]));
  assert.ok(out.includes('src="data:image/png;base64,AQID"'));
  assert.ok(out.includes("'data:image/jpeg;base64,BA=='") && out.includes("url(data:image/svg+xml;base64,BQ==)"));
  assert.ok(out.includes('"http://x/d.png"') && out.includes('"/e.png"') && out.includes('src="gone.png"'));
  assert.equal(joinPagePath(".vault-chat/local/pages", "p/1.jpg"), ".vault-chat/local/pages/p/1.jpg");
  assert.equal(joinPagePath("a/b", "../c.png"), "a/c.png");
  assert.equal(joinPagePath("a", "../../c.png"), null);
  assert.equal(joinPagePath("/v/pages", "x.png"), "/v/pages/x.png");
  // the CSP is unchanged: images only from data:/blob:, no network
  assert.ok(HTML_CSP.includes("img-src data: blob:") && HTML_CSP.includes("connect-src 'none'"));
});

test("a page can ask for its frame size: meta vc-frame or a markdown title, clamped", async () => {
  const m = await import("../../src/inlineHtml.ts");
  assert.deepEqual(m.parseFrameHint("aspect=16/10"), { aspect: 1.6 });
  assert.deepEqual(m.parseFrameHint("aspect=1.5, height=640px"), { aspect: 1.5, height: 640 });
  assert.deepEqual(m.parseFrameHint("height=99999"), { height: m.HTML_MAX_H });
  assert.deepEqual(m.parseFrameHint("height=5"), { height: m.HTML_MIN_FRAME_H });
  assert.equal(m.parseFrameHint("aspect=100/1"), null);
  assert.equal(m.parseFrameHint("nonsense"), null);
  assert.deepEqual(m.parseFrameHintFromHtml('<head><meta charset=utf-8><meta content="height=700" name="vc-frame"></head>'), { height: 700 });
  assert.deepEqual(m.parseFrameHintFromHtml("<meta name='vc-frame' content='aspect=4/3'>"), { aspect: 4 / 3 });
  assert.equal(m.parseFrameHintFromHtml('<meta name="viewport" content="height=700">'), null);
  const doc = m.inlineHtmlDocument('<meta name="vc-frame" content="height=640"><p>x</p>', { css: "" });
  assert.ok(doc.includes('meta[name=\\"vc-frame\\"]') || doc.includes("meta[name=\"vc-frame\"]"), "the size script forwards the page's request");
  assert.deepEqual(m.inlineHtmlReport({ type: "vc-inline-html-size", h: 500, fill: true, frame: "height=640" }), { h: 500, fill: true, hint: { height: 640 } });
  assert.equal(m.inlineHtmlReport({ type: "x", h: 5 }), null);
});

test("frame height: 16:10 default capped at 85% of the window; a full-height page keeps it; a short content page shrinks", async () => {
  const { frameHeight: f, defaultFrameHeight: d } = await import("../../src/inlineHtml.ts");
  assert.equal(d(1024, 1000), 640);
  assert.equal(d(2000, 1400), 720, "a wide chat caps at 720");
  assert.equal(d(500, 1000), 480, "a narrow one does not collapse");
  assert.equal(d(1024, 600), 510, "capped at 85% of a short window");
  assert.equal(d(390, 800, true), 600, "phone: 75% of the screen");
  const base = { width: 1024, vh: 1000 };
  assert.equal(f({ ...base }), 640, "before any report");
  assert.equal(f({ ...base, report: { h: 320, fill: true, hint: null } }), 640, "a 100vh page reporting the frame's own height is not a strip");
  assert.equal(f({ ...base, report: { h: 220, fill: false, hint: null } }), 220, "a short content page fits its content");
  assert.equal(f({ ...base, report: { h: 900, fill: false, hint: null } }), 900);
  assert.equal(f({ ...base, hint: { height: 700 }, report: { h: 220, fill: false, hint: null } }), 700);
  assert.equal(f({ ...base, report: { h: 50, fill: true, hint: { aspect: 2 } } }), 512);
  assert.equal(f({ width: 1600, vh: 700, hint: { aspect: 1 } }), 595, "an aspect is capped at 85% of the window");
});
