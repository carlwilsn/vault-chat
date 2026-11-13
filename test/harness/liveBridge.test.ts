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

// ---- the service registry (src/liveServices.ts) ----

test("Carl's real pages (html-lab, voice-chat) declare the same grant as before the registry", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseLiveNeeds } = await import("../../src/liveBridge.ts");
  for (const f of ["html-lab.html", "voice-chat.html"]) {
    const html = readFileSync(join(import.meta.dirname, "fixtures", "live-pages", f), "utf8");
    assert.deepEqual(parseLiveManifest(html), ["ask", "mic", "tool:voice-lab.*"], f);
    assert.deepEqual(parseLiveNeeds(html), { caps: ["ask", "mic", "tool:voice-lab.*"], refused: [] }, f);
  }
});

test("the registry: one entry per service, every box route has a handler, every page function exists", async () => {
  const { LIVE_SERVICES, serviceNamed, serviceOfCap, servicesFor } = await import("../../src/liveServices.ts");
  const { HANDLERS } = await import("../../server/liveProxy.ts");
  assert.deepEqual(LIVE_SERVICES.map((s) => s.name), ["ask", "mic", "persist", "voice-lab", "theme", "state", "log", "converse", "catalog"]);
  for (const s of LIVE_SERVICES) {
    assert.ok(s.description.length > 10, s.name);
    if (s.supplier === "box" && s.grantable && s.routes.length) assert.equal(typeof HANDLERS[s.name], "function", `${s.name} has a box handler`);
    if (s.supplier === "host") assert.equal(s.routes.length, 0, `${s.name} is host-side`);
  }
  // persist: an older word kept as it was, declared and described, opening nothing (pages converse through `converse`).
  const persist = serviceNamed("persist")!;
  assert.ok(!persist.grantable && persist.routes.length === 0);
  // The old spellings are aliases of the registered services.
  assert.equal(serviceOfCap("tool:voice-lab.*")?.name, "voice-lab");
  assert.equal(serviceOfCap("tool:voice-lab.tts")?.name, "voice-lab");
  assert.equal(serviceOfCap("tool:other.thing"), null);
  assert.equal(serviceNamed("voice-lab")?.name, "voice-lab");
  assert.deepEqual(servicesFor(["ask", "tool:voice-lab.tts"]).map((s) => s.name), ["ask", "voice-lab", "theme"]);
  // The page script has every function the registry points at.
  const src = /<script data-vc-live-script>([\s\S]*?)<\/script>/.exec(liveScript())![1]!;
  const win: any = { innerWidth: 300, innerHeight: 200, document: { documentElement: { style: { setProperty() {} } } }, parent: { postMessage() {} } };
  vm.runInNewContext(src, { ...win, window: win, setInterval: () => 1, clearInterval() {}, addEventListener() {}, Promise, Symbol, Headers: class {}, Response: class {}, Blob: class {}, TextEncoder });
  for (const s of LIVE_SERVICES) if (s.page) assert.equal(typeof win.vc[s.page], "function", `vc.${s.page} for ${s.name}`);
});

