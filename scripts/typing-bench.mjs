// Composer typing latency in headless Chromium, for A/B runs on a test instance.
// Real key events (CDP Input.dispatchKeyEvent) into the composer; each `input` event is timed
// to two animation frames later (the measurement of docs/typing-performance-0726.md).
// Nothing is sent: the draft is cleared and Enter is never pressed. See docs/perf-baseline.md.
//
//   node scripts/typing-bench.mjs --url A=http://127.0.0.1:1531/before/?scenario=conv-a \
//                                 --url B=http://127.0.0.1:1531/after/?scenario=conv-a [--keys 41] [--runs 3] [--out r.json]
//
// Loopback only, never 8848/8857 (the live ports). Several --url values run interleaved, run by run.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { median, percentile } from "./perf-baseline.mjs";

const CHROMIUM = process.env.CHROMIUM || "/run/current-system/sw/bin/chromium";
const FORBIDDEN_PORTS = new Set(["8848", "8857"]);
const TEXT = "the quick brown fox jumps over the lazy dog 0123456789 ";

/** Refuse anything but a loopback test instance on a port that is not a live one. */
export function checkUrl(u) {
  const url = new URL(u);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error(`${u}: only loopback test instances (127.0.0.1 / localhost)`);
  if (FORBIDDEN_PORTS.has(url.port)) throw new Error(`${u}: ports 8848 and 8857 are the live instance; use a test instance`);
  return url.href;
}

/** [{ms}] of one run -> the numbers that matter. */
export function stats(ms) {
  const v = [...ms].sort((a, b) => a - b);
  return { count: v.length, medianMs: median(v), p95Ms: percentile(v, 0.95), minMs: v[0] ?? null, maxMs: v[v.length - 1] ?? null };
}

/** Runs: an array per URL label of per-run samples -> pooled stats plus the median of the run medians. */
export function summarizeRuns(runs) {
  const all = runs.flat();
  const medians = runs.map(r => stats(r).medianMs).sort((a, b) => a - b);
  return { ...stats(all), runs: runs.length, runMedianMs: median(medians) };
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = e => { const m = JSON.parse(e.data); const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }; }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
}

async function launch() {
  const dir = mkdtempSync(join(tmpdir(), "vc-typing-bench-"));
  const proc = spawn(CHROMIUM, ["--headless=old", "--no-sandbox", "--disable-gpu", `--user-data-dir=${dir}`, "--remote-debugging-port=0", "--window-size=1440,960", "--mute-audio", "about:blank"], { detached: true, stdio: ["ignore", "ignore", process.env.TYPING_BENCH_DEBUG ? "inherit" : "ignore"] });
  const portFile = join(dir, "DevToolsActivePort");
  for (let i = 0; i < 300 && !existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
  if (!existsSync(portFile)) { proc.kill(); rmSync(dir, { recursive: true, force: true }); throw new Error("chromium did not start"); }
  const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cannot reach chromium devtools")); });
  const cdp = new Cdp(ws);
  const close = async () => {
    try { ws.close(); } catch { /* gone */ }
    const gone = new Promise(r => proc.once("exit", r));
    try { process.kill(-proc.pid); } catch { proc.kill(); } // chromium's helper processes too
    await Promise.race([gone, new Promise(r => setTimeout(r, 5000))]);
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* temp dir left behind, harmless */ }
  };
  return { cdp, close };
}

const evalIn = async (cdp, sid, expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

// In the page: time every input event on the composer to two animation frames after it.
const INSTALL = `(() => {
  const w = window, find = () => document.querySelector('[data-perf-target="composer"]') || document.querySelector('[data-el="composer"] textarea');
  w.__bench = { ms: [], find };
  w.addEventListener('input', e => {
    const c = find(); if (!c || e.target !== c) return;
    const t0 = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => w.__bench.ms.push(performance.now() - t0)));
  }, true);
  const visible = el => { for (let p = el; p; p = p.parentElement) if (p.getBoundingClientRect().width < 1) return false; return true; };
  w.__bench.visible = () => { const c = find(); return !!c && visible(c); };
})()`;

/** One page, one run: type `keys` characters, return the ms per input event. */
async function typeRun(cdp, sid, keys, warmup) {
  const key = async (text) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text, key: text, unmodifiedText: text }, sid);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: text }, sid);
  };
  const waitSamples = n => evalIn(cdp, sid, `new Promise(res => { const t = Date.now(); const poll = () => __bench.ms.length >= ${n} || Date.now() - t > 3000 ? res(__bench.ms.length) : setTimeout(poll, 5); poll(); })`);
  await evalIn(cdp, sid, `__bench.find().focus(); __bench.ms.length = 0; true`);
  const total = warmup + keys;
  for (let i = 0; i < total; i++) {
    await key(TEXT[i % TEXT.length]);
    if ((await waitSamples(i + 1)) < i + 1) throw new Error(`no input event reached the composer at key ${i + 1}`);
    await new Promise(r => setTimeout(r, 25));
  }
  const ms = await evalIn(cdp, sid, `__bench.ms.slice(${warmup})`);
  // Clear the unsent draft (select all + delete); a run never leaves text behind, never submits.
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, commands: ["selectAll"] }, sid);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }, sid);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }, sid);
  return ms;
}

