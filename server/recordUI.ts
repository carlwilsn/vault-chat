// RecordUI: a short video of a page working, for the agent to put in its reply as proof (`![…](x.webm)`
// plays inline in the chat on the laptop and the phone).
//
// No ffmpeg and nothing new on the box: the box's own headless Chromium (server/headless.ts, muted) is driven
// over the DevTools protocol — real mouse and keyboard input for the steps — and its screencast frames are
// encoded to VP8 by the same browser (WebCodecs), then put in a WebM file here (a small EBML writer).
//
// The tool runs the recorder as a child of this same bundle (`vault-chat-server.mjs record-ui`) inside the
// agent's command sandbox (server/vaultTools.ts runSandboxed): the browser sees what the agent's shell sees and
// no more, and a `run` step is a command in that sandbox.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { openPage } from "./headless";
import { runSandboxed } from "./vaultTools";

export type Step =
  | { wait: number }
  | { click: string | { text: string } }
  | { type: string; into?: string }
  | { press: string }
  | { scroll: number }
  | { goto: string }
  | { waitFor: string | { text: string }; timeout?: number }
  | { run: string };

export type RecordArgs = { url?: string; steps?: Step[]; seconds?: number; out?: string; width?: number; height?: number };
export type RecordOut = { ok: true; path: string; seconds: number; frames: number; bytes: number; width: number; height: number; log: string[] } | { ok: false; error: string; log?: string[] };

export const RECORD_DESCRIPTION =
  "Record a short video (WebM, muted, headless) of a web page working, as proof: e.g. the dev server you started with StartJob (http://localhost:5173) or a vault HTML file. " +
  "steps run in order with real mouse and keyboard input, each followed by a short pause so the video shows its effect: " +
  '{"click": "css selector"} or {"click": {"text": "Save"}}, {"type": "hello", "into": "#name"}, {"press": "Enter"}, {"scroll": 600}, ' +
  '{"wait": 1000}, {"waitFor": "css selector"} or {"waitFor": {"text": "Done"}}, {"goto": "url"}, {"run": "shell command"} (in your sandbox, cwd = the vault: e.g. an edit, to film hot reload). ' +
  "seconds: the least length of the video (default 4, at most 90). Returns the video's path: put it in your reply as ![what it shows](path) and it plays inline in the chat on his laptop and phone. " +
  "Say what the video shows in a line; watch it only through what the tool returns (frames, length), never claim more.";

export const RECORD_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "http(s) address to open, e.g. http://localhost:5173 (a vault .html file: its path)." },
    steps: { type: "array", items: { type: "object" }, description: "What to do on the page, in order (see the tool's description)." },
    seconds: { type: "number", description: "Least length in seconds (default 4, max 90)." },
    out: { type: "string", description: "Where to write the .webm, relative to the vault (default .vault-chat/visuals/recording-<time>.webm)." },
    width: { type: "number", description: "Viewport width in px (default 1280)." },
    height: { type: "number", description: "Viewport height in px (default 800)." },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STEP_PAUSE_MS = 700;
const MAX_SECONDS = 90;

type Frame = { data: string; t: number };

// ---------------------------------------------------------------- the recording (runs in the sandbox)

/** Record `a.url` with its steps into `cwd`-relative `a.out` (a .webm). */
export async function record(cwd: string, a: RecordArgs): Promise<RecordOut> {
  const log: string[] = [];
  const url = String(a.url ?? "").trim();
  let target: string;
  if (/^https?:\/\//i.test(url)) target = url;
  else if (url && /\.html?$/i.test(url)) target = pathToFileURL(resolve(cwd, url)).href;
  else return { ok: false, error: "url must be an http(s) address (e.g. http://localhost:5173) or a vault .html file" };
  const w = clampInt(a.width, 1280, 320, 1920) & ~1;
  const h = clampInt(a.height, 800, 320, 1600) & ~1;
  const least = Math.min(MAX_SECONDS, Math.max(1, Number(a.seconds) || 4));
  const out = outPath(cwd, a.out);
  if (typeof out !== "string") return { ok: false, error: out.error };
  const steps = Array.isArray(a.steps) ? a.steps : [];

  const page = await openPage(w, h);
  const frames: Frame[] = [];
  try {
    await page.call("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await page.call("Page.enable");
    await page.call("Runtime.enable");
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
        await step(page, s, cwd, log);
      } catch (e) {
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
    // The last picture holds to the end (a page that stopped changing sends no frames).
    const shot = await page.call("Page.captureScreenshot", { format: "jpeg", quality: 85 }).catch(() => null);
    const last: Frame = { data: shot?.data ?? frames[frames.length - 1]!.data, t: Math.max(end, frames[frames.length - 1]!.t + 100) };
    const all = [...frames, last];
    const startT = all[0]!.t;
    const chunks = await encode(page, all.map((f) => ({ data: f.data, t: f.t - startT })), w, h);
    const durMs = last.t - startT;
    const file = webm(chunks, w, h, durMs);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, file);
    return { ok: true, path: out, seconds: Math.round(durMs / 100) / 10, frames: all.length, bytes: file.length, width: w, height: h, log };
  } finally {
    await page.close();
  }
}

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, n)) : def;
}

