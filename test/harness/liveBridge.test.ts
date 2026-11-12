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

test("the voice-lab tool: only a voice-lab grant reaches the one local service, only its four operations, bounded, binary through", async () => {
  const { createServer } = await import("node:http");
  const { labTarget } = await import("../../server/labProxy.ts");
  const seen: { method?: string; url?: string; ct?: string; len: number }[] = [];
  const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 255, 128, 1, 2, 3]);
  const svc = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, ct: req.headers["content-type"], len: Buffer.concat(chunks).length });
      if (req.url === "/tts") {
        res.writeHead(200, { "content-type": "audio/wav", "x-total-ms": "12", "x-rtf": "0.5", "x-secret": "no" });
        return void res.end(wav);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
  });
  await new Promise<void>((r) => svc.listen(0, "127.0.0.1", () => r()));
  labTarget.port = (svc.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "live-lab-"));
  const vault = join(dir, "v");
  mkdirSync(vault);
  const mk = (name: string, caps: string) => {
    writeFileSync(join(vault, name), `<meta name="vc-capabilities" content="${caps}"><p>${name}</p>`);
    const m = liveManifest(vault, name)!;
    return (liveToken(vault, { path: name, hash: m.hash, caps: m.caps }).body as { token: string }).token;
  };
  try {
    const lab = mk("lab.html", "mic, tool:voice-lab.*");
    const askOnly = mk("ask.html", "ask");
    const ttsOnly = mk("tts.html", "tool:voice-lab.tts");
    const g = (token: string, path: string, method = "GET", extra: Record<string, unknown> = {}) => liveGateway(vault, null, { token, path, method, ...extra });
    const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
    // a page without the grant gets nothing
    assert.equal((await g(askOnly, "/api/v2/lab/engines")).status, 403);
    assert.equal((await g(lab.slice(0, -2) + "xx", "/api/v2/lab/engines")).status, 401);
    // a narrower grant opens only its own tool
    const r0 = await g(ttsOnly, "/api/v2/lab/engines");
    assert.equal((r0.body as any).status, 403);
    // engines: a plain GET
    const r1 = (await g(lab, "/api/v2/lab/engines")).body as any;
    assert.equal(r1.status, 200);
    assert.equal(Buffer.from(r1.bodyBase64, "base64").toString(), "[]");
    // tts: JSON in, binary audio and the timing headers (only those) out
    const r2 = (await g(lab, "/api/v2/lab/tts", "POST", { headers: { "content-type": "application/json" }, bodyBase64: b64('{"engine":"piper","text":"hi"}') })).body as any;
    assert.equal(r2.status, 200);
    assert.deepEqual(Buffer.from(r2.bodyBase64, "base64"), wav);
    assert.equal(r2.headers["content-type"], "audio/wav");
    assert.equal(r2.headers["x-rtf"], "0.5");
    assert.equal(r2.headers["x-secret"], undefined);
    assert.equal(seen.at(-1)!.method, "POST");
    // stt: engine in the query, audio bytes through
    const audio = Buffer.from(new Uint8Array(5000).map((_, i) => i % 256));
    const r3 = (await g(lab, "/api/v2/lab/stt?engine=whisper-tiny.en", "POST", { headers: { "content-type": "audio/webm" }, bodyBase64: b64(audio) })).body as any;
    assert.equal(r3.status, 200);
    assert.deepEqual({ url: seen.at(-1)!.url, ct: seen.at(-1)!.ct, len: seen.at(-1)!.len }, { url: "/stt?engine=whisper-tiny.en", ct: "audio/webm", len: 5000 });
    // only the fixed operations, methods and parameters
    const before = seen.length;
    for (const [p, m] of [
      ["/api/v2/lab/health", "GET"], ["/api/v2/lab/../x", "GET"], ["/api/v2/lab/", "GET"], ["/api/v2/lab/engines", "POST"], ["/api/v2/lab/tts", "GET"],
      ["/api/v2/lab/stt", "POST"], ["/api/v2/lab/stt?engine=a/b", "POST"], ["/api/v2/lab/stt?engine=a&host=evil", "POST"], ["/api/v2/lab/tts?stream=1", "POST"],
    ] as const) {
      const out = await g(lab, p, m, { bodyBase64: b64("{}") });
      const st = out.status === 200 ? (out.body as any).status : out.status;
      assert.ok([400, 403, 404, 405].includes(st), `${m} ${p} -> ${st}`);
    }
    // absolute URLs and other ports are not paths the gateway forwards anywhere
    for (const p of ["http://127.0.0.1:8857/api/v2/lab/engines", "//evil/api/v2/lab/engines", "/api/v2/lab/engines/../../x"]) assert.notEqual(((await g(lab, p)).body as any)?.status, 200, p);
    assert.equal(seen.length, before, "none of the refused calls reached the service");
    // size limits
    const big = Buffer.alloc(70 * 1024, 1);
    assert.equal(((await g(lab, "/api/v2/lab/tts", "POST", { bodyBase64: b64(big) })).body as any).status, 413);
    // a service that is down is a clear error, not a hang
    const dead = labTarget.port;
    await new Promise((r) => svc.close(r));
    const r5 = (await g(lab, "/api/v2/lab/engines")).body as any;
    assert.equal(r5.status, 502);
    assert.match(Buffer.from(r5.bodyBase64, "base64").toString(), /not reachable/);
    assert.ok(dead > 0);
  } finally {
    labTarget.port = 8871;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vc.tool names only the voice lab and becomes a fetch to its route", () => {
  const src = /<script data-vc-live-script>([\s\S]*?)<\/script>/.exec(liveScript())![1]!;
  const win: any = { innerWidth: 300, innerHeight: 200, document: { documentElement: { style: { setProperty() {} } } }, parent: { postMessage() {} } };
  win.window = win;
  vm.runInNewContext(src, { ...win, window: win, setInterval: () => 1, clearInterval() {}, addEventListener() {}, innerWidth: 300, innerHeight: 200, Promise, Symbol, Headers: class {}, Response: class {}, Blob: class {}, TextEncoder, URLSearchParams, Object });
  const calls: any[] = [];
  win.vc.fetch = (p: string, i: any) => (calls.push([p, i]), Promise.resolve("ok"));
  win.vc.tool("voice-lab.tts", { json: { engine: "piper", text: "hi" } });
  win.vc.tool("voice-lab.stt", { query: { engine: "x" }, body: "b", headers: { "content-type": "audio/wav" } });
  win.vc.tool("voice-lab.engines");
  assert.deepEqual(calls.map((c) => [c[0], c[1].method]), [["/api/v2/lab/tts", "POST"], ["/api/v2/lab/stt?engine=x", "POST"], ["/api/v2/lab/engines", "GET"]]);
  assert.equal(calls[0][1].headers["content-type"], "application/json");
  return win.vc.tool("other.thing").then(() => assert.fail("should reject"), (e: Error) => assert.match(e.message, /unknown tool/));
});