test("an unknown service is refused: dropped from the grant, reported to the page, and the box will not mint it", async () => {
  const { parseLiveNeeds, describeCap } = await import("../../src/liveBridge.ts");
  // registered names and the old spellings are granted; unknown names are refused; noise is dropped
  assert.deepEqual(parseLiveNeeds('<meta name="vc-capabilities" content="ask, calendar, tool:other.x, voice-lab, theme, fs, tool:../x">'), {
    caps: ["ask", "tool:voice-lab.*"],
    refused: ["calendar", "fs", "tool:other.x"],
  });
  assert.deepEqual(parseLiveManifest('<meta name="vc-capabilities" content="tool:other.x">'), [], "an unknown tool is not a grant");
  assert.equal(describeCap("tool:voice-lab.*"), "Use the box's voice lab: text-to-speech and speech-to-text engines running on the box (sends it the text or audio you give the page)");
  // A page that names only unknown services still gets window.vc, to hear what it was refused.
  assert.ok(inlineHtmlDocument('<meta name="vc-capabilities" content="calendar"><p>x</p>', { css: "", live: true }).includes("data-vc-live-script"));
  const dir = mkdtempSync(join(tmpdir(), "live-svc-"));
  const vault = join(dir, "v");
  mkdirSync(vault);
  try {
    writeFileSync(join(vault, "u.html"), '<meta name="vc-capabilities" content="calendar">');
    writeFileSync(join(vault, "m.html"), '<meta name="vc-capabilities" content="ask, calendar">');
    const u = liveManifest(vault, "u.html")!;
    assert.deepEqual([u.caps, u.refused], [[], ["calendar"]]);
    assert.equal(liveToken(vault, { path: "u.html", hash: u.hash, caps: [] }).status, 404, "nothing to grant");
    assert.equal(liveToken(vault, { path: "u.html", hash: u.hash, caps: ["calendar"] }).status, 403, "no token for an unknown service");
    const m = liveManifest(vault, "m.html")!;
    assert.deepEqual([m.caps, m.refused], [["ask"], ["calendar"]]);
    assert.equal(liveToken(vault, { path: "m.html", hash: m.hash, caps: ["ask", "calendar"] }).status, 403);
    assert.equal(liveToken(vault, { path: "m.html", hash: m.hash, caps: ["ask"] }).status, 200, "the known part is granted");
    // A token holding a service this box does not know (registered when minted, gone now): every call is refused.
    const { LIVE_SERVICES } = await import("../../src/liveServices.ts");
    const list = LIVE_SERVICES as any[];
    list.push({ name: "gone", description: "A service that goes away", supplier: "box", routes: [], grantable: true, capOf: (w: string) => (w === "gone" ? "gone" : null), owns: (c: string) => c === "gone" });
    writeFileSync(join(vault, "g.html"), '<meta name="vc-capabilities" content="ask, gone">');
    const gm = liveManifest(vault, "g.html")!;
    const gt = (liveToken(vault, { path: "g.html", hash: gm.hash, caps: gm.caps }).body as { token: string }).token;
    list.pop();
    const out = await liveGateway(vault, null, { token: gt, path: "/api/v1/side/x", method: "GET" });
    assert.deepEqual([out.status, (out.body as any).error], [403, "no such service: gone"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vc.service(name) returns the same functions as vc.ask/vc.tool/vc.mic; vc.services and vc.refused come from the host", () => {
  const src = /<script data-vc-live-script>([\s\S]*?)<\/script>/.exec(liveScript())![1]!;
  let onMsg: ((e: any) => void) | null = null;
  const parent = { postMessage() {} };
  const win: any = { innerWidth: 300, innerHeight: 200, document: { documentElement: { style: { setProperty() {} } } }, parent };
  vm.runInNewContext(src, { ...win, window: win, parent, setInterval: () => 1, clearInterval() {}, addEventListener: (k: string, f: any) => k === "message" && (onMsg = f), Promise, Symbol, Headers: class {}, Response: class {}, Blob: class {}, TextEncoder });
  const vc = win.vc;
  assert.equal(vc.service("ask"), null, "nothing before the host answers");
  assert.equal(JSON.stringify([vc.services, vc.refused]), "[[],[]]"); // arrays from the page's own realm
  onMsg!({ source: parent, data: { "vc-live": 1, ev: "env", caps: ["ask", "tool:voice-lab.*"], services: [{ name: "ask", description: "a" }, { name: "voice-lab", description: "v" }, { name: "theme", description: "t" }], refused: ["calendar"], mode: "dark" } });
  assert.equal(vc.service("ask"), vc.ask);
  assert.equal(vc.service("voice-lab"), vc.tool);
  assert.equal(vc.service("theme"), vc.onTheme);
  assert.equal(vc.service("mic"), null, "not granted");
  assert.equal(vc.service("calendar"), null);
  assert.equal(JSON.stringify(vc.caps), '["ask","tool:voice-lab.*"]');
  assert.equal(JSON.stringify(vc.refused), '["calendar"]');
  assert.equal(vc.services.map((s: any) => s.name).join(), "ask,voice-lab,theme");
});

test("the host: the prompt lists the registry's lines, the grant is remembered per path + hash, a page of unknown services is told without a prompt", async () => {
  const { installLiveBridge } = await import("../../src/liveBridge.ts");
  const listeners: Record<string, (e: any) => void> = {};
  const prompts: any[] = [];
  const mkFrame = (page: string) => {
    const posted: any[] = [];
    const cw = { postMessage: (m: any) => posted.push(m) };
    return { posted, cw, getAttribute: () => page, contentWindow: cw, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) } as any;
  };
  const frames: any[] = [];
  const mkEl = (): any => {
    const el: any = { style: {}, children: [] as any[], attrs: {} as any, textContent: "", setAttribute(k: string, v: string) { el.attrs[k] = v; }, append(...c: any[]) { el.children.push(...c); }, remove() { el.removed = true; } };
    return el;
  };
  const doc: any = {
    defaultView: { getComputedStyle: () => ({ getPropertyValue: () => "" }), MutationObserver: class { observe() {} disconnect() {} }, addEventListener: (k: string, fn: any) => { listeners[k] = fn; }, removeEventListener() {}, innerHeight: 800 },
    documentElement: { dataset: {} },
    createElement: () => mkEl(),
    body: { append: (b: any) => { if (b.attrs["data-el"] === "live-grant") prompts.push(b); } },
    querySelectorAll: () => frames,
  };
  const manifests: Record<string, any> = { "lab.html": { caps: ["ask", "mic", "tool:voice-lab.*"], hash: "h1" }, "u.html": { caps: [], refused: ["calendar"], hash: "h2" } };
  const host = { post: async (p: string, b: any) => (p.endsWith("manifest") ? { status: 200, json: manifests[b.path] } : { status: 200, json: { token: "t", exp: Date.now() + 600_000 } }) };
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  (globalThis as any).window = { innerHeight: 800 };
  const hello = (f: any) => listeners.message({ data: { "vc-live": 1, op: "hello" }, origin: "null", source: f.cw });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  let stop = installLiveBridge(host as any, doc);
  const lab = mkFrame("lab.html");
  frames.push(lab);
  hello(lab);
  await tick();
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].children[1].children.map((li: any) => li.textContent), [
    "Ask the AI questions (read-only; nothing in your vault or chats changes)",
    "Use your microphone while you press its record button",
    "Use the box's voice lab: text-to-speech and speech-to-text engines running on the box (sends it the text or audio you give the page)",
  ]);
  prompts[0].children[2].children[1].onclick(); // Allow
  await tick();
  const env = lab.posted.find((m: any) => m.ev === "env");
  assert.deepEqual(env.caps, ["ask", "mic", "tool:voice-lab.*"]);
  assert.deepEqual(env.services.map((s: any) => s.name), ["ask", "mic", "voice-lab", "theme"]);
  assert.deepEqual(env.refused, []);
  assert.deepEqual(JSON.parse(store["vc-live-grants"]!), { "lab.html|h1": ["ask", "mic", "tool:voice-lab.*"] }, "remembered as before");
  stop();
  // A fresh window: the remembered grant holds, no prompt.
  stop = installLiveBridge(host as any, doc);
  const again = mkFrame("lab.html");
  frames.splice(0, frames.length, again);
  hello(again);
  await tick();
  assert.equal(prompts.length, 1, "no second prompt for the same page and hash");
  assert.ok(again.posted.some((m: any) => m.ev === "env"));
  // Only unknown services: told so, no prompt, no token, no calls.
  const u = mkFrame("u.html");
  frames.push(u);
  hello(u);
  await tick();
  assert.equal(prompts.length, 1, "nothing to allow");
  const uenv = u.posted.find((m: any) => m.ev === "env");
  assert.deepEqual([uenv.caps, uenv.refused, uenv.services.map((s: any) => s.name)], [[], ["calendar"], ["theme"]]);
  listeners.message({ data: { "vc-live": 1, op: "fetch", id: 1, path: "/api/v1/side", method: "GET" }, origin: "null", source: u.cw });
  await tick();
  assert.match(u.posted.find((m: any) => m.id === 1)?.error ?? "", /not been allowed/);
  stop();
});

