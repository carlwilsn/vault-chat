// The live editor reads display math as math, not markdown: in the corpus
// (markdown-corpus-edit), whose last case is Carl's hw3 Problem 4 — `$$`
// blocks right under the prose with lone `=` / `+` / `-` lines inside — no
// sentence is an H1, the only headings are the corpus's own, and each of
// Problem 4's display formulas renders as a math block. The viewer
// (markdown-corpus) shows the same headings.
//   node preview/tools/md-check.mjs [--url http://127.0.0.1:1600/before]
// Needs the preview server running.
import { launch, sideBase } from "./browser.mjs";

const argv = process.argv.slice(2);
const i = argv.indexOf("--url");
const base = i >= 0 ? argv[i + 1] : await sideBase(1600);
const HW3 = "From the vaults: hw3 Problem 4, display math under prose";

/** Scroll the editor top to bottom; every heading line and math block seen, in order. */
const SWEEP = async () => {
  const sc = document.querySelector(".cm-scroller");
  const seen = new Map();
  sc.scrollTop = 0;
  for (let guard = 0; guard < 400; guard++) {
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    const view = sc.querySelector(".cm-content");
    for (const el of view.querySelectorAll(":scope > .cm-line.cm-h, :scope > .cm-math-block, :scope > div > .cm-math-block")) {
      const top = Math.round(el.getBoundingClientRect().top - view.getBoundingClientRect().top);
      const level = el.classList.contains("cm-math-block") ? "math" : [...el.classList].find((c) => /^cm-h\d$/.test(c));
      seen.set(top, { top, level, text: el.textContent.trim().replace(/^#{1,6}\s+/, "").slice(0, 90) });
    }
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) break;
    sc.scrollTop += sc.clientHeight * 0.6;
  }
  return [...seen.values()].sort((a, b) => a.top - b.top);
};

const fails = [];
const { browser, page, log } = await launch({ width: 1400, height: 900 });
try {
  await page.goto(`${base}/?scenario=markdown-corpus-edit&side=before&narrate=0`);
  await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 30000 });
  await page.waitForSelector(".cm-editor .cm-content");
  await page.waitForTimeout(1500);
  const lines = await page.evaluate(SWEEP);
  const heads = lines.filter((l) => l.level !== "math");
  const h1 = heads.filter((l) => l.level === "cm-h1").map((l) => l.text);
  if (JSON.stringify(h1) !== JSON.stringify(["Markdown corpus"])) fails.push(`editor: H1 lines ${JSON.stringify(h1)} (want only "Markdown corpus")`);
  const at = lines.findIndex((l) => l.text === HW3);
  if (at < 0) fails.push("editor: the hw3 Problem 4 case is not in the note");
  else {
    if (lines[at].level !== "cm-h2") fails.push(`editor: the hw3 heading is ${lines[at].level}`);
    const after = lines.slice(at + 1);
    const stray = after.filter((l) => l.level !== "math");
    if (stray.length) fails.push(`editor: headings inside Problem 4: ${JSON.stringify(stray.map((l) => `${l.level} ${l.text}`))}`);
    const math = after.filter((l) => l.level === "math").length;
    if (math !== 8) fails.push(`editor: ${math} display formulas render in Problem 4 (want 8)`);
  }

  // The viewer: the same heading texts.
  await page.goto(`${base}/?scenario=markdown-corpus&side=before&narrate=0`);
  await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const viewHeads = await page.evaluate(() => {
    const root = [...document.querySelectorAll("h1, h2")].find((h) => h.textContent.trim() === "Markdown corpus")?.closest(".markdown, article, [class*='prose']") ?? document;
    return [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter((h) => h.id !== "footnote-label").map((h) => h.textContent.trim());
  });
  const editorHeads = heads.map((l) => l.text);
  if (!viewHeads.includes(HW3)) fails.push("viewer: the hw3 Problem 4 case is not shown");
  const missing = editorHeads.filter((t) => !viewHeads.some((v) => v.replace(/\s+/g, "") === t.replace(/\s+/g, "") || /\$|\\\(/.test(t)));
  if (missing.length) fails.push(`editor headings the viewer doesn't have: ${JSON.stringify(missing)}`);
  if (log.pageErrors.length) fails.push(`page errors: ${log.pageErrors.map((e) => e.text.split("\n")[0]).join(" | ")}`);

  console.log(`editor: ${heads.length} heading lines (${h1.length} H1), ${lines.length - heads.length} display formulas; viewer: ${viewHeads.length} headings`);
} finally {
  await browser.close();
}
if (fails.length) {
  console.log("FAIL\n  " + fails.join("\n  "));
  process.exit(1);
}
console.log("PASS — no prose as headings in the live editor; hw3 Problem 4's formulas render as math");
