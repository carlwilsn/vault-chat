// RecordUI: a short video of a page working, for the agent to put in its reply as proof (`![…](x.mp4)` plays
// inline in the chat on the laptop and the phone) — and the agent's hands for testing a web UI (its own dev server,
// vault-chat's frontend in the preview harness): real input, what the page showed and threw, a screenshot to look at.
//
// No ffmpeg and nothing new on the box: the box's own headless Chromium (server/headless.ts, muted) is driven
// over the DevTools protocol — real mouse and keyboard input for the steps — and its screencast frames are
// encoded by the same browser (WebCodecs: H.264 when it has it, else VP8), then put in an MP4 or WebM file here
// (small ISO-BMFF and EBML writers). MP4/H.264 is what an iPhone plays.
//
// The tool runs the recorder as a child of this same bundle (`vault-chat-server.mjs record-ui`) inside the
// agent's command sandbox (server/vaultTools.ts runSandboxed): the browser sees what the agent's shell sees and
// no more, and a `run` step is a command in that sandbox.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { openPage } from "./headless";
import { runSandboxed } from "./vaultTools";

export type Step =
  | { wait: number }
  | { click: string | { text: string } | { x: number; y: number } }
  | { hover: string | { text: string } | { x: number; y: number } }
  | { shot: string }
  | { type: string; into?: string }
  | { press: string }
  | { scroll: number }
  | { goto: string }
  | { waitFor: string | { text: string }; timeout?: number }
  | { run: string };

export type RecordArgs = { url?: string; steps?: Step[]; seconds?: number; out?: string; width?: number; height?: number; mobile?: boolean };
/** `shots`: PNGs the steps asked for, and the last screen (`<video>.png`). `errors`: what the page threw or logged as an error. `text`: its visible text at the end. */
export type RecordOut =
  | { ok: true; path: string; seconds: number; frames: number; bytes: number; width: number; height: number; log: string[]; shots: string[]; errors: string[]; text: string; failed: boolean }
  | { ok: false; error: string; log?: string[] };

export const RECORD_DESCRIPTION =
  "Use a web page with real mouse and keyboard in a muted headless browser on the box, and record it as a short video (MP4): to test a web UI you are building " +
  "(the dev server you started with StartJob, http://localhost:5173; vault-chat's own frontend in its preview harness, http://localhost:1500/after/?scenario=…; an HTML file in your working folder) and to prove to Carl that it works. " +
  "steps run in order, each followed by a short pause so the video shows its effect: " +
  '{"click": "css selector"} or {"click": {"text": "Save"}} or {"click": {"x": 200, "y": 120}}, {"hover": …the same}, {"type": "hello", "into": "#name"}, {"press": "Enter"} (or "Control+K", "Shift+Tab", "a"), {"scroll": 600}, ' +
  '{"wait": 1000}, {"waitFor": "css selector"} or {"waitFor": {"text": "Done"}} (an assertion: it fails the run when it never appears), {"goto": "url"}, {"shot": "name"} (a screenshot you can read), {"run": "shell command"} (in your sandbox, in your working folder: e.g. an edit, to film hot reload). ' +
  "Elements inside same-origin iframes are found too. mobile: true for a phone-sized touch view (390×844). seconds: the least length of the video (default 4, at most 90). " +
  "Returns: each step's outcome (the first failing step stops the run), errors the page threw or logged, its visible text at the end, screenshots (read them to see the result), and the video's path. " +
  "Put the video in your reply as ![what it shows](path): it plays inline in the chat on his laptop and phone. Say what it shows in a line; claim only what the steps, text and screenshots show.";

export const RECORD_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "http(s) address to open, e.g. http://localhost:5173 (a vault .html file: its path)." },
    steps: { type: "array", items: { type: "object" }, description: "What to do on the page, in order (see the tool's description)." },
    seconds: { type: "number", description: "Least length in seconds (default 4, max 90)." },
    out: { type: "string", description: "Where to write the video, relative to the vault (default .vault-chat/visuals/recording-<time>.mp4; .webm on a browser without H.264); the chat shows a video in the vault." },
    mobile: { type: "boolean", description: "A phone-sized touch view (390×844, unless width/height say otherwise)." },
    width: { type: "number", description: "Viewport width in px (default 1280)." },
    height: { type: "number", description: "Viewport height in px (default 800)." },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEP_PAUSE_MS = 700;
const MAX_SECONDS = 90;