// ---- change 1.2: the state and log services ----

test("state and log are registered services: declared, described, granted under their names", async () => {
  const { parseLiveNeeds, describeCap } = await import("../../src/liveBridge.ts");
  const { serviceNamed, servicesFor } = await import("../../src/liveServices.ts");
  assert.deepEqual(parseLiveNeeds('<meta name="vc-capabilities" content="state, log, ask">'), { caps: ["ask", "log", "state"], refused: [] });
  assert.deepEqual(parseLiveNeeds('<meta name="vc-capabilities" content="State">'), { caps: ["state"], refused: [] });
  assert.equal(describeCap("state"), "Keep its own saved state on the box (the same in every place the page is open)");
  assert.equal(describeCap("log"), "Add records of what it does to your vault's log");
  assert.deepEqual(servicesFor(["state"]).map((s) => s.name), ["theme", "state"]);
  const state = serviceNamed("state")!;
  const ok = (m: "GET" | "POST", p: string) => state.routes.some((r) => r.methods.includes(m) && r.path.test(p));
  assert.ok(ok("GET", "/api/v2/plugin/state") && ok("GET", "/api/v2/plugin/state?after=3&wait=20000") && ok("POST", "/api/v2/plugin/state"));
  assert.ok(!ok("POST", "/api/v2/plugin/state?x=1") && !ok("GET", "/api/v2/plugin/state/../log") && !ok("GET", "/api/v2/plugin/states"));
});

