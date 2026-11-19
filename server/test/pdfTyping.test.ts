// A big PDF must never slow typing anywhere in the app. Carl opened a 617-page book beside a markdown note and the
// composer went to 67 ms a key (limit 50, normal ~18-20): pdf.js drew its pages into CPU-backed canvases that the
// compositor copied again on every frame, and two IntersectionObservers watched every page wrapper (src/PdfView.tsx).
//
// The real desktop frontend in the preview harness (preview/serve.mjs, one Vite dev server), in the box's headless
// Chromium at a laptop's speed (CPU throttled 4x, device pixel ratio 2): a 640-page PDF in split view beside a note
// in the editor, then keys into the composer and into the note's editor, each timed from its input event to two
// animation frames later (scripts/typing-bench.mjs, docs/perf-baseline.md). Both medians must stay under 50 ms.
// Serial (server/vitest.config.ts SERIAL): timing needs a quiet machine. Skipped where there is no browser.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp, cleanup, ROOT } from "./helpers";
import { findBrowser } from "../headless";
import { launch, evalIn } from "../../scripts/typing-bench.mjs";

export const LIMIT_MS = 50;
const PAGES = 640;
const KEYS = 30;
const WARMUP = 5;
const ATTEMPTS = 3;
const browser = findBrowser();

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (a: number[]) => {
  const v = [...a].sort((x, y) => x - y);
  return v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2;
};

let dir = "";
let serve: ChildProcess | null = null;
let origin = "";

