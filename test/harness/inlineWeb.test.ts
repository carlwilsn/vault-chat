// Inline web pages in the chat (src/inlineWeb.ts): which srcs are pages, which addresses may load, where the native
// view goes, and which images are pages on a line of their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkBreaks from "remark-breaks";
import remarkRehype from "remark-rehype";
import { displayHost, isWebPageSrc, nativeBounds, pickToRest, probePoints, publicWebUrl, sameBounds, soloWebImages, visibleBox } from "../../src/inlineWeb.ts";

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
