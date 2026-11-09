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