beforeAll(async () => {
  if (!browser) return;
  dir = tmp("vc-pdf-typing-");
  const data = join(dir, "vault");
  mkdirSync(join(data, "books"), { recursive: true });
  execFileSync(process.execPath, [join(ROOT, "preview/fixtures/synthetic/make-big-pdf.mjs"), "--pages", String(PAGES), "--out", join(data, "books", "big.pdf")], { stdio: "ignore" });
  const bases = { "pdf-typing": { vaultName: "pdf-typing", dirs: [join(ROOT, "demo-vault"), join(ROOT, "preview/fixtures/synthetic/vault"), data] } };
  const [port, bp, ap] = [await freePort(), await freePort(), await freePort()];
  serve = spawn(process.execPath, [join(ROOT, "preview/serve.mjs"), "--port", String(port), "--before-port", String(bp), "--after-port", String(ap)], {
    cwd: ROOT,
    env: { ...process.env, VC_PREVIEW_BASES: JSON.stringify(bases) },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let stderr = "";
  serve.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  origin = `http://127.0.0.1:${port}/before`;
  for (let t = Date.now(); ; await sleep(500)) {
    const ok = await fetch(`${origin}/`).then((r) => r.ok, () => false);
    if (ok) break;
    if (Date.now() - t > 150_000) throw new Error(`the preview harness did not start\n${stderr}`);
  }
}, 180_000);

afterAll(() => {
  if (serve?.pid) {
    try {
      process.kill(-serve.pid);
    } catch {
      serve.kill();
    }
  }
  if (dir) cleanup(dir);
});

type Run = { composer: number[]; editor: number[]; pages: number; canvases: number };

/** One fresh page: the note in the editor, the PDF split beside it, keys into the composer and the editor. */
async function run(cdp: any): Promise<Run> {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 960, deviceScaleFactor: 2, mobile: false }, sid);
    await cdp.send("Page.navigate", { url: `${origin}/?scenario=conv-a&base=pdf-typing&narrate=0` }, sid);
    const composer = `document.querySelector('[data-perf-target="composer"]') || document.querySelector('[data-el="composer"] textarea')`;
    let ready = false;
    for (let t = Date.now(); !ready && Date.now() - t < 150_000; await sleep(300))
      ready = await evalIn(cdp, sid, `!!(window.__preview && __preview.ready && __preview.stepsDone && (${composer}))`).catch(() => false);
    if (!ready) throw new Error("the app did not come up with a composer");
    let note = "# Notes beside the book\n\n";
    for (let i = 1; i <= 60; i++) note += `## Section ${i}\n\nA paragraph about section ${i}, with $x_${i}$ and **bold**, long enough to wrap in the pane.\n\n- a\n- b\n\n`;
    const opened = await evalIn(
      cdp,
      sid,
      `(async () => {
        const { useStore } = await import("${new URL(origin).pathname}/src/store.ts");
        const S = () => useStore.getState();
        S().setMode("edit");
        S().setCurrentFile(S().vaultPath + "/notes/beside.md", ${JSON.stringify(note)});
        await new Promise((r) => setTimeout(r, 500));
        S().splitWith(S().vaultPath + "/books/big.pdf", "", "right");
        for (let t = performance.now(); performance.now() - t < 120000; await new Promise((r) => setTimeout(r, 100))) {
          const c = document.querySelector('canvas.pdf-page[data-page="1"]');
          if (c && c.width > 0 && document.querySelector(".cm-content")) return true;
        }
        return false;
      })()`,
    );
    if (!opened) throw new Error("the PDF did not open in split view beside the note");
    // A laptop's speed, from here on: the box's cores are several times a laptop's.
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }, sid);
    await sleep(4000);
    const shape = await evalIn(cdp, sid, `({ pages: document.querySelectorAll(".pdf-page-wrap").length, canvases: document.querySelectorAll("canvas.pdf-page").length })`);
    await evalIn(cdp, sid, `(() => { window.__ms = []; window.addEventListener("input", () => { const t0 = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => window.__ms.push(performance.now() - t0))); }, true); return true; })()`);
    const TEXT = "the quick brown fox jumps over the lazy dog ";
    const typeInto = async (focus: string): Promise<number[]> => {
      await evalIn(cdp, sid, `(() => { window.__ms = []; (${focus}).focus(); return true; })()`);
      for (let i = 0; i < WARMUP + KEYS; i++) {
        const text = TEXT[i % TEXT.length]!;
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", text, key: text, unmodifiedText: text }, sid);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: text }, sid);
        await sleep(80);
      }
      await sleep(500);
      const ms: number[] = await evalIn(cdp, sid, `window.__ms`);
      if (ms.length < KEYS) throw new Error(`only ${ms.length} of ${WARMUP + KEYS} keys reached ${focus}`);
      return ms.slice(WARMUP);
    };
    const c = await typeInto(composer);
    const e = await typeInto(`document.querySelector(".cm-content")`);
    return { composer: c, editor: e, ...shape };
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }, sid).catch(() => {});
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

describe("typing beside a big PDF (preview harness, headless Chromium)", () => {
  it.skipIf(!browser)(
    `a ${PAGES}-page PDF in split view: composer and editor keystroke-to-paint medians under ${LIMIT_MS} ms`,
    async () => {
      const { cdp, close } = await launch();
      const seen: string[] = [];
      let best: { composer: number; editor: number } | null = null;
      try {
        // A timing on a shared machine can catch a busy moment: the best of a few fresh tries is the app's number.
        for (let a = 0; a < ATTEMPTS; a++) {
          const r = await run(cdp);
          expect(r.pages).toBe(PAGES);
          const m = { composer: median(r.composer), editor: median(r.editor) };
          seen.push(`try ${a + 1}: composer ${m.composer.toFixed(1)} ms, editor ${m.editor.toFixed(1)} ms (${r.canvases} page canvases)`);
          if (!best || Math.max(m.composer, m.editor) < Math.max(best.composer, best.editor)) best = m;
          if (m.composer < LIMIT_MS && m.editor < LIMIT_MS) break;
        }
      } finally {
        await close();
      }
      console.log(`[pdf typing] ${seen.join("; ")}`);
      expect(best!.composer, seen.join("; ")).toBeLessThan(LIMIT_MS);
      expect(best!.editor, seen.join("; ")).toBeLessThan(LIMIT_MS);
    },
    600_000,
  );
});