async function measure(cdp, url, { keys, warmup }) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false }, sid);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTALL }, sid);
    await cdp.send("Page.navigate", { url }, sid);
    // The composer exists and shows (the app may take a while to boot; the preview is a dev server).
    let ready = false;
    for (let t = Date.now(); !ready && Date.now() - t < 60000; await new Promise(r => setTimeout(r, 200))) {
      ready = await evalIn(cdp, sid, `!!window.__bench?.find?.()`).catch(() => false); // the old document goes away mid-navigation
    }
    if (!ready) throw new Error(`${url}: no composer within 60 s`);
    if (!(await evalIn(cdp, sid, `__bench.visible()`))) {
      // Same as preview/tools/typing-check.mjs: the chat panel may be collapsed.
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "b", code: "KeyB", modifiers: 2 | 8, windowsVirtualKeyCode: 66 }, sid);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "b", code: "KeyB", modifiers: 2 | 8, windowsVirtualKeyCode: 66 }, sid);
      await new Promise(r => setTimeout(r, 500));
      if (!(await evalIn(cdp, sid, `__bench.visible()`))) throw new Error(`${url}: the composer is not visible`);
    }
    await new Promise(r => setTimeout(r, 1500)); // let boot work settle before the first key
    return await typeRun(cdp, sid, keys, warmup);
  } finally { await cdp.send("Target.closeTarget", { targetId }).catch(() => {}); }
}

export async function bench(urls, { keys = 41, warmup = 5, runs = 3 } = {}) {
  const { cdp, close } = await launch();
  const per = Object.fromEntries(urls.map(u => [u.label, []]));
  try {
    for (let r = 0; r < runs; r++) for (const u of urls) per[u.label].push(await measure(cdp, u.url, { keys, warmup }));
  } finally { await close(); }
  return Object.fromEntries(Object.entries(per).map(([label, rs]) => [label, summarizeRuns(rs)]));
}

function parse(argv) {
  const o = { urls: [], keys: 41, warmup: 5, runs: 3 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[++i];
    if (v === undefined) throw new Error(`${k} needs a value`);
    if (k === "--url") { const m = /^([A-Za-z0-9_-]+)=(https?:.*)$/.exec(v); const url = checkUrl(m ? m[2] : v); o.urls.push({ label: m ? m[1] : `url${o.urls.length + 1}`, url }); }
    else if (["--keys", "--warmup", "--runs"].includes(k)) { const n = Number(v); if (!Number.isInteger(n) || n < (k === "--warmup" ? 0 : 1)) throw new Error(`${k} must be a whole number`); o[k.slice(2)] = n; }
    else if (k === "--out") o.out = v;
    else throw new Error(`unknown option ${k}`);
  }
  if (!o.urls.length) throw new Error("give at least one --url [label=]http://127.0.0.1:PORT/... (see docs/perf-baseline.md)");
  if (new Set(o.urls.map(u => u.label)).size !== o.urls.length) throw new Error("--url labels must differ");
  return o;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const o = parse(process.argv.slice(2));
    const res = await bench(o.urls, o);
    const f = n => n.toFixed(1);
    console.log(`Composer input -> two animation frames, ${o.keys} keys x ${o.runs} runs each (after ${o.warmup} warm-up keys), headless Chromium\n`);
    console.log("| instance | samples | median ms | p95 ms | min ms | max ms | median of run medians ms |\n|---|---:|---:|---:|---:|---:|---:|");
    for (const [label, s] of Object.entries(res)) console.log(`| ${label} | ${s.count} | ${f(s.medianMs)} | ${f(s.p95Ms)} | ${f(s.minMs)} | ${f(s.maxMs)} | ${f(s.runMedianMs)} |`);
    if (o.out) writeFileSync(o.out, JSON.stringify({ schema: 1, at: new Date().toISOString(), keys: o.keys, runs: o.runs, warmup: o.warmup, urls: o.urls, results: res }, null, 1) + "\n");
  } catch (e) { console.error(e.message); process.exitCode = 2; }
}
