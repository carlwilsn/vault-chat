// The hidden-copy gate for a plugin's draft (change by asking, reports/07 point 4): before the agent raises "Change
// ready", the draft runs in the box's headless browser on a copy of the data, side by side with what runs now, and the
// same steps on both are compared: errors, visible text, typing speed. Nothing is written to the vault (it is only
// read); the copy is the preview harness's in-memory vault (preview/README.md), the same frontend RecordUI drives.
//
//   node --import tsx scripts/draft-check.ts <plugin> --vault <vault> [--synthetic | --data <dir>] [--scenario conv-a]
//        [--steps steps.json] [--keys 24] [--runs 2] [--port 1561] [--out result.json] [--unasked | --asked] [--box <url>]
//   node --import tsx scripts/draft-check.ts <plugin> --vault <vault> --keep | --discard | --back [--reason <line>]
//
// <plugin>: an app plugin (composer, app/composer) or a vault plugin (pen-cursor, .vault-chat/plugins/pen-cursor.js).
// The data: by default a fresh, secret-filtered copy of the box's real data, made by the same installed capture helper
// the ship script's real-data gate runs (realCopySource in ~/.local/lib/vault-chat/simple-ship/config.json: it only
// reads, and copies outside the vault into a scratch folder removed after), its conversations and notes laid over the
// synthetic vault's files (the raw event logs are left out of the scratch copy). --synthetic: the harness's synthetic vault
// instead; --data <dir>: a copy you name. The vault's own live copies and the draft are laid over it. --steps:
// [{click|press|type|wait|waitFor}] (RecordUI's shapes), run on both sides before typing.
//
// The verdict (Kayenta's success / marginal / failure):
//   fail        the draft did not run, threw or logged errors the live side does not, or typing is over the typing limit
//   borderline  the visible text differs (listed: is it what Carl asked for, and only that?) or typing is slower
//   pass        no new errors, the same visible text, typing as fast
// Exit code: 0 pass, 3 borderline, 1 fail, 2 could not run.
//
// Landing it is the one gate's (scripts/gate.ts; src/gateResult.ts): --asked / --unasked hand the run to it, which uses
// this runner (draftCheck) for plugins and the preset, lands the verdict by one rule and prints `VC-GATE {GateResult}`.
// A real-data capture that fails (the data changed while it copied) is tried again for up to VC_DRAFT_CHECK_CAPTURE_MS
// (default 20 min), a minute apart: the draft is never dropped for it.
//   --keep / --discard / --back   the record by hand (the agent's own word), as app-plugin-live.ts writes it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { appPluginFolder } from "../src/appPluginLive.ts";
import { TRY_SLOW_MS, appSlot, slowMedian, vaultSlot, versionOf, type DraftSlot } from "../src/pluginDrafts.ts";
// @ts-expect-error a plain .mjs module (no types)
import { launch, evalIn, stats } from "./typing-bench.mjs";
import { postBoxChange } from "./boxChange.ts";
import { GATE_LINE, gateDecision as sharedDecision } from "../src/gateResult.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT = "the quick brown fox jumps over the lazy dog ";
/** How long the app may take to start on a side (a copy of real data is bigger than the synthetic vault). */
const START_MS = Number(process.env.VC_DRAFT_CHECK_START_MS) || 90_000;

export type Step = { click?: string | { text: string }; press?: string; type?: string; wait?: number; waitFor?: string | { text: string }; timeout?: number };
export type Side = { errors: string[]; text: string[]; ran: boolean; typingMs: number[] };
export type Verdict = { verdict: "pass" | "borderline" | "fail"; data?: string; reasons: string[]; plugin: string; version: string; live: Side; draft: Side; typing: { liveMedianMs: number | null; draftMedianMs: number | null }; textAdded: string[]; textRemoved: string[] };

