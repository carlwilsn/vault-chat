// HtmlView rewrites local resource paths so srcDoc pages load their images —
// but never inside <script> code (a single-file built app broke on a string
// like `src="'+x+'"` in its bundle).
import { test } from "node:test";
import assert from "node:assert/strict";

test("rewriteAssetUrls leaves script code alone and still rewrites markup", async () => {
  // Tauri's convertFileSrc, outside the app.
  (globalThis as any).window ??= globalThis;
  (globalThis as any).window.__TAURI_INTERNALS__ = { ...((globalThis as any).window.__TAURI_INTERNALS__ ?? {}), convertFileSrc: (p: string) => `asset://localhost/${p}` };
  const { rewriteAssetUrls } = await import("../../src/htmlAssets.ts");
  const code = `const t='<img src="'+J.escape(this.src)+'">';`;
  const html = `<html><head><script type="module">${code}</script><script src="lib.js"></script></head><body><img src="pic.png"></body></html>`;
  const out = rewriteAssetUrls(html, "/v/notes/page.html");
  assert.ok(out.includes(code), "the inline script is byte-for-byte unchanged");
  assert.ok(!out.includes('src="pic.png"'), "a markup image path is rewritten");
  assert.ok(!out.includes('src="lib.js"'), "a <script src> tag is rewritten");
});

test("a vault page gets a base at its folder on the vcpage protocol; relative URLs are left to it", async () => {
  // Tauri's convertFileSrc on Windows: http://<scheme>.localhost/<encoded path>.
  (globalThis as any).window ??= globalThis;
  (globalThis as any).window.__TAURI_INTERNALS__ = {
    ...((globalThis as any).window.__TAURI_INTERNALS__ ?? {}),
    convertFileSrc: (p: string, proto = "asset") => `http://${proto}.localhost/${encodeURIComponent(p)}`,
  };
  const { pageBaseUrl, withBase, rewriteAssetUrls } = await import("../../src/htmlAssets.ts");
  const vault = "C:\\Users\\wada2\\github\\school2";
  const page = "C:\\Users\\wada2\\github\\school2\\Physics 135\\electricity-connected.html";
  const base = pageBaseUrl(0, vault, page);
  assert.equal(base, "http://vcpage.localhost/0/Physics%20135/");
  // The browser's own resolution: what `new Audio('electricity-audio/00.mp3')` asks for.
  assert.equal(new URL("electricity-audio/00.mp3", base!).href, "http://vcpage.localhost/0/Physics%20135/electricity-audio/00.mp3");
  assert.equal(new URL("../shared/pic.png", base!).href, "http://vcpage.localhost/0/shared/pic.png");
  assert.equal(pageBaseUrl(0, vault, "c:/users/wada2/github/school2/top.html"), "http://vcpage.localhost/0/", "Windows case and slashes");
  assert.equal(pageBaseUrl(0, vault, "D:\\elsewhere\\page.html"), null, "a page outside the vault gets no base");
  assert.equal(pageBaseUrl(2, "/home/c/v/", "/home/c/v/a b/p.html")!.endsWith("/2/a%20b/"), true);

  const html = `<html><head><title>t</title></head><body><img src="pic.png"><img src="C:\\x\\y.png"></body></html>`;
  const out = withBase(rewriteAssetUrls(html, page, false), base!);
  assert.ok(out.includes(`<head><base href="${base}">`), "the base is first in the head");
  assert.ok(out.includes('src="pic.png"'), "a relative path is left to the base");
  assert.ok(!out.includes('src="C:\\x\\y.png"'), "an absolute path is still rewritten");
  assert.ok(rewriteAssetUrls(html, page).includes("asset.localhost"), "with no base, relative paths are rewritten as before");
  const own = `<head><base href="https://example.com/"></head>`;
  assert.equal(withBase(own, base!), own, "a page's own base is kept");
});