test("vc.state and vc.log are fetches to the page's own routes; subscribe hears each change once and stops when told", async () => {
  const src = /<script data-vc-live-script>([\s\S]*?)<\/script>/.exec(liveScript())![1]!;
  let onMsg: ((e: any) => void) | null = null;
  const parent = { postMessage() {} };
  const win: any = { innerWidth: 300, innerHeight: 200, document: { documentElement: { style: { setProperty() {} } } }, parent };
  vm.runInNewContext(src, { ...win, window: win, parent, setInterval: () => 1, clearInterval() {}, setTimeout, addEventListener: (k: string, f: any) => k === "message" && (onMsg = f), Promise, Symbol, Headers: class {}, Response: class {}, Blob: class {}, TextEncoder, JSON, Error });
  const vc = win.vc;
  const calls: [string, any][] = [];
  let st: { seq: number; state: any } = { seq: 0, state: {} };
  const waiters: (() => void)[] = [];
  const resp = (status: number, j: any) => ({ ok: status < 300, status, json: async () => j });
  vc.fetch = async (p: string, i: any = {}) => {
    calls.push([p, i]);
    if (p === "/api/v2/plugin/state" && i.method === "POST") {
      const b = JSON.parse(i.body);
      st = { seq: st.seq + 1, state: { ...st.state, [b.key]: b.value } };
      waiters.splice(0).forEach((w) => w());
      return resp(200, { ok: true, seq: st.seq });
    }
    if (p.startsWith("/api/v2/plugin/state")) {
      const after = Number(/after=(-?\d+)/.exec(p)?.[1] ?? NaN);
      if (after === st.seq) await new Promise<void>((r) => waiters.push(r));
      return resp(200, st);
    }
    if (p === "/api/v2/plugin/log") return resp(200, { ok: true, seq: 99 });
    return resp(403, { error: "this page was not allowed to do that" });
  };
  onMsg!({ source: parent, data: { "vc-live": 1, ev: "env", caps: ["log", "state"], services: [{ name: "theme" }, { name: "state" }, { name: "log" }], refused: [], mode: "dark" } });
  assert.equal(vc.service("state"), vc.state);
  assert.equal(vc.service("log"), vc.log);
  assert.equal(vc.log.append, vc.log);
  const heard: any[] = [];
  const stop = vc.state.subscribe((s: any, seq: number) => heard.push([seq, JSON.stringify(s)]));
  const tick = () => new Promise((r) => setTimeout(r, 5));
  await tick();
  assert.deepEqual(heard, [[0, "{}"]], "the current state at once");
  assert.equal(await vc.state.set("count", 1), 1);
  await tick();
  assert.equal(await vc.state.set("count", 2), 2);
  await tick();
  assert.deepEqual(heard, [[0, "{}"], [1, '{"count":1}'], [2, '{"count":2}']]);
  assert.equal(await vc.state.get("count"), 2);
  assert.equal(JSON.stringify(await vc.state()), '{"count":2}');
  stop();
  await vc.state.set("count", 3);
  await tick();
  assert.equal(heard.length, 3, "nothing after unsubscribe");
  assert.equal(await vc.log({ did: "click" }), 99);
  const posts = calls.filter(([, i]) => i.method === "POST").map(([p, i]) => [p, i.body, i.headers["content-type"]]);
  assert.deepEqual(posts, [
    ["/api/v2/plugin/state", '{"key":"count","value":1}', "application/json"],
    ["/api/v2/plugin/state", '{"key":"count","value":2}', "application/json"],
    ["/api/v2/plugin/state", '{"key":"count","value":3}', "application/json"],
    ["/api/v2/plugin/log", '{"did":"click"}', "application/json"],
  ]);
  assert.ok(calls.some(([p]) => p === "/api/v2/plugin/state?after=-1&wait=20000"));
  // A refused call rejects with the box's reason.
  vc.fetch = async () => resp(403, { error: "this page was not allowed to do that" });
  await assert.rejects(vc.state.set("k", 1), /not allowed/);
  await assert.rejects(vc.log("x"), /not allowed/);
});