/** The slot a word names: an app plugin's folder or id, or a vault plugin's name or path. */
export function slotFor(word: string): DraftSlot {
  const w = word.replace(/\\/g, "/").replace(/^\.\//, "");
  const folder = appPluginFolder(w.startsWith("app/") ? w : `app/${w}`);
  if (folder) return appSlot(folder);
  const m = /^(?:\.vault-chat\/plugins\/)?([^/]+?)(?:\.draft)?(\.m?js)?$/i.exec(w);
  if (!m) throw new Error(`${word}: not an app plugin or a vault plugin`);
  return vaultSlot(m[1]!, m[2] ?? ".js");
}

const norm = (s: string) => s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "<time>").replace(/\s+/g, " ").trim();

/** Compare the two sides. Pure, for tests. `failText`: a visible line only the draft's side has that fails it (the
 *  preset's "skipped" line). */
export function judge(plugin: string, version: string, live: Side, draft: Side, failText?: RegExp): Verdict {
  const reasons: string[] = [];
  let fail = false;
  let border = false;
  if (!draft.ran) {
    fail = true;
    reasons.push("the draft did not run on its side (it failed to load or mount: see its .error.txt)");
  }
  const seen = new Set(live.errors.map(norm));
  const fresh = [...new Set(draft.errors.map(norm))].filter((e) => !seen.has(e));
  if (fresh.length) {
    fail = true;
    reasons.push(`errors only with the draft: ${fresh.slice(0, 5).join(" | ")}`);
  }
  const lt = new Set(live.text.map(norm).filter(Boolean));
  const dt = new Set(draft.text.map(norm).filter(Boolean));
  const textAdded = [...dt].filter((l) => !lt.has(l));
  const textRemoved = [...lt].filter((l) => !dt.has(l));
  const bad = failText ? textAdded.filter((l) => failText.test(l)) : [];
  if (bad.length) {
    fail = true;
    reasons.push(`only with the draft: ${bad.slice(0, 3).join(" | ")}`);
  }
  if (textAdded.length || textRemoved.length) {
    border = true;
    reasons.push(`the visible text differs (${textAdded.length} lines new, ${textRemoved.length} gone): check it is what was asked for, and only that`);
  }
  const lm = slowMedian(live.typingMs) ?? (live.typingMs.length ? stats(live.typingMs).medianMs : null);
  const dm = slowMedian(draft.typingMs) ?? (draft.typingMs.length ? stats(draft.typingMs).medianMs : null);
  if (dm !== null && dm > TRY_SLOW_MS) {
    fail = true;
    reasons.push(`typing with the draft: median ${dm.toFixed(1)} ms a key, over the typing limit of ${TRY_SLOW_MS} ms`);
  } else if (dm !== null && lm !== null && dm > lm * 1.5 + 5) {
    border = true;
    reasons.push(`typing is slower with the draft: median ${dm.toFixed(1)} ms against ${lm.toFixed(1)} ms`);
  }
  if (!reasons.length) reasons.push("no new errors, the same visible text, typing as fast");
  return { verdict: fail ? "fail" : border ? "borderline" : "pass", reasons, plugin, version, live, draft, typing: { liveMedianMs: lm, draftMedianMs: dm }, textAdded, textRemoved };
}

// ---------------------------------------------------------------- running it

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