/** External clients receive browser input, not the native turn's shell authority. */
export function browserOnlyError(a: RecordArgs): string | null {
  const http = (value: unknown) => {
    if (typeof value !== "string") return false;
    try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
  };
  if (!http(a.url)) return "External RecordUI requires an http(s) URL without credentials; local file navigation is unavailable.";
  if (a.steps !== undefined && !Array.isArray(a.steps)) return "RecordUI steps must be an array.";
  const actions = ["wait", "click", "hover", "shot", "type", "press", "scroll", "goto", "waitFor"];
  for (const s of a.steps ?? []) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return "Invalid browser step.";
    if ("run" in s) return "External RecordUI does not allow run steps or shell commands.";
    const keys = Object.keys(s);
    const action = actions.filter((k) => k in s);
    if (action.length !== 1 || keys.some((k) => !actions.includes(k) && !(k === "into" && action[0] === "type") && !(k === "timeout" && action[0] === "waitFor"))) return "External RecordUI requires one browser action per step; unknown step fields are refused.";
    if ("goto" in s && !http(s.goto)) return "External RecordUI goto requires an http(s) URL without credentials.";
  }
  return null;
}

type Frame = { data: string; t: number };

// ---------------------------------------------------------------- the recording (runs in the sandbox)

/** Record `a.url` with its steps into `cwd`-relative `a.out` (a .webm). */
export async function record(cwd: string, a: RecordArgs, vault = cwd, browserOnly = false): Promise<RecordOut> {
  if (browserOnly) {
    const why = browserOnlyError(a);
    if (why) return { ok: false, error: why };
  }
  const log: string[] = [];
  const url = String(a.url ?? "").trim();
  let target: string;
  if (/^https?:\/\//i.test(url)) target = url;
  else if (url && /\.html?$/i.test(url)) target = pathToFileURL(resolve(cwd, url)).href;
  else return { ok: false, error: "url must be an http(s) address (e.g. http://localhost:5173) or a vault .html file" };
  const mobile = a.mobile === true;
  const w = clampInt(a.width, mobile ? 390 : 1280, 320, 1920) & ~1;
  const h = clampInt(a.height, mobile ? 844 : 800, 320, 1600) & ~1;
  const least = Math.min(MAX_SECONDS, Math.max(1, Number(a.seconds) || 4));
  // The video goes in the vault (the chat shows a vault file), whatever folder the steps run in.
  const out = outPath(vault, a.out);
  if (typeof out !== "string") return { ok: false, error: out.error };
  const steps = Array.isArray(a.steps) ? a.steps : [];

  const page = await openPage(w, h);
  const frames: Frame[] = [];
  const errors: string[] = [];
  const shots: string[] = [];
  let failed = false;
  try {
    await page.call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    if (mobile) await page.call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }).catch(() => {});
    await page.call("Page.enable");
    // External recordings cannot reach local files through links, redirects or
    // subresources either. Encoding's own trusted file is opened only after
    // the page's final capture, when interception is removed below.
    if (browserOnly) {
      page.on("Fetch.requestPaused", (p: any) => {
        const protocol = String(p.request?.url ?? "").split(":")[0]?.toLowerCase();
        const method = ["http", "https", "data", "blob", "about"].includes(protocol ?? "") ? "Fetch.continueRequest" : "Fetch.failRequest";
        void page.call(method, { requestId: p.requestId, ...(method === "Fetch.failRequest" ? { errorReason: "BlockedByClient" } : {}) }).catch(() => {});
      });
      await page.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    }
    await page.call("Runtime.enable");
    await page.call("Log.enable").catch(() => {});
    const err = (m: string) => errors.length < 30 && errors.push(m.slice(0, 400));
    page.on("Runtime.exceptionThrown", (p: any) => err(`uncaught: ${p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? "error"}`));
    page.on("Runtime.consoleAPICalled", (p: any) => {
      if (p?.type === "error") err(`console.error: ${(p.args ?? []).map((x: any) => x?.value ?? x?.description ?? "").join(" ")}`);
    });
    page.on("Log.entryAdded", (p: any) => {
      if (p?.entry?.level === "error") err(`${p.entry.source}: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ""}`);
    });
    // An alert / confirm / prompt would hold the page (and every call to it): accepted, and said.
    page.on("Page.javascriptDialogOpening", (p: any) => {
      log.push(`a ${p?.type ?? "dialog"} said "${String(p?.message ?? "").slice(0, 200)}": accepted`);
      page.call("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    });
    const shotsDir = out.replace(/(\.(mp4|webm))?$/i, "") + "-shots";
    page.on("Page.screencastFrame", (p: any) => {
      frames.push({ data: p.data, t: Number(p.metadata?.timestamp) * 1000 || Date.now() });
      page.call("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    });
    await page.call("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: w, maxHeight: h, everyNthFrame: 1 });
    const t0 = Date.now();
    await navigate(page, target, log);
    await sleep(STEP_PAUSE_MS);
    for (const [i, s] of steps.entries()) {
      try {
        await step(page, s, cwd, log, async (name) => {
          const f = join(shotsDir, `${String(shots.length + 1).padStart(2, "0")}-${String(name).replace(/[^\w.-]+/g, "-").slice(0, 40) || "shot"}.png`);
          await savePng(page, f);
          shots.push(f);
          return f;
        });
      } catch (e) {
        failed = true;
        log.push(`step ${i + 1} ${JSON.stringify(s).slice(0, 120)} failed: ${(e as Error).message}`);
        await sleep(STEP_PAUSE_MS);
        break;
      }
      await sleep(STEP_PAUSE_MS);
    }
    const left = least * 1000 - (Date.now() - t0);
    await sleep(Math.max(800, left));
    await page.call("Page.stopScreencast").catch(() => {});
    await sleep(150);
    if (!frames.length) return { ok: false, error: "the page never painted (no frames came)", log };
    const end = Date.now();
    const finalPng = (await page.call("Page.captureScreenshot", { format: "png" }).catch(() => null))?.data as string | undefined;
    const text = String((await evalJs(page, "(document.body && document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 3000)").catch(() => "")) ?? "");
    // The last picture holds to the end (a page that stopped changing sends no frames).
    const shot = await page.call("Page.captureScreenshot", { format: "jpeg", quality: 85 }).catch(() => null);
    const last: Frame = { data: shot?.data ?? frames[frames.length - 1]!.data, t: Math.max(end, frames[frames.length - 1]!.t + 100) };
    const all = [...frames, last];
    const startT = all[0]!.t;
    // MP4 (H.264) plays everywhere, the iPhone included; WebM (VP8) where this browser has no H.264 encoder.
    const want: "mp4" | "webm" = /\.webm$/i.test(out) ? "webm" : "mp4";
    if (browserOnly) {
      // Destroy the untrusted page before lifting its local-file restriction.
      await navigate(page, "about:blank", []);
      await page.call("Fetch.disable");
    }
    const enc = await encode(page, all.map((f) => ({ data: f.data, t: f.t - startT })), w, h, want);
    const durMs = last.t - startT;
    const file = enc.kind === "mp4" ? mp4(enc.chunks, w, h, durMs, enc.description!) : webm(enc.chunks, w, h, durMs);
    const path = out.replace(/(\.(mp4|webm))?$/i, "." + enc.kind);
    if (enc.kind !== want && /\.(mp4|webm)$/i.test(out)) log.push(`this browser cannot encode ${want === "mp4" ? "H.264" : "VP8"}: written as .${enc.kind}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file);
    if (finalPng) {
      // The last screen, as a PNG beside the video (the agent reads it to see the result).
      const png = path.replace(/\.(mp4|webm)$/i, ".png");
      writeFileSync(png, Buffer.from(finalPng, "base64"));
      shots.push(png);
    }
    return { ok: true, path, seconds: Math.round(durMs / 100) / 10, frames: all.length, bytes: file.length, width: w, height: h, log, shots, errors, text, failed };
  } finally {
    await page.close();
  }
}

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, n)) : def;
}

function outPath(cwd: string, o: unknown): string | { error: string } {
  // Without an extension the format is chosen at encoding (.mp4 when the browser has H.264, else .webm).
  const rel = typeof o === "string" && o.trim() ? o.trim() : `.vault-chat/visuals/recording-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  if (/\.[a-z0-9]{2,4}$/i.test(rel) && !/\.(webm|mp4)$/i.test(rel)) return { error: "out must end in .mp4 or .webm (or have no extension: .mp4 when this browser can make one)" };
  const abs = isAbsolute(rel) ? rel : resolve(cwd, rel);
  const r = relative(resolve(cwd), abs);
  if (r.startsWith("..") || isAbsolute(r)) return { error: "out must be inside the vault" };
  return abs;
}

type Pg = Awaited<ReturnType<typeof openPage>>;

async function navigate(page: Pg, url: string, log: string[]): Promise<void> {
  const loaded = new Promise<void>((res) => page.on("Page.loadEventFired", () => res()));
  const r = await page.call("Page.navigate", { url });
  if (r?.errorText) throw new Error(`could not open ${url}: ${r.errorText}`);
  await Promise.race([loaded, sleep(15_000)]);
  log.push(`opened ${url}`);
}

async function evalJs(page: Pg, expression: string): Promise<any> {
  const r = await page.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300));
  return r?.result?.value;
}

type Target = string | { text: string } | { x: number; y: number };

/** The centre of the element a selector or a text names (scrolled into view), in the page's coordinates, or null.
 *  Same-origin iframes are searched too (vault-chat's preview harness shows the app in one). */
function findJs(what: Target): string {
  const sel = typeof what === "string" ? what : null;
  const text = typeof what === "object" && what && "text" in what ? String(what.text ?? "") : "";
  return `(function(sel, text){
    var norm = function(s){ return (s || '').replace(/\\s+/g, ' ').trim(); };
    var visible = function(e){ var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    function inDoc(doc){
      var el = null;
      if (sel) { try { el = doc.querySelector(sel); } catch (e) { throw new Error('bad selector ' + sel); } }
      if (!el && text) {
        var all = Array.prototype.slice.call(doc.querySelectorAll('button,a,input,textarea,select,label,summary,[role=button],[role=menuitem],[role=tab],[onclick],h1,h2,h3,h4,p,span,div,li,td')).filter(visible);
        el = all.find(function(e){ return norm(e.innerText) === text || e.value === text || e.getAttribute('aria-label') === text || e.getAttribute('title') === text || e.getAttribute('placeholder') === text; })
          || all.filter(function(e){ return norm(e.innerText).indexOf(text) >= 0; }).sort(function(a, b){ return norm(a.innerText).length - norm(b.innerText).length; })[0] || null;
      }
      if (el) {
        el.scrollIntoView({ block: 'center', inline: 'center' });
        var r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      var frames = doc.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) {
        var d = null;
        try { d = frames[i].contentDocument; } catch (e) { d = null; }
        if (!d) continue;
        var hit = inDoc(d);
        if (hit) { var fr = frames[i].getBoundingClientRect(); return { x: hit.x + fr.left + frames[i].clientLeft, y: hit.y + fr.top + frames[i].clientTop }; }
      }
      return null;
    }
    return inDoc(document);
  })(${JSON.stringify(sel)}, ${JSON.stringify(text)})`;
}

/** A ring where the pointer clicked, so the video shows the click (it fades by itself). */
const RING_JS = (x: number, y: number) => `(function(){var d=document.createElement('div');d.style.cssText='position:fixed;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border-radius:50%;border:3px solid rgba(220,38,38,.9);background:rgba(220,38,38,.18);z-index:2147483647;pointer-events:none;transition:opacity .6s ease .3s,transform .6s ease .3s';document.documentElement.appendChild(d);requestAnimationFrame(function(){requestAnimationFrame(function(){d.style.opacity='0';d.style.transform='scale(1.6)';});});setTimeout(function(){d.remove()},1200);})()`;

const KEYS: Record<string, { code: string; vk: number; text?: string; key?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Space: { code: "Space", vk: 32, text: " ", key: " " },
};
const MODS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

/** "Enter", "a", "Control+K", "Shift+Tab", "Control+Shift+F": keyDown/keyUp with the modifiers held. */
async function press(page: Pg, combo: string): Promise<void> {
  const parts = combo.split("+").map((x) => x.trim()).filter(Boolean);
  const name = parts.pop() ?? "";
  let mods = 0;
  for (const m of parts) {
    const bit = MODS[m.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier ${m} (Control, Shift, Alt, Meta)`);
    mods |= bit;
  }
  const one = name.length === 1;
  const k = KEYS[name] ?? (one ? { code: /[a-z]/i.test(name) ? `Key${name.toUpperCase()}` : /\d/.test(name) ? `Digit${name}` : "", vk: name.toUpperCase().charCodeAt(0), text: name } : null);
  if (!k) throw new Error(`unknown key ${name} (Enter, Tab, Escape, Backspace, Delete, Home, End, PageUp/Down, Arrow…, Space, or one character)`);
  // A shortcut letter is lower case unless Shift is held ("Control+K" sends key "k", as a keyboard does).
  const key = k.key ?? (one ? ((mods & 8) ? name.toUpperCase() : mods ? name.toLowerCase() : name) : name);
  // With Control, Alt or Meta held a key types nothing (it is a shortcut).
  const text = mods & 7 ? undefined : k.text !== undefined ? ((mods & 8) && one ? name.toUpperCase() : k.text) : undefined;
  await page.call("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: mods, ...(text ? { text } : {}) });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers: mods });
}

async function locate(page: Pg, what: Target, timeoutMs = 5000): Promise<{ x: number; y: number }> {
  if (typeof what === "object" && what && "x" in what) return { x: Number(what.x) || 0, y: Number((what as { y: number }).y) || 0 };
  let at: { x: number; y: number } | null = null;
  const until = Date.now() + timeoutMs;
  while (!(at = await evalJs(page, findJs(what)))) {
    if (Date.now() > until) throw new Error(`nothing on the page matches ${JSON.stringify(what)}`);
    await sleep(200);
  }
  await sleep(120);
  return at;
}

async function click(page: Pg, what: Target): Promise<void> {
  const { x, y } = await locate(page, what);
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await evalJs(page, RING_JS(x, y)).catch(() => {});
}

async function step(page: Pg, s: Step, cwd: string, log: string[], shot: (name: string) => Promise<string>): Promise<void> {
  const o = s as Record<string, any>;
  if ("wait" in o) await sleep(Math.min(30_000, Math.max(0, Number(o.wait) || 0)));
  else if ("click" in o) await click(page, o.click);
  else if ("hover" in o) {
    const { x, y } = await locate(page, o.hover);
    await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  } else if ("type" in o) {
    if (o.into) await click(page, o.into);
    await page.call("Input.insertText", { text: String(o.type) });
  } else if ("press" in o) await press(page, String(o.press));
  else if ("scroll" in o) {
    const dy = Number(o.scroll) || 0;
    await page.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 200, deltaX: 0, deltaY: dy });
  } else if ("goto" in o) await navigate(page, String(o.goto), log);
  else if ("waitFor" in o) {
    const until = Date.now() + Math.min(60_000, Number(o.timeout) || 10_000);
    while (!(await evalJs(page, findJs(o.waitFor)))) {
      if (Date.now() > until) throw new Error(`${JSON.stringify(o.waitFor)} did not appear`);
      await sleep(200);
    }
  } else if ("shot" in o) {
    log.push(`shot ${await shot(String(o.shot || "shot"))}`);
    return;
  } else if ("run" in o) {
    const out = execSync(String(o.run), { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    log.push(`ran ${String(o.run).slice(0, 120)}${out.trim() ? `: ${out.trim().slice(-200)}` : ""}`);
    return;
  } else throw new Error(`unknown step ${JSON.stringify(s).slice(0, 80)}`);
  log.push(`${Object.keys(o)[0]} ${JSON.stringify(Object.values(o)[0]).slice(0, 80)} ok`);
}

async function savePng(page: Pg, file: string): Promise<void> {
  const r = await page.call("Page.captureScreenshot", { format: "png" });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(r?.data ?? "", "base64"));
}


// ---------------------------------------------------------------- encoding: VP8 by the browser itself

export type Chunk = { key: boolean; t: number; data: Buffer };

/** The frames (JPEG, `t` in ms from the first) → H.264 (for MP4) or VP8 (for WebM) chunks, by the page's WebCodecs. */
async function encode(page: Pg, frames: Frame[], w: number, h: number, want: "mp4" | "webm"): Promise<{ kind: "mp4" | "webm"; chunks: Chunk[]; description?: Buffer }> {
  // WebCodecs needs a secure context (about:blank is not one; a local file is).
  const blank = join(mkdtempSync(join(tmpdir(), "vc-rec-")), "encode.html");
  writeFileSync(blank, "<!doctype html><title>encode</title>");
  await page.call("Page.navigate", { url: pathToFileURL(blank).href });
  await sleep(300);
  const ok = await evalJs(
    page,
    `(async function(w, h, want){
      if (typeof VideoEncoder === 'undefined') return 'no WebCodecs in this browser';
      var avc = { codec: 'avc1.4d0028', width: w, height: h, bitrate: 2500000, framerate: 30, avc: { format: 'avc' } };
      var vp8 = { codec: 'vp8', width: w, height: h, bitrate: 2500000, framerate: 30 };
      var tryAvc = want === 'mp4' && !!(await VideoEncoder.isConfigSupported(avc).catch(function(){ return {}; })).supported;
      if (!tryAvc && !(await VideoEncoder.isConfigSupported(vp8)).supported) return 'this browser can encode neither H.264 nor VP8';
      window.__vcKind = tryAvc ? 'mp4' : 'webm';
      window.__vcDesc = null;
      var chunks = [];
      window.__vcErr = null;
      var enc = new VideoEncoder({ output: function(c, meta){
        var b = new Uint8Array(c.byteLength); c.copyTo(b); chunks.push({ k: c.type === 'key', t: c.timestamp, d: b });
        var d = meta && meta.decoderConfig && meta.decoderConfig.description;
        if (d && !window.__vcDesc) window.__vcDesc = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) : new Uint8Array(d.slice(0));
      }, error: function(e){ window.__vcErr = String(e); } });
      enc.configure(tryAvc ? avc : vp8);
      var cv = new OffscreenCanvas(w, h), g = cv.getContext('2d');
      var lastKey = -1e9;
      window.__vcAdd = async function(b64, ms){
        var bin = atob(b64), u = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        var bmp = await createImageBitmap(new Blob([u], { type: 'image/jpeg' }));
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0); bmp.close();
        var f = new VideoFrame(cv, { timestamp: Math.round(ms * 1000) });
        var key = ms - lastKey >= 2000; if (key) lastKey = ms;
        enc.encode(f, { keyFrame: key }); f.close();
        while (enc.encodeQueueSize > 8) await new Promise(function(r){ setTimeout(r, 5); });
        return window.__vcErr;
      };
      window.__vcDone = async function(){
        await enc.flush(); enc.close();
        var b64 = function(d){ var s = ''; for (var i = 0; i < d.length; i += 32768) s += String.fromCharCode.apply(null, d.subarray(i, i + 32768)); return btoa(s); };
        return { kind: window.__vcKind, desc: window.__vcDesc ? b64(window.__vcDesc) : null, chunks: chunks.map(function(c){ return { k: c.k, t: c.t, d: b64(c.d) }; }) };
      };
      return 'ok';
    })(${w}, ${h}, ${JSON.stringify(want)})`,
  );
  if (ok !== "ok") throw new Error(String(ok));
  for (const f of frames) {
    const err = await evalJs(page, `window.__vcAdd(${JSON.stringify(f.data)}, ${f.t})`);
    if (err) throw new Error(`encoding failed: ${err}`);
  }
  const out = (await evalJs(page, "window.__vcDone()")) as { kind: "mp4" | "webm"; desc: string | null; chunks: { k: boolean; t: number; d: string }[] };
  const chunks = out.chunks.map((c) => ({ key: c.k, t: c.t / 1000, data: Buffer.from(c.d, "base64") }));
  if (out.kind === "mp4" && !out.desc) throw new Error("the H.264 encoder gave no decoder configuration");
  return { kind: out.kind, chunks, ...(out.desc ? { description: Buffer.from(out.desc, "base64") } : {}) };
}

// ---------------------------------------------------------------- WebM (EBML), one VP8 track

function vintSize(n: number): Buffer {
  // 8-byte size: 0x01 then 7 bytes.
  const b = Buffer.alloc(8);
  b[0] = 0x01;
  let v = BigInt(n);
  for (let i = 7; i >= 1; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}
function idBytes(id: number): Buffer {
  const hex = id.toString(16);
  return Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
}
function el(id: number, body: Buffer | Buffer[]): Buffer {
  const b = Array.isArray(body) ? Buffer.concat(body) : body;
  return Buffer.concat([idBytes(id), vintSize(b.length), b]);
}
function uint(id: number, v: number, width = 0): Buffer {
  let n = BigInt(Math.max(0, Math.round(v)));
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  } while (n > 0n);
  while (bytes.length < width) bytes.unshift(0);
  return el(id, Buffer.from(bytes));
}
function float(id: number, v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(v);
  return el(id, b);
}
const str = (id: number, s: string) => el(id, Buffer.from(s, "utf8"));

/** A playable, seekable WebM: one cluster per keyframe, Cues at the end and a SeekHead pointing at them. */
export function webm(chunks: Chunk[], w: number, h: number, durationMs: number): Buffer {
  const header = el(0x1a45dfa3, [uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, "webm"), uint(0x4287, 2), uint(0x4285, 2)]);
  const info = el(0x1549a966, [uint(0x2ad7b1, 1_000_000), float(0x4489, Math.max(1, durationMs)), str(0x4d80, "vault-chat"), str(0x5741, "vault-chat RecordUI")]);
  const tracks = el(0x1654ae6b, el(0xae, [uint(0xd7, 1), uint(0x73c5, 1), uint(0x9c, 0), str(0x86, "V_VP8"), uint(0x83, 1), el(0xe0, [uint(0xb0, w), uint(0xba, h)])]));
  // Clusters: a new one at each keyframe (the encoder makes one at least every 2 s, so block offsets fit an int16).
  const clusters: { t: number; blocks: Buffer[] }[] = [];
  for (const c of chunks) {
    const t = Math.round(c.t);
    if (c.key || !clusters.length || t - clusters[clusters.length - 1]!.t > 30_000) clusters.push({ t, blocks: [] });
    const cl = clusters[clusters.length - 1]!;
    const head = Buffer.alloc(4);
    head[0] = 0x81; // track 1
    head.writeInt16BE(t - cl.t, 1);
    head[3] = c.key ? 0x80 : 0x00;
    cl.blocks.push(el(0xa3, [head, c.data]));
  }
  const clusterBufs = clusters.map((c) => el(0x1f43b675, [uint(0xe7, c.t), ...c.blocks]));
  // SeekHead with fixed-width positions, so its own size is known before the positions are.
  const seekHead = (cuesPos: number) => el(0x114d9b74, el(0x4dbb, [el(0x53ab, idBytes(0x1c53bb6b)), uint(0x53ac, cuesPos, 8)]));
  const seekLen = seekHead(0).length;
  let pos = seekLen + info.length + tracks.length;
  const cuePoints: Buffer[] = [];
  clusters.forEach((c, i) => {
    cuePoints.push(el(0xbb, [uint(0xb3, c.t), el(0xb7, [uint(0xf7, 1), uint(0xf1, pos, 8)])]));
    pos += clusterBufs[i]!.length;
  });
  const cues = el(0x1c53bb6b, cuePoints);
  const segment = el(0x18538067, [seekHead(pos), info, tracks, ...clusterBufs, cues]);
  return Buffer.concat([header, segment]);
}

// ---------------------------------------------------------------- MP4 (ISO BMFF), one H.264 track, moov first

function box(type: string, ...body: Buffer[]): Buffer {
  const b = Buffer.concat(body);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(b.length + 8);
  h.write(type, 4, "ascii");
  return Buffer.concat([h, b]);
}
const fullBox = (type: string, version: number, flags: number, ...body: Buffer[]) => {
  const vf = Buffer.alloc(4);
  vf.writeUInt32BE((((version & 0xff) << 24) | (flags & 0xffffff)) >>> 0);
  return box(type, vf, ...body);
};
const u32 = (...v: number[]) => {
  const b = Buffer.alloc(4 * v.length);
  v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4));
  return b;
};
const u16 = (...v: number[]) => {
  const b = Buffer.alloc(2 * v.length);
  v.forEach((x, i) => b.writeUInt16BE(x & 0xffff, i * 2));
  return b;
};
const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);

/** A progressive MP4 (moov before mdat, so it plays as it loads): `chunks` are length-prefixed H.264 samples,
 *  `avcC` the encoder's decoder configuration; times in ms (timescale 1000). */
export function mp4(chunks: Chunk[], w: number, h: number, durationMs: number, avcC: Buffer): Buffer {
  const dur = Math.max(1, Math.round(durationMs));
  const n = chunks.length;
  const times = chunks.map((c) => Math.round(c.t));
  const deltas = times.map((t, i) => Math.max(1, (i + 1 < n ? times[i + 1]! : dur) - t));
  const stts: [number, number][] = [];
  for (const d of deltas) {
    const last = stts[stts.length - 1];
    if (last && last[1] === d) last[0]++;
    else stts.push([1, d]);
  }
  const sync = chunks.map((c, i) => (c.key ? i + 1 : 0)).filter(Boolean);
  const ftyp = box("ftyp", Buffer.from("isom", "ascii"), u32(512), Buffer.from("isomiso2avc1mp41", "ascii"));
  const avc1 = box("avc1", Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(w, h), u32(0x00480000, 0x00480000, 0), u16(1), Buffer.alloc(32), u16(0x0018, 0xffff), box("avcC", avcC));
  const stbl = (mdatAt: number) =>
    box(
      "stbl",
      fullBox("stsd", 0, 0, u32(1), avc1),
      fullBox("stts", 0, 0, u32(stts.length, ...stts.flat())),
      fullBox("stss", 0, 0, u32(sync.length, ...sync)),
      fullBox("stsc", 0, 0, u32(1, 1, n, 1)),
      fullBox("stsz", 0, 0, u32(0, n, ...chunks.map((c) => c.data.length))),
      fullBox("stco", 0, 0, u32(1, mdatAt)),
    );
  const moov = (mdatAt: number) =>
    box(
      "moov",
      fullBox("mvhd", 0, 0, u32(0, 0, 1000, dur, 0x00010000), u16(0x0100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2)),
      box(
        "trak",
        fullBox("tkhd", 0, 3, u32(0, 0, 1, 0, dur), Buffer.alloc(8), u16(0, 0, 0, 0), MATRIX, u32(w * 65536, h * 65536)),
        box(
          "mdia",
          fullBox("mdhd", 0, 0, u32(0, 0, 1000, dur), u16(0x55c4, 0)),
          fullBox("hdlr", 0, 0, u32(0), Buffer.from("vide", "ascii"), Buffer.alloc(12), Buffer.from("VideoHandler\0", "ascii")),
          box("minf", fullBox("vmhd", 0, 1, u16(0, 0, 0, 0)), box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))), stbl(mdatAt)),
        ),
      ),
    );
  const moovLen = moov(0).length;
  const mdat = box("mdat", ...chunks.map((c) => c.data));
  return Buffer.concat([ftyp, moov(ftyp.length + moovLen + 8), mdat]);
}

// ---------------------------------------------------------------- the child process and the tool

/** `vault-chat-server.mjs record-ui`: the args as JSON on stdin, the result as one JSON line on stdout. */
export async function recordCli(): Promise<void> {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  let out: RecordOut;
  const scratch: string[] = [];
  try {
    const { vault, browserOnly, ...a } = JSON.parse(raw || "{}");
    // The installed sandbox keeps HOME read-only. Chromium's crashpad/config
    // must use private writable scratch space, not the real home directory.
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "vc-rec-config-"));
    scratch.push(process.env.XDG_CONFIG_HOME);
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "vc-rec-cache-"));
    scratch.push(process.env.XDG_CACHE_HOME);
    out = await record(process.cwd(), a, typeof vault === "string" && vault ? vault : process.cwd(), browserOnly === true);
  } catch (e) {
    out = { ok: false, error: (e as Error)?.message ?? String(e) };
  } finally {
    for (const path of scratch) rmSync(path, { recursive: true, force: true });
  }
  process.stdout.write("\n@@vc-record@@" + JSON.stringify(out) + "\n");
  process.exit(0);
}

/** RecordUI for the agent: the recorder in the sandbox (`shell`), in the thread's folder (`o.cwd`, default the
 *  vault); the video goes in the vault. A line for the agent. */
export async function recordUITool(shell: string[] | null | undefined, vault: string, a: Record<string, unknown>, o: { entry?: string[]; cwd?: string; browserOnly?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  const entry = o.entry ?? [process.execPath, process.argv[1] ?? "", "record-ui"];
  const seconds = Math.min(MAX_SECONDS, Math.max(1, Number(a?.seconds) || 4));
  const r = await runSandboxed(shell, entry, { cwd: o.cwd ?? vault, timeoutMs: (seconds + 120) * 1000, stdin: JSON.stringify({ ...(a ?? {}), vault, browserOnly: o.browserOnly === true }), extraEnv: { TMPDIR: "/tmp" }, signal: o.signal });
  if ("refused" in r) return `RecordUI is unavailable: ${r.refused}`;
  const line = r.out.split("@@vc-record@@")[1];
  let res: RecordOut | null = null;
  try {
    res = line ? JSON.parse(line.trim()) : null;
  } catch {
    res = null;
  }
  if (!res) return `RecordUI failed${r.timedOut ? " (timed out)" : ""}: ${(r.err || r.out).trim().slice(-800) || "no output"}`;
  const steps = res.log?.length ? `\nSteps: ${res.log.join("; ")}` : "";
  if (!res.ok) return `RecordUI failed: ${res.error}${steps}`;
  const rel = relative(vault, res.path).split("\\").join("/");
  const verdict = res.failed ? "A STEP FAILED (see Steps): the run stopped there; the video shows up to it. " : "Every step ran. ";
  const errs = res.errors?.length ? `\nPage errors (${res.errors.length}): ${res.errors.slice(0, 10).join(" | ")}` : "\nPage errors: none.";
  const shots = res.shots?.length ? `\nScreenshots (read them to see the result): ${res.shots.map((p) => relative(o.cwd ?? vault, p).split("\\").join("/")).join(", ")}` : "";
  const text = res.text ? `\nVisible text at the end:\n${res.text.slice(0, 1500)}` : "";
  return `${verdict}Recorded ${res.seconds} s (${res.width}×${res.height}, ${res.frames} frames, ${Math.round(res.bytes / 1024)} KB): ${rel}. Put it in your reply as ![what it shows](${rel}) — it plays inline in the chat.${steps}${errs}${shots}${text}`;
}

export const _test = { outPath };