// ---- change 1.3: the converse service ----

test("converse is a registered service: declared, described, granted under its name, with only its routes", async () => {
  const { parseLiveNeeds, describeCap } = await import("../../src/liveBridge.ts");
  const { serviceNamed, servicesFor } = await import("../../src/liveServices.ts");
  assert.deepEqual(parseLiveNeeds('<meta name="vc-capabilities" content="converse, ask">'), { caps: ["ask", "converse"], refused: [] });
  // The older `persist` is unchanged: its own word, not converse.
  assert.deepEqual(parseLiveNeeds('<meta name="vc-capabilities" content="persist">'), { caps: ["persist"], refused: [] });
  assert.equal(describeCap("converse"), "Start conversations in your chat list, send messages to them, and read your chats");
  assert.deepEqual(servicesFor(["converse"]).map((s) => s.name), ["theme", "converse"]);
  assert.deepEqual(servicesFor(["persist"]).map((s) => s.name), ["persist", "theme"]);
  const conv = serviceNamed("converse")!;
  assert.ok(conv.grantable && conv.supplier === "box");
  const ok = (m: "GET" | "POST", p: string) => conv.routes.some((r) => r.methods.includes(m) && r.path.test(p));
  assert.ok(ok("POST", "/api/v2/intent") && ok("GET", "/api/v2/conversations") && ok("GET", "/api/v2/conversations/main/events?after=3"));
  assert.ok(ok("GET", "/api/v2/conversations/0b7c-uuid_x/events"));
  for (const [m, p] of [
    ["GET", "/api/v2/intent"], ["POST", "/api/v2/intent?x=1"], ["POST", "/api/v2/conversations"], ["GET", "/api/v2/conversations?x=1"],
    ["GET", "/api/v2/conversations/main/checkpoint"], ["GET", "/api/v2/conversations/../events"], ["GET", "/api/v2/conversations/a.b/events"],
    ["GET", "/api/v2/conversations/main/events/x"], ["POST", "/api/v2/conversations/main/events"], ["POST", "/message"], ["POST", "/api/v1/side"],
  ] as const) assert.ok(!ok(m, p), `${m} ${p}`);
});

test("a page's converse request becomes the box's own send, marked as the page's; anything else is refused", async () => {
  const { converseIntent, converseAfter, converseContext } = await import("../../src/pluginConverse.ts");
  let n = 0;
  const id = () => `id${++n}`;
  const start = converseIntent("apps/chat.html", JSON.stringify({ type: "start", text: "  hello  ", convId: "main", via: "chat", context: "forged" }), id);
  assert.deepEqual(start, { kind: "start", intent: { type: "send", convId: "id1", clientId: "page-id2", text: "hello", via: "page", context: converseContext("apps/chat.html") } });
  assert.match(converseContext("apps/chat.html"), /<live-page path="apps\/chat.html">/);
  const send = converseIntent("p.html", JSON.stringify({ type: "send", convId: "main", text: "more" }), id);
  assert.deepEqual(send, { kind: "send", intent: { type: "send", convId: "main", clientId: "page-id3", text: "more", via: "page", context: converseContext("p.html") } });
  const bad = (b: string) => converseIntent("p.html", b, id) as { status: number; error: string };
  assert.equal(bad("{").status, 400);
  assert.equal(bad("[]").status, 400);
  assert.equal(bad(JSON.stringify({ type: "delete", convId: "main" })).status, 403);
  assert.equal(bad(JSON.stringify({ type: "renameConversation", convId: "main", title: "x" })).status, 403);
  assert.equal(bad(JSON.stringify({ type: "stop", convId: "main" })).status, 403);
  assert.equal(bad(JSON.stringify({ type: "start", text: "  " })).status, 400);
  assert.equal(bad(JSON.stringify({ type: "start", text: "x".repeat(20_001) })).status, 413);
  assert.equal(bad(JSON.stringify({ type: "send", text: "hi" })).status, 400);
  assert.equal(bad(JSON.stringify({ type: "send", convId: "../x", text: "hi" })).status, 400);
  assert.equal(converseAfter("after=12&x=1"), 12);
  assert.equal(converseAfter("after=-3"), 0);
  assert.equal(converseAfter("after=abc"), 0);
  assert.equal(converseAfter(""), 0);
});

