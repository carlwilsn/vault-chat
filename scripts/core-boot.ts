// The core gate's boot check (src/gateResult.ts, frontend-core; scripts/core-publish.ts bootCheck): a built core bundle
// booted in the preview harness in place of the source of the same commit (?core=1, the synthetic vault, no scenario
// steps), side by side with that source. It must come up (its plugins mount) with no errors the source does not have.
// Nothing is written to any vault.
//
// The verdict: fail (it did not come up, or errors only the bundle has), borderline (the visible text differs), pass.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { TRY_SLOW_MS, slowMedian } from "../src/pluginDrafts.ts";
// @ts-expect-error a plain .mjs module (no types)
import { launch, evalIn, stats } from "./typing-bench.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** How long the app may take to start on a side. */
const START_MS = Number(process.env.VC_DRAFT_CHECK_START_MS) || 90_000;

export type Side = { errors: string[]; text: string[]; ran: boolean; typingMs: number[] };
export type Verdict = { verdict: "pass" | "borderline" | "fail"; data?: string; reasons: string[]; plugin: string; version: string; live: Side; draft: Side; typing: { liveMedianMs: number | null; draftMedianMs: number | null }; textAdded: string[]; textRemoved: string[] };

const norm = (s: string) => s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "<time>").replace(/\s+/g, " ").trim();

/** Compare the two sides (the source's, "live", and the bundle's, "draft"). Pure, for tests. */
export function judge(plugin: string, version: string, live: Side, draft: Side): Verdict {
  const reasons: string[] = [];
  let fail = false;
  let border = false;
  if (!draft.ran) {
    fail = true;
    reasons.push("the draft did not run on its side (it did not come up)");
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

async function runSide(cdp: any, url: string): Promise<Side> {
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
      // A whole app that never comes up (a core bundle that does not boot) is that side's verdict, not a harness failure.
      const errs: string[] = await evalIn(cdp, sid, `(window.__gate && __gate.errors.slice(0, 5)) || []`).catch(() => []);
      return { errors: errs.length ? errs : [`the app did not start within ${START_MS / 1000} s`], text: [], ran: false, typingMs: [] };
    }
    await sleep(2500); // its plugins mount
    const text: string[] = await evalIn(cdp, sid, `document.body.innerText.split('\\n')`);
    const g = await evalIn(cdp, sid, `({ errors: __gate.errors.slice(0, 50) })`);
    // It ran when its plugins mounted (a bundle that never boots mounts none).
    const mounted: number = await evalIn(cdp, sid, `document.querySelectorAll('[data-vc-plugin]').length`);
    return { errors: g.errors, text, ran: mounted > 0, typingMs: [] };
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

/** Boot the stored bundle in `files` (its version `version`) beside the source in this checkout, on the synthetic
 *  vault (`vault`: where the source's own files are, for the scratch folder only). */
export async function coreBoot(o: { vault: string; files: string; version: string; runs?: number; port?: number }): Promise<Verdict> {
  const plugin = "app/core";
  const scratch = mkdtempSync(join(tmpdir(), "vc-core-boot-"));
  let serve: ChildProcess | null = null;
  let browser: { close(): Promise<void> } | null = null;
  try {
    const empty = join(scratch, "side");
    mkdirSync(empty, { recursive: true });
    const base = [join(REPO, "demo-vault"), join(REPO, "preview/fixtures/synthetic/vault")].filter(existsSync);
    const bases = {
      "gate-live": { vaultName: "gate", dirs: [...base, empty] },
      "gate-draft": { vaultName: "gate", dirs: [...base, empty] },
    };
    const port = o.port ?? (await freePort());
    const [bp, ap] = [await freePort(), await freePort()];
    serve = spawn(process.execPath, [join(REPO, "preview/serve.mjs"), "--port", String(port), "--before-port", String(bp), "--after-port", String(ap)], { cwd: REPO, env: { ...process.env, VC_PREVIEW_BASES: JSON.stringify(bases), VC_PREVIEW_CORE_FILES: o.files }, stdio: ["ignore", "ignore", "pipe"], detached: true });
    let stderr = "";
    serve.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    await waitHttp(`http://127.0.0.1:${port}/before/`, 120_000).catch((e) => {
      throw new Error(`${e.message}\n${stderr}`);
    });
    const b = await launch();
    browser = b;
    // The scenario's steps drive the source's store, not the bundle's: both sides start without them (steps=0).
    const url = (base: string, ns: string, extra = "") => `http://127.0.0.1:${port}/before/?scenario=conv-a&base=${base}&narrate=0&ns=${ns}&steps=0${extra}`;
    const runs = Math.max(1, o.runs ?? 1);
    const sides: { live: Side[]; draft: Side[] } = { live: [], draft: [] };
    for (let r = 0; r < runs; r++) {
      sides.live.push(await runSide(b.cdp, url("gate-live", "gate-a")));
      sides.draft.push(await runSide(b.cdp, url("gate-draft", "gate-b", "&core=1")));
    }
    const merge = (l: Side[]): Side => ({ errors: l.flatMap((s) => s.errors), text: l[l.length - 1]!.text, ran: l.every((s) => s.ran), typingMs: [] });
    const v = judge(plugin, o.version, merge(sides.live), merge(sides.draft));
    v.data = "the synthetic vault";
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
