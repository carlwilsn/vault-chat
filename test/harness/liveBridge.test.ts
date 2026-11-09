// Live pages (src/liveBridge.ts, server/liveProxy.ts): the allow-list, the limits and the page script.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { LIVE_LIMITS, allowRate, base64ToBytes, bytesToBase64, insideVault, liveAskText, liveScript, parseLiveManifest, toolAllowed } from "../../src/liveBridge.ts";
import { inlineHtmlDocument } from "../../src/inlineHtml.ts";
import { liveGateway, liveManifest, liveRevoke, liveToken } from "../../server/liveProxy.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a manifest names capabilities; unknown or malformed ones are dropped", () => {
  assert.deepEqual(parseLiveManifest('<meta name="vc-capabilities" content="ask, mic">'), ["ask", "mic"]);
  assert.deepEqual(parseLiveManifest("<meta content='tool:voice-lab.* ask,ask' name=vc-capabilities>"), ["ask", "tool:voice-lab.*"]);
  assert.deepEqual(parseLiveManifest('<meta name="vc-capabilities" content="ask, fs, tool:../x, tool:">'), ["ask"]);
  assert.deepEqual(parseLiveManifest('<meta name="viewport" content="ask"><p>hi</p>'), []);
  assert.deepEqual(parseLiveManifest("<p>no manifest</p>"), []);
  assert.ok(toolAllowed(["tool:voice-lab.*"], "voice-lab.tts") && !toolAllowed(["tool:voice-lab.*"], "voice-labx") && !toolAllowed(["ask"], "x") && toolAllowed(["tool:a.b"], "a.b") && !toolAllowed(["tool:a.b"], "a.bc"));
});

test("only files inside the vault are live pages", () => {
  assert.ok(insideVault(".vault-chat/visuals/a.html", "/home/c/v"));
  assert.ok(insideVault("/home/c/v/notes/a.html", "/home/c/v"));
  assert.ok(insideVault("C:\\Users\\c\\v\\a.html", "C:/Users/c/v/"));
  assert.ok(!insideVault("/home/c/other/a.html", "/home/c/v"));
  assert.ok(!insideVault("/home/c/vault2/a.html", "/home/c/v"));
  assert.ok(!insideVault("../a.html", "/home/c/v"));
  assert.ok(!insideVault("/home/c/v/../x/a.html", "/home/c/v"));
  assert.ok(!insideVault("/home/c/v/a.html", null));
  assert.ok(!insideVault(null, "/home/c/v"));
});

test("the rate limit is a sliding minute", () => {
  const t: number[] = [];
  for (let i = 0; i < LIVE_LIMITS.asksPerMinute; i++) assert.ok(allowRate(t, LIVE_LIMITS.asksPerMinute, 1000 + i));
  assert.ok(!allowRate(t, LIVE_LIMITS.asksPerMinute, 30_000));
  assert.ok(allowRate(t, LIVE_LIMITS.asksPerMinute, 61_500));
});

test("base64 round trips bytes; an ask names its page and carries the system text", () => {
  const b = new Uint8Array(70_000).map((_, i) => i % 251);
  assert.deepEqual(base64ToBytes(bytesToBase64(b)), b);
  const t = liveAskText("a/b.html", "Be brief.", "hi");
  assert.ok(t.includes('"a/b.html"') && t.includes("Be brief.") && t.endsWith("\n\nhi"));
});