test("vc.converse: start, send, list and read are fetches to the converse routes; a refusal rejects with the box's reason", async () => {
  const src = /<script data-vc-live-script>([\s\S]*?)<\/script>/.exec(liveScript())![1]!;
  let onMsg: ((e: any) => void) | null = null;
  const parent = { postMessage() {} };
  const win: any = { innerWidth: 300, innerHeight: 200, document: { documentElement: { style: { setProperty() {} } } }, parent };
  vm.runInNewContext(src, { ...win, window: win, parent, setInterval: () => 1, clearInterval() {}, setTimeout, addEventListener: (k: string, f: any) => k === "message" && (onMsg = f), Promise, Symbol, Headers: class {}, Response: class {}, Blob: class {}, TextEncoder, JSON, Error, Math, Number });
  const vc = win.vc;
  const calls: [string, any][] = [];
  const resp = (status: number, j: any) => ({ ok: status < 300, status, json: async () => j });
  vc.fetch = async (p: string, i: any = {}) => {
    calls.push([p, i]);
    if (p === "/api/v2/intent") {
      const b = JSON.parse(i.body);
      return resp(200, { ok: true, convId: b.convId ?? "new-1" });
    }
    if (p === "/api/v2/conversations") return resp(200, { rows: [{ id: "new-1", title: "hello" }], seq: 4 });
    if (p.startsWith("/api/v2/conversations/")) return resp(200, { events: [{ seq: 3 }], next: 4 });
    return resp(403, { error: "this page was not allowed to do that" });
  };
  onMsg!({ source: parent, data: { "vc-live": 1, ev: "env", caps: ["converse"], services: [{ name: "theme" }, { name: "converse" }], refused: [], mode: "dark" } });
  assert.equal(vc.service("converse"), vc.converse);
  assert.equal((await vc.converse.start("hello")).convId, "new-1");
  assert.equal((await vc.converse("again")).convId, "new-1");
  assert.equal((await vc.converse.send("new-1", "more")).convId, "new-1");
  assert.deepEqual(JSON.parse(JSON.stringify(await vc.converse.list())), [{ id: "new-1", title: "hello" }]);
  assert.equal((await vc.converse.read("new-1", { after: 2 })).next, 4);
  await vc.converse.read("a b");
  assert.deepEqual(calls.map(([p, i]) => [p, i.method ?? "GET", i.body ?? null]), [
    ["/api/v2/intent", "POST", '{"type":"start","text":"hello"}'],
    ["/api/v2/intent", "POST", '{"type":"start","text":"again"}'],
    ["/api/v2/intent", "POST", '{"type":"send","convId":"new-1","text":"more"}'],
    ["/api/v2/conversations", "GET", null],
    ["/api/v2/conversations/new-1/events?after=2", "GET", null],
    ["/api/v2/conversations/a%20b/events?after=0", "GET", null],
  ]);
  vc.fetch = async () => resp(403, { error: "this page was not allowed to do that" });
  await assert.rejects(vc.converse.start("x"), /not allowed/);
  await assert.rejects(vc.converse.list(), /not allowed/);
});

// ---- change 1.4: the catalog service ----

