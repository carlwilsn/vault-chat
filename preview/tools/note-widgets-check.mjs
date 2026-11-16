// Live widgets inside notes (scenario note-widgets, src/NoteWidget.tsx), on the real frontend:
//   --widgets: the widgets mount in place in the long note (two outlines listing their section's headings, the broken
//              one an error card, the missing one a card), the last one only once scrolled near, a checkbox click is
//              kept, an edit of the note redraws them; shots → --out.
//   timing (always): opening a long note (long-plain.md, ~60 KB) from a short one, and long-widgets.md where the side
//              has widgets: setCurrentFile to two frames after its last heading is drawn; median / p95 of --n runs.
//   node preview/tools/note-widgets-check.mjs --url http://127.0.0.1:1500/after [--widgets] [--n 15] [--out dir]
import { mkdirSync } from "node:fs";
import { launch } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const base = opt("url", "http://127.0.0.1:1500/after");
const N = Number(opt("n", 15));
const OUT = opt("out", "");
const WIDGETS = argv.includes("--widgets");
const fails = [];
const { browser, page, log } = await launch({ width: 1400, height: 900 });

const open = (file) =>
  page.evaluate(async (file) => {
    const prefix = location.pathname.replace(/\/[^/]*$/, "/");
    const { useStore } = await import(/* @vite-ignore */ `${prefix}src/store.ts`);
    const { invoke } = await import(/* @vite-ignore */ `${prefix}node_modules/.vite/deps/@tauri-apps_api_core.js`).catch(() => ({ invoke: window.__TAURI_INTERNALS__.invoke }));
    const vault = useStore.getState().vaultPath;
    const path = `${vault}/${file}`;
    const content = await invoke("read_text_file", { path });
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const t0 = performance.now();
    useStore.getState().setCurrentFile(path, content);
    const last = file === "short.md" ? "Short" : file === "long-plain.md" ? "Part 8" : "The end";
    for (let i = 0; i < 2000; i++) {
      await frame();
      const hs = [...document.querySelectorAll(".prose-md h1, .prose-md h2")];
      if (hs.some((h) => h.textContent.trim() === last) && (file === "short.md" || hs.length > 5)) break;
    }
    await frame();
    return performance.now() - t0;
  }, file);

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { median: +s[Math.floor(s.length / 2)].toFixed(1), p95: +s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)].toFixed(1), n: s.length };
};

try {
  await page.goto(`${base}/?scenario=note-widgets&narrate=0&overlay=0`);
  await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 60000 });
  await page.waitForTimeout(1500);

  if (WIDGETS) {
    const state = () => page.evaluate(() => [...document.querySelectorAll('[data-el="note-widget"]')].map((w) => {
      const host = w.querySelector('[data-el="note-widget-host"]');
      const sr = host?.shadowRoot;
      const shown = sr ? (sr.querySelector(".box, [data-el='plugin-error']")?.textContent ?? "") : w.textContent;
      return { src: w.dataset.src, state: w.dataset.state, text: shown.replace(/\s+/g, " ").trim().slice(0, 300) };
    }));
    let ws = await state();
    console.log(JSON.stringify(ws, null, 1));
    if (ws.length !== 5) fails.push(`${ws.length} widget blocks (want 5)`);
    if (!/This week's parts/.test(ws[0]?.text) || !/Exam prep/.test(ws[0]?.text)) fails.push("the first outline does not list the note's parts");
    if (!/^Before the exam Torque Angular momentum Rolling without slipping$/.test(ws[1]?.text ?? "")) fails.push(`the second outline: "${ws[1]?.text}"`);
    if (!/broken on purpose/.test(ws[2]?.text ?? "") || !/stopped/.test(ws[2]?.text ?? "")) fails.push("the broken widget is not an error card");
    if (!/widget not found: widgets\/not-there\.js/.test(ws[3]?.text ?? "")) fails.push("the missing widget is not a card");
    if (ws[4]?.state !== "idle") fails.push(`the widget at the bottom is ${ws[4]?.state} before it is scrolled to (want idle)`);
    const heads = await page.evaluate(() => document.querySelectorAll(".prose-md h2, .prose-md h3").length);
    if (heads < 12) fails.push("the note around the widgets did not render");
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: `${OUT}/note-widgets-top.png` });
    }
    // A click is kept (its state), and redraws.
    await page.evaluate(() => {
      const sr = document.querySelectorAll('[data-el="note-widget-host"]')[1].shadowRoot;
      sr.querySelectorAll("input")[0].click();
    });
    await page.waitForTimeout(300);
    const done = await page.evaluate(() => document.querySelectorAll('[data-el="note-widget-host"]')[1].shadowRoot.querySelector(".done")?.textContent ?? "");
    if (!/Torque/.test(done)) fails.push("checking Torque did not stick");
    // The note is edited (as the agent's write would): the outline follows, the checked item stays checked.
    await page.evaluate(async () => {
      const prefix = location.pathname.replace(/\/[^/]*$/, "/");
      const { useStore } = await import(/* @vite-ignore */ `${prefix}src/store.ts`);
      const s = useStore.getState();
      s.setCurrentFile(s.currentFile, s.currentContent.replace("### Rolling without slipping", "### Rolling without slipping\n### Precession"));
    });
    await page.waitForTimeout(500);
    ws = await state();
    if (!/Rolling without slipping Precession$/.test(ws[1]?.text ?? "")) fails.push(`after an edit the outline reads "${ws[1]?.text}"`);
    const still = await page.evaluate(() => document.querySelectorAll('[data-el="note-widget-host"]')[1].shadowRoot.querySelector(".done")?.textContent ?? "");
    if (!/Torque/.test(still)) fails.push("the edit lost the checked item");
    // Scrolled to the bottom: the last one mounts.
    await page.evaluate(() => { const sc = document.querySelector("[data-look-scroll]"); sc.scrollTop = sc.scrollHeight; });
    await page.waitForTimeout(800);
    ws = await state();
    if (ws[4]?.state !== "running" || !/Last thing/.test(ws[4]?.text ?? "")) fails.push(`the bottom widget after scrolling: ${JSON.stringify(ws[4])}`);
    if (OUT) await page.screenshot({ path: `${OUT}/note-widgets-bottom.png` });
  }

  const has = await page.evaluate(() => !!document.querySelector('[data-el="note-widget"]'));
  const timing = {};
  for (const file of ["long-plain.md", ...(has ? ["long-widgets.md"] : [])]) {
    const xs = [];
    await open("short.md");
    await open(file); // warm (module caches, KaTeX)
    for (let i = 0; i < N; i++) {
      await open("short.md");
      await page.waitForTimeout(50);
      xs.push(await open(file));
    }
    timing[file] = stats(xs);
  }
  console.log(JSON.stringify({ side: base, timing }, null, 1));
  const errs = log.pageErrors.map((e) => e.text).filter((t) => !/broken on purpose/.test(t));
  if (errs.length) fails.push(`page errors: ${errs.join(" | ").slice(0, 400)}`);
} finally {
  await browser.close();
}
if (fails.length) {
  console.log("FAIL\n- " + fails.join("\n- "));
  process.exit(1);
}
console.log("PASS");