test("a document gets window.vc only when it is live, and the script is valid and idempotent", () => {
  assert.ok(!inlineHtmlDocument("<p>x</p>", { css: "" }).includes("data-vc-live-script"));
  const doc = inlineHtmlDocument('<!doctype html><html><head><meta name="vc-capabilities" content="ask"></head><body>x</body></html>', { css: "", live: true });
  assert.ok(!inlineHtmlDocument("<p>x</p>", { css: "", live: true }).includes("data-vc-live-script"), "no manifest, no window.vc");
  assert.ok(doc.includes("data-vc-live-script"));
  assert.ok(doc.indexOf("data-vc-live-script") < doc.indexOf("vc-inline-html-size"));
  const src = /<script data-vc-live-script>([\s\S]*?)<\/script>/.exec(liveScript())![1]!;
  const posted: any[] = [];
  const win: any = { innerWidth: 300, innerHeight: 200, addEventListener() {}, document: { documentElement: { style: { setProperty() {} } } }, parent: { postMessage: (m: any) => posted.push(m) } };
  win.window = win;
  vm.runInNewContext(src, { ...win, window: win, parent: win.parent, setInterval: () => 1, clearInterval() {}, addEventListener() {}, document: win.document, innerWidth: 300, innerHeight: 200, Promise, Symbol, Headers: class {}, Response: class {}, Blob: class {}, TextEncoder });
  assert.equal(posted[0]?.op, "hello");
  assert.equal(typeof win.vc?.ask, "function");
});

test("the gateway: a token is minted only for the page as it is, and scopes every call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "live-"));
  mkdirSync(join(dir, "v"));
  writeFileSync(join(dir, "v", "a.html"), '<meta name="vc-capabilities" content="ask"><p>a</p>');
  writeFileSync(join(dir, "v", "b.html"), "<p>no manifest</p>");
  const vault = join(dir, "v");
  const m = liveManifest(vault, "a.html")!;
  assert.deepEqual(m.caps, ["ask"]);
  assert.equal(liveManifest(vault, "b.html"), null);
  assert.equal(liveManifest(vault, "../x.html"), null);
  assert.equal(liveToken(vault, { path: "a.html", hash: "wrong", caps: ["ask"] }).status, 409);
  assert.equal(liveToken(vault, { path: "a.html", hash: m.hash, caps: ["ask", "mic"] }).status, 409);
  const tok = (liveToken(vault, { path: "a.html", hash: m.hash, caps: ["ask"] }).body as { token: string }).token;
  const g = (token: string, path: string, method = "GET", extra = {}) => liveGateway(vault, null, { token, path, method, ...extra });
  assert.equal((await g("nope", "/api/v1/side")).status, 401);
  assert.equal((await g(tok.slice(0, -2) + "xx", "/api/v1/side", "POST")).status, 401);
  // ask covers only the side protocol: nothing else on the box
  for (const p of ["/api/v2/intent", "/message", "/api/v1/vault/file?path=a", "/api/v1/side/../intent", "/api/v2/lab/x"]) assert.equal((await g(tok, p, "POST")).status, 403, p);
  assert.equal((await g(tok, "/api/v1/side/abc")).status, 403, "a session the page did not start");
  assert.equal((await g(tok, "/api/v1/side", "POST", { bodyBase64: Buffer.from(JSON.stringify({ text: "x", persist: true })).toString("base64") })).status, 403, "persist is refused");
  assert.equal((await g(tok, "/api/v1/side", "POST", { bodyBase64: Buffer.from(JSON.stringify({ text: " " })).toString("base64") })).status, 400);
  // the page changes: the old token stops working
  writeFileSync(join(dir, "v", "a.html"), '<meta name="vc-capabilities" content="ask"><p>changed</p>');
  assert.equal((await g(tok, "/api/v1/side/abc")).status, 401);
  // revoked
  const m2 = liveManifest(vault, "a.html")!;
  const tok2 = (liveToken(vault, { path: "a.html", hash: m2.hash, caps: ["ask"] }).body as { token: string }).token;
  assert.notEqual((await g(tok2, "/api/v1/side/abc")).status, 401);
  await new Promise((r) => setTimeout(r, 5));
  liveRevoke({ path: "a.html" });
  assert.equal((await g(tok2, "/api/v1/side/abc")).status, 401);
  // no `ask`, no sessions
  writeFileSync(join(dir, "v", "c.html"), '<meta name="vc-capabilities" content="mic">');
  const mc = liveManifest(vault, "c.html")!;
  const tc = (liveToken(vault, { path: "c.html", hash: mc.hash, caps: ["mic"] }).body as { token: string }).token;
  assert.equal((await g(tc, "/api/v1/side", "POST", { bodyBase64: Buffer.from(JSON.stringify({ text: "x" })).toString("base64") })).status, 403);
  rmSync(dir, { recursive: true, force: true });
});
