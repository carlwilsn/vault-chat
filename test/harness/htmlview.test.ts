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