function outPath(cwd: string, o: unknown): string | { error: string } {
  const rel = typeof o === "string" && o.trim() ? o.trim() : `.vault-chat/visuals/recording-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.webm`;
  if (!/\.webm$/i.test(rel)) return { error: "out must end in .webm" };
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

/** The centre of the element a selector or a text names (scrolled into view), or null. */
function findJs(what: string | { text: string }): string {
  const sel = typeof what === "string" ? what : null;
  const text = typeof what === "object" && what ? String(what.text ?? "") : "";
  return `(function(sel, text){
    var el = null;
    if (sel) el = document.querySelector(sel);
    if (!el && text) {
      var all = Array.prototype.slice.call(document.querySelectorAll('button,a,input,textarea,select,label,summary,[role=button],[onclick],h1,h2,h3,h4,p,span,div,li,td'));
      var norm = function(s){ return (s || '').replace(/\\s+/g, ' ').trim(); };
      el = all.find(function(e){ return norm(e.innerText) === text || e.value === text || e.getAttribute('aria-label') === text; })
        || all.filter(function(e){ return norm(e.innerText).indexOf(text) >= 0; }).sort(function(a, b){ return norm(a.innerText).length - norm(b.innerText).length; })[0] || null;
    }
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })(${JSON.stringify(sel)}, ${JSON.stringify(text)})`;
}

/** A ring where the pointer clicked, so the video shows the click (it fades by itself). */
const RING_JS = (x: number, y: number) => `(function(){var d=document.createElement('div');d.style.cssText='position:fixed;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border-radius:50%;border:3px solid rgba(220,38,38,.9);background:rgba(220,38,38,.18);z-index:2147483647;pointer-events:none;transition:opacity .6s ease .3s,transform .6s ease .3s';document.documentElement.appendChild(d);requestAnimationFrame(function(){requestAnimationFrame(function(){d.style.opacity='0';d.style.transform='scale(1.6)';});});setTimeout(function(){d.remove()},1200);})()`;

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Space: { code: "Space", vk: 32, text: " " },
};

async function click(page: Pg, what: string | { text: string }, timeoutMs = 5000): Promise<void> {
  let at: { x: number; y: number } | null = null;
  const until = Date.now() + timeoutMs;
  while (!(at = await evalJs(page, findJs(what)))) {
    if (Date.now() > until) throw new Error(`nothing on the page matches ${JSON.stringify(what)}`);
    await sleep(200);
  }
  await sleep(120);
  const { x, y } = at;
  await page.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await evalJs(page, RING_JS(x, y)).catch(() => {});
}