async function waitHttp(url: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`the preview harness did not answer at ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In the page: errors, typing samples, visible lines, whether the plugin's copy runs. */
const INSTALL = `(() => {
  const w = window;
  w.__gate = { errors: [], ms: [] };
  w.addEventListener('error', e => w.__gate.errors.push(String(e.message || e.error || 'error')));
  w.addEventListener('unhandledrejection', e => w.__gate.errors.push('unhandled: ' + String((e.reason && e.reason.message) || e.reason)));
  const ce = console.error.bind(console);
  console.error = (...a) => { w.__gate.errors.push(a.map(x => String((x && x.message) || x)).join(' ').slice(0, 300)); ce(...a); };
  w.addEventListener('input', e => {
    const t = e.target; if (!t || !t.closest || !t.closest('[data-perf-target="composer"], [data-el="composer"]')) return;
    const t0 = performance.now();
    requestAnimationFrame(() => requestAnimationFrame(() => w.__gate.ms.push(performance.now() - t0)));
  }, true);
})()`;

const find = (target: string | { text: string }) =>
  typeof target === "string"
    ? `document.querySelector(${JSON.stringify(target)})`
    : `[...document.querySelectorAll('button,a,[role],[title],[aria-label],span,div')].find(e => (e.getAttribute('aria-label')||e.getAttribute('title')||e.textContent||'').trim() === ${JSON.stringify(target.text)})`;

async function key(cdp: any, sid: string, chord: string): Promise<void> {
  const parts = chord.split("+");
  const k = parts.pop()!;
  const modifiers = (parts.includes("Alt") ? 1 : 0) | (parts.includes("Control") || parts.includes("Ctrl") ? 2 : 0) | (parts.includes("Meta") ? 4 : 0) | (parts.includes("Shift") ? 8 : 0);
  const text = k.length === 1 && !(modifiers & 7) ? k : undefined;
  const code = k.length === 1 ? (/[a-z]/i.test(k) ? `Key${k.toUpperCase()}` : undefined) : k;
  const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : ({ Enter: 13, Escape: 27, Tab: 9, Backspace: 8 } as Record<string, number>)[k];
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, modifiers, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) }, sid);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, modifiers, windowsVirtualKeyCode: vk }, sid);
}

async function runSide(cdp: any, url: string, plugin: string, steps: Step[], keys: number, ranBy: "plugin" | "page" | "app" = "plugin"): Promise<Side> {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false }, sid);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTALL }, sid);
    await cdp.send("Page.navigate", { url }, sid);
    let ready = false;
    for (let t = Date.now(); !ready && Date.now() - t < START_MS; await sleep(250)) ready = await evalIn(cdp, sid, `!!(window.__preview && __preview.ready && __preview.stepsDone)`).catch(() => false);
    if (!ready) {
      const errs: string[] = await evalIn(cdp, sid, `(window.__gate && __gate.errors.slice(0, 5)) || []`).catch(() => []);
      // A whole app that never comes up (a core bundle that does not boot) is that side's verdict, not a harness failure.
      if (ranBy === "app") return { errors: errs.length ? errs : [`the app did not start within ${START_MS / 1000} s`], text: [], ran: false, typingMs: [] };
      throw new Error(`${url}: the app did not start within ${START_MS / 1000} s${errs.length ? ` (errors: ${errs.join(" | ").slice(0, 600)})` : ""}`);
    }
    await sleep(2500); // the copies are read and mounted (the folder is looked at every 2 s)
    for (const s of steps) {
      if (s.wait !== undefined) await sleep(Math.min(30_000, Number(s.wait) || 0));
      else if (s.press) await key(cdp, sid, s.press);
      else if (s.type !== undefined) for (const ch of s.type) await key(cdp, sid, ch);
      else if (s.click !== undefined) {
        const ok = await evalIn(cdp, sid, `(() => { const e = ${find(s.click)}; if (!e) return false; e.click(); return true; })()`);
        if (!ok) throw new Error(`step ${JSON.stringify(s)}: nothing to click`);
      } else if (s.waitFor !== undefined) {
        let seen = false;
        for (let t = Date.now(); !seen && Date.now() - t < (s.timeout ?? 8000); await sleep(150)) seen = await evalIn(cdp, sid, `!!(${find(s.waitFor)})`);
        if (!seen) throw new Error(`step ${JSON.stringify(s)}: never appeared`);
      }
      await sleep(300);
    }
    // The page's text without a change notice, if one shows (older cores showed one on the draft's side only).
    const text: string[] = await evalIn(cdp, sid, `(() => { const n = document.querySelector('[data-el="change-ready"]'); if (n) n.style.display = 'none'; const t = document.body.innerText.split('\\n'); if (n) n.style.display = ''; return t; })()`);
    const ran: boolean = await evalIn(cdp, sid, `!!document.querySelector('[data-vc-plugin=${JSON.stringify(JSON.stringify(plugin)).slice(1, -1)}]')`);
    const copy: string | null = await evalIn(cdp, sid, `(document.querySelector('[data-vc-plugin=${JSON.stringify(JSON.stringify(plugin)).slice(1, -1)}][data-vc-copy]')||{getAttribute:()=>null}).getAttribute('data-vc-copy')`);
    // Typing in the composer, as typing-bench does (never sent: cleared after).
    const has = await evalIn(cdp, sid, `!!(document.querySelector('[data-perf-target="composer"]') || document.querySelector('[data-el="composer"] textarea'))`);
    if (has && keys > 0) {
      await evalIn(cdp, sid, `(document.querySelector('[data-perf-target="composer"]') || document.querySelector('[data-el="composer"] textarea')).focus(); __gate.ms.length = 0; true`);
      for (let i = 0; i < keys + 4; i++) {
        await key(cdp, sid, TEXT[i % TEXT.length]!);
        await sleep(40);
      }
      await sleep(300);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, commands: ["selectAll"] }, sid);
      await key(cdp, sid, "Backspace");
    }
    const g = await evalIn(cdp, sid, `({ errors: __gate.errors.slice(0, 50), ms: __gate.ms.slice(4) })`);
    // A part that is no plugin mount (the preset): it ran when the app started with it.
    // A whole app (a core bundle): it ran when its plugins mounted (a bundle that never boots mounts none).
    const mounted: number = ranBy === "app" ? await evalIn(cdp, sid, `document.querySelectorAll('[data-vc-plugin]').length`) : 0;
    return { errors: g.errors, text, ran: ranBy === "app" ? mounted > 0 : ranBy === "page" ? true : plugin.startsWith("app/") ? copy !== null || ran : ran, typingMs: g.ms, copy } as Side & { copy: string | null };
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// ---------------------------------------------------------------- the data: a safe copy of the box's real data

/** The installed capture helper the ship script's real-data gate runs (its config's realCopySource), or why not. */
export function realCopySource(config = process.env.VC_SHIP_CONFIG || join(userInfo().homedir, ".local/lib/vault-chat/simple-ship/config.json")): { python: string; script: string; home: string; live: string } | { error: string } {
  try {
    const s = JSON.parse(readFileSync(config, "utf8"))?.realCopySource;
    if (s && typeof s.python === "string" && typeof s.script === "string" && typeof s.home === "string" && typeof s.live === "string" && existsSync(s.script)) return { python: s.python, script: s.script, home: s.home, live: s.live };
    return { error: `${config} names no real-copy capture helper` };
  } catch (e) {
    return { error: `no ship config with a real-copy capture helper (${(e as Error).message})` };
  }
}

/**
 * A fresh secret-filtered copy of the box's real data in `scratch` (the helper only reads the live data and the box's
 * loopback API, and refuses to write inside the vaults or the box's state), as the ship script's capture does; the
 * vault's folder in it. Tried twice: the helper refuses when the data changes while it copies.
 */
export async function captureRealData(vault: string, scratch: string, src = realCopySource()): Promise<string> {
  if ("error" in src) throw new Error(`${src.error}: no real data to check on (--synthetic runs on the synthetic vault, --data <dir> on a copy you name)`);
  let last = "";
  const until = Date.now() + (Number(process.env.VC_DRAFT_CHECK_CAPTURE_MS) || 20 * 60_000);
  const gap = Number(process.env.VC_DRAFT_CHECK_CAPTURE_GAP_MS) || 60_000;
  for (let i = 0; i < 2 || Date.now() + gap < until; i++) {
    if (i >= 2) {
      console.log(`the real-data capture failed (${last.slice(0, 200)}); trying again in ${Math.round(gap / 1000)} s`);
      await new Promise((r) => setTimeout(r, gap));
    }
    const out = join(scratch, `real-capture-${i}`);
    const r = await new Promise<{ code: number | null; text: string }>((res) => {
      const c = spawn(src.python, [src.script, "--home", src.home, "--live", src.live.replace(/\/$/, ""), "--out", out], { cwd: scratch, env: { PATH: process.env.PATH ?? "", HOME: scratch, LANG: "C.UTF-8", __ETC_PROFILE_DONE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      c.stdout.on("data", (d) => (text += d));
      c.stderr.on("data", (d) => (text = (text + d).slice(-4000)));
      const t = setTimeout(() => c.kill("SIGKILL"), 5 * 60_000);
      c.on("close", (code) => (clearTimeout(t), res({ code, text })));
      c.on("error", (e) => (clearTimeout(t), res({ code: -1, text: e.message })));
    });
    last = r.text.trim().split("\n").slice(-3).join(" ");
    if (r.code === 0) {
      const name = vault.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!;
      const dir = join(out, "tree", "vc", "vaults", name); // the copy keeps the paths under the home folder
      if (existsSync(dir)) {
        // The box's raw event logs (tens of MB) are not what the harness runs on and stall its start; the conversations,
        // notes and the rest stay. Only this scratch copy is touched.
        rmSync(join(dir, ".vault-chat", "events"), { recursive: true, force: true });
        return dir;
      }
      throw new Error(`the real-data copy has no vault ${name} (it copies the vaults under ${src.home}/vc/vaults)`);
    }
    rmSync(out, { recursive: true, force: true });
  }
  throw new Error(`the real-data capture failed: ${last}`);
}

// ---------------------------------------------------------------- landing by the verdict

/** What the gate writes for a verdict: the one rule for every part (src/gateResult.ts gateDecision), for a plugin. */
export function gateDecision(v: Pick<Verdict, "verdict" | "reasons">, asked: boolean): { change: "keep" | "discard"; reason: string } {
  return sharedDecision("ui-plugin", v, asked);
}

/** Land a verdict: the record through the box, by "gate" (a keep names what it is and the chat that asked). */
export async function landVerdict(vault: string, v: Verdict, asked: boolean, box?: string, o: { what?: string; conv?: string } = {}): Promise<{ text: string; decision: "keep" | "discard" }> {
  const d = gateDecision(v, asked);
  const r = await postBoxChange(vault, { plugin: v.plugin, change: d.change, version: v.version, reason: d.reason, by: "gate", ...(o.what ? { what: o.what } : {}), ...(o.conv ? { conv: o.conv } : {}) }, box);
  return { text: `${d.change === "keep" ? "applied" : "dropped"}: ${r.text} (record ${r.seq})`, decision: d.change };
}

/** The machine-readable last line the box reads (src/gateResult.ts gateLineOf). */
export { GATE_LINE };

/** The UI runner of the gate (scripts/gate.ts, kind ui-plugin and preset). `slot`: a part's files other than a plugin's
 *  (the preset's draft); `ranBy` "page": it ran when the app started with it (no plugin mount to find). */
export async function draftCheck(o: { plugin: string; vault: string; data?: string; synthetic?: boolean; scenario?: string; steps?: Step[]; keys?: number; runs?: number; port?: number; slot?: DraftSlot; ranBy?: "plugin" | "page" | "app"; failText?: RegExp; core?: { files: string; version: string } }): Promise<Verdict> {
  // A core bundle (o.core): no slot; the draft's side boots the built bundle in place of the source (preview ?core=1).
  // The scenario's steps drive the source's store, not the bundle's: both sides start without them (steps=0).
  const slot = o.core ? { plugin: o.plugin, dir: ".vault-chat/none", live: "none.js", draft: "none.draft.js", prev: "none.prev.js" } : (o.slot ?? slotFor(o.plugin));
  const ranBy = o.core ? "app" : (o.ranBy ?? "plugin");
  const dir = join(o.vault, slot.dir);
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined);
  const draft = o.core ? "" : read(slot.draft);
  if (draft === undefined) throw new Error(`no draft: ${slot.dir}/${slot.draft}`);
  const live = o.core ? undefined : read(slot.live);
  const version = o.core ? o.core.version : versionOf(draft);
  const scratch = mkdtempSync(join(tmpdir(), "vc-draft-check-"));
  let serve: ChildProcess | null = null;
  let browser: { close(): Promise<void> } | null = null;
  try {
    // Two copies of the data: the plugin as it runs now, and with the draft beside it (tried on that side only).
    const lay = (name: string, files: Record<string, string | undefined>) => {
      const d = join(scratch, name, slot.dir);
      mkdirSync(d, { recursive: true });
      for (const [f, c] of Object.entries(files)) if (c !== undefined) writeFileSync(join(d, f), c);
      return join(scratch, name);
    };
    const real = o.data || o.synthetic ? null : await captureRealData(o.vault, scratch);
    // The real copy holds the box's data (conversations, notes), not the vault's files: it is laid over the synthetic vault.
    const synthetic = [join(REPO, "demo-vault"), join(REPO, "preview/fixtures/synthetic/vault")].filter(existsSync);
    const base = o.data ? [resolve(o.data)] : real ? [...synthetic, real] : synthetic;
    const bases = {
      "gate-live": { vaultName: "gate", dirs: [...base, lay("live", { [slot.live]: live })] },
      "gate-draft": { vaultName: "gate", dirs: [...base, lay("draft", o.core ? {} : { [slot.live]: live, [slot.draft]: draft })] },
    };
    const port = o.port ?? (await freePort());
    const [bp, ap] = [await freePort(), await freePort()];
    serve = spawn(process.execPath, [join(REPO, "preview/serve.mjs"), "--port", String(port), "--before-port", String(bp), "--after-port", String(ap)], { cwd: REPO, env: { ...process.env, VC_PREVIEW_BASES: JSON.stringify(bases), ...(o.core ? { VC_PREVIEW_CORE_FILES: o.core.files } : {}) }, stdio: ["ignore", "ignore", "pipe"], detached: true });
    let stderr = "";
    serve.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    await waitHttp(`http://127.0.0.1:${port}/before/`, 120_000).catch((e) => {
      throw new Error(`${e.message}\n${stderr}`);
    });
    const b = await launch();
    browser = b;
    const sc = o.scenario ?? "conv-a";
    const url = (base: string, ns: string, extra = "") => `http://127.0.0.1:${port}/before/?scenario=${encodeURIComponent(sc)}&base=${base}&narrate=0&ns=${ns}${o.core ? "&steps=0" : ""}${extra}`;
    const runs = Math.max(1, o.runs ?? 2);
    const sides: { live: Side[]; draft: Side[] } = { live: [], draft: [] };
    for (let r = 0; r < runs; r++) {
      sides.live.push(await runSide(b.cdp, url("gate-live", "gate-a"), slot.plugin, o.steps ?? [], o.keys ?? 24, ranBy));
      sides.draft.push(await runSide(b.cdp, url("gate-draft", "gate-b", o.core ? "&core=1" : `&try=${encodeURIComponent(`${slot.plugin}@${version}`)}`), slot.plugin, o.steps ?? [], o.keys ?? 24, ranBy));
    }
    const merge = (l: Side[]): Side => ({ errors: l.flatMap((s) => s.errors), text: l[l.length - 1]!.text, ran: l.every((s) => s.ran), typingMs: l.flatMap((s) => s.typingMs) });
    const v = judge(slot.plugin, version, merge(sides.live), merge(sides.draft), o.failText);
    v.data = o.data ? `the copy ${o.data}` : real ? "a fresh copy of the box's real data" : "the synthetic vault";
    if (ranBy === "plugin" && slot.plugin.startsWith("app/") && !sides.draft.every((s) => (s as Side & { copy?: string | null }).copy === "draft")) {
      v.verdict = "fail";
      v.reasons = v.reasons.filter((r) => !r.startsWith("no new errors"));
      v.reasons.unshift("the draft's side did not run the draft (its mount says another copy): it failed to load or mount");
    }
    return v;
  } finally {
    await browser?.close().catch(() => {});
    if (serve?.pid) {
      try {
        process.kill(-serve.pid);
      } catch {
        serve.kill();
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const value = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const takes = new Set(["--vault", "--data", "--scenario", "--steps", "--keys", "--runs", "--port", "--out", "--box", "--reason", "--conv"]);
  const plugin = argv.find((a, i) => !a.startsWith("--") && !takes.has(argv[i - 1] ?? ""));
  const vault = value("--vault");
  if (!plugin || !vault) {
    console.error("usage: draft-check.ts <plugin> --vault <vault> [--synthetic | --data <dir>] [--scenario conv-a] [--steps steps.json] [--keys 24] [--runs 2] [--out result.json] [--unasked | --asked] [--box <url>]\n       draft-check.ts <plugin> --vault <vault> --keep | --discard | --back [--reason <line>]");
    return 2;
  }
  // The record by hand: the same one the gate writes (the box moves the files).
  const by = (["keep", "discard", "back"] as const).find((k) => argv.includes(`--${k}`));
  if (by) {
    const slot = slotFor(plugin);
    const f = join(vault, slot.dir, slot.draft);
    const version = by === "back" ? undefined : existsSync(f) ? versionOf(readFileSync(f, "utf8")) : null;
    if (version === null) throw new Error(`no draft: ${slot.dir}/${slot.draft}`);
    const r = await postBoxChange(vault, { plugin: slot.plugin, change: by === "back" ? "switch" : by, ...(version ? { version } : {}), ...(value("--reason") ? { reason: value("--reason") } : {}) }, value("--box"));
    console.log(`${r.text} (record ${r.seq})`);
    return 0;
  }
  // Landing a verdict is the one gate's (scripts/gate.ts): the same runner, the one rule, the one result line.
  if (argv.includes("--unasked") || argv.includes("--asked")) return (await import("./gate.ts")).gateMain(argv);
  const steps = value("--steps") ? (JSON.parse(readFileSync(value("--steps")!, "utf8")) as Step[]) : undefined;
  const num = (f: string) => (value(f) !== undefined ? Number(value(f)) : undefined);
  const v = await draftCheck({ plugin, vault, data: value("--data"), synthetic: argv.includes("--synthetic"), scenario: value("--scenario"), steps, keys: num("--keys"), runs: num("--runs"), port: num("--port") });
  const out = value("--out");
  if (out) writeFileSync(out, JSON.stringify(v, null, 1) + "\n");
  const f = (n: number | null) => (n === null ? "n/a" : `${n.toFixed(1)} ms`);
  console.log(`${v.verdict.toUpperCase()}: ${v.plugin} draft ${v.version} (on ${v.data ?? "the synthetic vault"})`);
  for (const r of v.reasons) console.log(`- ${r}`);
  console.log(`typing (composer, median a key): live ${f(v.typing.liveMedianMs)}, draft ${f(v.typing.draftMedianMs)}`);
  if (v.textAdded.length) console.log(`text only with the draft:\n${v.textAdded.slice(0, 20).map((l) => `  + ${l}`).join("\n")}`);
  if (v.textRemoved.length) console.log(`text gone with the draft:\n${v.textRemoved.slice(0, 20).map((l) => `  - ${l}`).join("\n")}`);
  return v.verdict === "pass" ? 0 : v.verdict === "borderline" ? 3 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e?.message ?? e));
      process.exit(2);
    },
  );
}