test("catalog is a registered service: declared, described, granted under its name, with only its one read route", async () => {
  const { parseLiveNeeds, describeCap } = await import("../../src/liveBridge.ts");
  const { serviceNamed, servicesFor } = await import("../../src/liveServices.ts");
  assert.deepEqual(parseLiveNeeds('<meta name="vc-capabilities" content="Catalog, ask">'), { caps: ["ask", "catalog"], refused: [] });
  assert.deepEqual(parseLiveNeeds('<meta name="vc-capabilities" content="catalogue, catalog:x">'), { caps: [], refused: ["catalog:x", "catalogue"] });
  assert.match(describeCap("catalog"), /services pages can use and the plugin pages in your vault/);
  assert.deepEqual(servicesFor(["catalog"]).map((s) => s.name), ["theme", "catalog"]);
  const cat = serviceNamed("catalog")!;
  assert.ok(cat.grantable && cat.supplier === "box" && cat.page === "catalog");
  const ok = (m: "GET" | "POST", p: string) => cat.routes.some((r) => r.methods.includes(m) && r.path.test(p));
  assert.ok(ok("GET", "/api/v2/plugin/catalog"));
  for (const [m, p] of [["POST", "/api/v2/plugin/catalog"], ["GET", "/api/v2/plugin/catalog?x=1"], ["GET", "/api/v2/plugin/catalog/x"], ["GET", "/api/v2/plugin/state"], ["GET", "/api/v2/conversations"]] as const)
    assert.ok(!ok(m, p), `${m} ${p}`);
});

test("the catalog lists every registered service, and reads a page's manifest as a plugin (name, mount, needs)", async () => {
  const { catalogServices, catalogPlugin, catalogText } = await import("../../src/pluginCatalog.ts");
  const { LIVE_SERVICES } = await import("../../src/liveServices.ts");
  const services = catalogServices();
  assert.deepEqual(services.map((s) => s.name), LIVE_SERVICES.map((s) => s.name));
  assert.deepEqual(services.find((s) => s.name === "ask"), { name: "ask", description: LIVE_SERVICES[0]!.description, supplier: "box", grantable: true, always: false, call: "vc.ask" });
  assert.equal(services.find((s) => s.name === "voice-lab")!.call, "vc.tool");
  assert.ok(services.find((s) => s.name === "theme")!.always && services.find((s) => s.name === "mic")!.supplier === "host");
  assert.ok(!services.find((s) => s.name === "persist")!.grantable && services.find((s) => s.name === "persist")!.call === null);
  // A page with services: its needs by service name (voice-lab's tool: spelling read back as voice-lab), unknown ones kept apart.
  assert.deepEqual(catalogPlugin("apps/lab.html", '<title> Voice &amp; <b>lab</b> </title><meta name="vc-capabilities" content="ask, tool:voice-lab.*, voice-lab, theme, fs">'), {
    id: "apps/lab.html", name: "Voice & lab", mount: "iframe", needs: ["ask", "voice-lab"], refused: ["fs"], pinned: false,
  });
  // An in-process page (change 1.5) needs nothing and is still a plugin; no title: its file name.
  assert.deepEqual(catalogPlugin("./w\\clock.html", '<meta name="vc-mount" content="in-process"><script type="module">export function mount(){}</script>'), {
    id: "w/clock.html", name: "clock.html", mount: "in-process", needs: [], refused: [], pinned: false,
  });
  assert.equal(catalogPlugin("x.html", '<meta name=vc-mount content=sideways>')!.mount, "iframe");
  assert.equal(catalogPlugin("x.html", '<meta name="vc-capabilities" content="">')!.needs.length, 0);
  // Not plugins: no manifest, or another meta.
  assert.equal(catalogPlugin("a.html", "<title>a</title><p>plain</p>"), null);
  assert.equal(catalogPlugin("a.html", '<meta name="viewport" content="ask">'), null);
  const text = catalogText({ services, plugins: [catalogPlugin("apps/lab.html", '<title>Lab</title><meta name="vc-capabilities" content="ask, fs">')!] });
  assert.match(text, /^Services a page can name/);
  assert.match(text, /- ask \(the box; Carl allows it once per page; vc\.ask\): /);
  assert.match(text, /- theme \(the app\/phone; every page has it, no grant; vc\.onTheme\)/);
  assert.match(text, /- persist \(the box; declared, opens nothing\)/);
  assert.match(text, /Plugins in this vault \(1\)/);
  assert.match(text, /- apps\/lab\.html "Lab": iframe; needs ask; unknown: fs/);
  assert.match(catalogText({ services, plugins: [], truncated: true }), /\(0, list cut short\)[^\n]*\n- none$/);
  const { catalogReads } = await import("../../src/pluginCatalog.ts");
  for (const p of ["a.html", "A/b.HTM", ".vault-chat/visuals/x.html", ".vault-chat/visuals/sub/x.html", "notes/vault-chat/a.html"]) assert.ok(catalogReads(p), p);
  for (const p of ["a.md", ".vault-chat/x.html", ".vault-chat/conversations/x.html", ".git/x.html", "a/.hidden/x.html", "a/node_modules/x.html", "build/x.html"]) assert.ok(!catalogReads(p), p);
});