async function step(page: Pg, s: Step, cwd: string, log: string[]): Promise<void> {
  const o = s as Record<string, any>;
  if ("wait" in o) await sleep(Math.min(30_000, Math.max(0, Number(o.wait) || 0)));
  else if ("click" in o) await click(page, o.click);
  else if ("type" in o) {
    if (o.into) await click(page, o.into);
    await page.call("Input.insertText", { text: String(o.type) });
  } else if ("press" in o) {
    const name = String(o.press);
    const k = KEYS[name] ?? (name.length === 1 ? { code: `Key${name.toUpperCase()}`, vk: name.toUpperCase().charCodeAt(0), text: name } : null);
    if (!k) throw new Error(`unknown key ${name} (Enter, Tab, Escape, Backspace, Delete, Arrow…, Space, or one character)`);
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: name === "Space" ? " " : name, code: k.code, windowsVirtualKeyCode: k.vk, ...(k.text ? { text: k.text } : {}) });
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: name === "Space" ? " " : name, code: k.code, windowsVirtualKeyCode: k.vk });
  } else if ("scroll" in o) {
    const dy = Number(o.scroll) || 0;
    await page.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: 200, y: 200, deltaX: 0, deltaY: dy });
  } else if ("goto" in o) await navigate(page, String(o.goto), log);
  else if ("waitFor" in o) {
    const until = Date.now() + Math.min(60_000, Number(o.timeout) || 10_000);
    while (!(await evalJs(page, findJs(o.waitFor)))) {
      if (Date.now() > until) throw new Error(`${JSON.stringify(o.waitFor)} did not appear`);
      await sleep(200);
    }
  } else if ("run" in o) {
    const out = execSync(String(o.run), { cwd, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    log.push(`ran ${String(o.run).slice(0, 120)}${out.trim() ? `: ${out.trim().slice(-200)}` : ""}`);
    return;
  } else throw new Error(`unknown step ${JSON.stringify(s).slice(0, 80)}`);
  log.push(`${Object.keys(o)[0]} ${JSON.stringify(Object.values(o)[0]).slice(0, 80)}`);
}

// ---------------------------------------------------------------- encoding: VP8 by the browser itself

export type Chunk = { key: boolean; t: number; data: Buffer };

/** The frames (JPEG, `t` in ms from the first) → VP8 chunks, encoded by the page's WebCodecs. */
async function encode(page: Pg, frames: Frame[], w: number, h: number): Promise<Chunk[]> {
  // WebCodecs needs a secure context (about:blank is not one; a local file is).
  const blank = join(mkdtempSync(join(tmpdir(), "vc-rec-")), "encode.html");
  writeFileSync(blank, "<!doctype html><title>encode</title>");
  await page.call("Page.navigate", { url: pathToFileURL(blank).href });
  await sleep(300);
  const ok = await evalJs(
    page,
    `(async function(w, h){
      if (typeof VideoEncoder === 'undefined') return 'no WebCodecs in this browser';
      var sup = await VideoEncoder.isConfigSupported({ codec: 'vp8', width: w, height: h });
      if (!sup.supported) return 'this browser cannot encode VP8';
      var chunks = [];
      window.__vcErr = null;
      var enc = new VideoEncoder({ output: function(c){ var b = new Uint8Array(c.byteLength); c.copyTo(b); chunks.push({ k: c.type === 'key', t: c.timestamp, d: b }); }, error: function(e){ window.__vcErr = String(e); } });
      enc.configure({ codec: 'vp8', width: w, height: h, bitrate: 2500000, framerate: 30 });
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
        return chunks.map(function(c){ var s = ''; for (var i = 0; i < c.d.length; i += 32768) s += String.fromCharCode.apply(null, c.d.subarray(i, i + 32768)); return { k: c.k, t: c.t, d: btoa(s) }; });
      };
      return 'ok';
    })(${w}, ${h})`,
  );
  if (ok !== "ok") throw new Error(String(ok));
  for (const f of frames) {
    const err = await evalJs(page, `window.__vcAdd(${JSON.stringify(f.data)}, ${f.t})`);
    if (err) throw new Error(`encoding failed: ${err}`);
  }
  const out = (await evalJs(page, "window.__vcDone()")) as { k: boolean; t: number; d: string }[];
  return out.map((c) => ({ key: c.k, t: c.t / 1000, data: Buffer.from(c.d, "base64") }));
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

// ---------------------------------------------------------------- the child process and the tool

/** `vault-chat-server.mjs record-ui`: the args as JSON on stdin, the result as one JSON line on stdout. */
export async function recordCli(): Promise<void> {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  let out: RecordOut;
  try {
    const a = JSON.parse(raw || "{}");
    out = await record(process.cwd(), a);
  } catch (e) {
    out = { ok: false, error: (e as Error)?.message ?? String(e) };
  }
  process.stdout.write("\n@@vc-record@@" + JSON.stringify(out) + "\n");
  process.exit(0);
}

/** RecordUI for the agent: the recorder in the sandbox (`shell`), cwd = the vault; a line for the agent. */
export async function recordUITool(shell: string[] | null | undefined, vault: string, a: Record<string, unknown>, o: { entry?: string[] } = {}): Promise<string> {
  const entry = o.entry ?? [process.execPath, process.argv[1] ?? "", "record-ui"];
  const seconds = Math.min(MAX_SECONDS, Math.max(1, Number(a?.seconds) || 4));
  const r = await runSandboxed(shell, entry, { cwd: vault, timeoutMs: (seconds + 120) * 1000, stdin: JSON.stringify(a ?? {}), extraEnv: { TMPDIR: "/tmp" } });
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
  return `Recorded ${res.seconds} s (${res.width}×${res.height}, ${res.frames} frames, ${Math.round(res.bytes / 1024)} KB): ${rel}. Put it in your reply as ![what it shows](${rel}) — it plays inline in the chat.${steps}`;
}

export const _test = { outPath };