test("one grant prompt per page path + hash, however many frames handshake at once; a decline is remembered", async () => {
  const { installLiveBridge } = await import("../../src/liveBridge.ts");
  const prompts: any[] = [];
  const listeners: Record<string, (e: any) => void> = {};
  const mkFrame = () => {
    const posted: any[] = [];
    const cw = { postMessage: (m: any) => posted.push(m) };
    return { posted, cw, getAttribute: () => "pages/lab.html", contentWindow: cw, rect: { left: 0, top: 0, width: 400, height: 300 }, getBoundingClientRect() { return this.rect; } } as any;
  };
  const frames = [mkFrame(), mkFrame()];
  const mkEl = (): any => {
    const el: any = { style: {}, children: [] as any[], attrs: {} as any, setAttribute(k: string, v: string) { el.attrs[k] = v; }, append(...c: any[]) { el.children.push(...c); }, remove() { el.removed = true; } };
    return el;
  };
  const doc: any = {
    defaultView: {
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
      MutationObserver: class { observe() {} disconnect() {} },
      addEventListener: (k: string, fn: any) => { listeners[k] = fn; },
      removeEventListener() {},
      innerHeight: 800,
    },
    documentElement: { dataset: {} },
    createElement: () => mkEl(),
    body: { append: (b: any) => { if (b.attrs["data-el"] === "live-grant") prompts.push(b); } },
    querySelectorAll: () => frames,
  };
  const host = { post: async (p: string) => (p.endsWith("manifest") ? { status: 200, json: { caps: ["ask"], hash: "h1" } } : { status: 200, json: { token: "t", exp: Date.now() + 600_000 } }) };
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  (globalThis as any).window = { innerHeight: 800 };
  const stop = installLiveBridge(host as any, doc);
  const hello = (f: any) => listeners.message({ data: { "vc-live": 1, op: "hello" }, origin: "null", source: f.cw });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  hello(frames[0]);
  hello(frames[1]);
  hello(frames[0]);
  await tick();
  assert.equal(prompts.length, 1, "two frames, one prompt");
  // Page hidden (another file in the viewer): the prompt hides; it returns with the page.
  frames[0].rect = { left: 0, top: 0, width: 0, height: 0 };
  frames[1].rect = { left: 0, top: 0, width: 0, height: 0 };
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(prompts[0].style.display, "none", "page hidden, prompt hidden");
  frames[1].rect = { left: 5, top: 5, width: 400, height: 300 };
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(prompts[0].style.display, "", "one copy back on screen, prompt back");
  // Not now: nobody asks again, even a fresh handshake from a remounted frame.
  const deny = prompts[0].children[2].children[0];
  deny.onclick();
  await tick();
  const third = mkFrame();
  frames.push(third);
  hello(third);
  hello(frames[1]);
  await tick();
  assert.equal(prompts.length, 1, "no second prompt after Not now");
  stop();
});