test("vc.catalog is a fetch to the catalog route; a refusal rejects with the box's reason", async () => {
  const src = /<script data-vc-live-script>([\s\S]*?)<\/script>/.exec(liveScript())![1]!;
  let onMsg: ((e: any) => void) | null = null;
  const parent = { postMessage() {} };
  const win: any = { innerWidth: 300, innerHeight: 200, document: { documentElement: { style: { setProperty() {} } } }, parent };
  vm.runInNewContext(src, { ...win, window: win, parent, setInterval: () => 1, clearInterval() {}, setTimeout, addEventListener: (k: string, f: any) => k === "message" && (onMsg = f), Promise, Symbol, Headers: class {}, Response: class {}, Blob: class {}, TextEncoder, JSON, Error, Math, Number });
  const vc = win.vc;
  const calls: [string, any][] = [];
  const resp = (status: number, j: any) => ({ ok: status < 300, status, json: async () => j });
  vc.fetch = async (p: string, i: any = {}) => {
    calls.push([p, i]);
    return p === "/api/v2/plugin/catalog" ? resp(200, { services: [{ name: "ask" }], plugins: [{ id: "a.html" }] }) : resp(403, { error: "no" });
  };
  onMsg!({ source: parent, data: { "vc-live": 1, ev: "env", caps: ["catalog"], services: [{ name: "theme" }, { name: "catalog" }], refused: [], mode: "dark" } });
  assert.equal(vc.service("catalog"), vc.catalog);
  const c = await vc.catalog();
  assert.deepEqual(JSON.parse(JSON.stringify(c)), { services: [{ name: "ask" }], plugins: [{ id: "a.html" }] });
  assert.deepEqual(calls.map(([p, i]) => [p, i?.method ?? "GET"]), [["/api/v2/plugin/catalog", "GET"]]);
  vc.fetch = async () => resp(403, { error: "this page was not allowed to do that" });
  await assert.rejects(vc.catalog(), /not allowed/);
});

test("the box's catalog walks the vault: pages in folders and .vault-chat/visuals, not other hidden or dependency folders", async () => {
  const { pluginCatalog } = await import("../../server/pluginCatalog.ts");
  const dir = mkdtempSync(join(tmpdir(), "vc-catalog-"));
  try {
    const put = (rel: string, html: string) => {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), html);
    };
    put(".vault-chat/visuals/html-lab.html", '<title>HTML lab</title><meta name="vc-capabilities" content="ask, voice-lab">');
    put(".vault-chat/visuals/plain.html", "<p>a picture, no manifest</p>");
    put("Apps/clock.htm", '<meta name="vc-mount" content="in-process">');
    put("Apps/notes.md", '<meta name="vc-capabilities" content="ask">');
    put("a.html", '<meta name="vc-capabilities" content="state, catalog">');
    put(".vault-chat/conversations/x.html", '<meta name="vc-capabilities" content="ask">');
    put(".vault-chat/top.html", '<meta name="vc-capabilities" content="ask">');
    put(".git/x.html", '<meta name="vc-capabilities" content="ask">');
    put(".hidden/x.html", '<meta name="vc-capabilities" content="ask">');
    put("proj/node_modules/pkg/x.html", '<meta name="vc-capabilities" content="ask">');
    const c = pluginCatalog(dir);
    assert.equal(c.truncated, undefined);
    assert.deepEqual(c.services.map((s) => s.name), ["ask", "mic", "persist", "voice-lab", "theme", "state", "log", "converse", "catalog"]);
    assert.deepEqual(c.plugins, [
      { id: ".vault-chat/visuals/html-lab.html", name: "HTML lab", mount: "iframe", needs: ["ask", "voice-lab"], refused: [], pinned: false },
      { id: "Apps/clock.htm", name: "clock.htm", mount: "in-process", needs: [], refused: [], pinned: false },
      { id: "a.html", name: "a.html", mount: "iframe", needs: ["catalog", "state"], refused: [], pinned: false },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
