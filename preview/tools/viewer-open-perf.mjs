// How fast the viewer opens a large PDF and a long markdown note (the viewer registry must not slow either).
//   PREVIEW_BROWSER=... node preview/tools/viewer-open-perf.mjs [--url http://127.0.0.1:1521/after] [--runs 9]
// Measures, in the page (performance.now, from setCurrentFile to the second animation frame after it is drawn):
//   pdf  papers/attention-survey.pdf (320 pages): its first page's canvas drawn
//   md   a long note (~3 000 lines: headings, paragraphs, lists, code, math): every section rendered
// Each run opens a small note first, so every open is a fresh one. Prints JSON: medians and p90s in ms.
import { launch } from "./browser.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const origin = arg("url", process.env.PREVIEW_AFTER ?? "http://127.0.0.1:1521/after");
const runs = Number(arg("runs", 9));
const { browser, page } = await launch({ width: 1400, height: 900 });
try {
  await page.goto(`${origin}/?scenario=home&narrate=0`, { timeout: 90000 });
  await page.waitForSelector("[data-look-pane]", { timeout: 90000 });
  await page.waitForTimeout(2000);
  const base = new URL(origin).pathname.replace(/\/$/, "");
  const out = await page.evaluate(async ({ base, runs }) => {
    const { useStore } = await import(`${base}/src/store.ts`);
    const S = () => useStore.getState();
    const vault = S().vaultPath;
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const until = async (f, ms = 30000) => {
      const t = performance.now();
      while (!f()) {
        if (performance.now() - t > ms) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    const stats = (a) => {
      const s = [...a].sort((x, y) => x - y);
      const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
      return { n: s.length, median: +q(0.5).toFixed(1), p90: +q(0.9).toFixed(1), min: +s[0].toFixed(1) };
    };
    const SECTIONS = 150;
    let long = "# A long note\n\n";
    for (let i = 1; i <= SECTIONS; i++) {
      long += `## Section ${i}\n\nThe ${i}th part of a long note: a paragraph with *emphasis*, **bold**, \`code\` and a [link](https://example.com). It runs on for a while so the line wraps across the pane like real prose does.\n\n- a list item\n- another with $x^2 + y^2 = z^2$\n- a third\n\n\`\`\`python\ndef f(x):\n    return x * ${i}\n\`\`\`\n\n$$\\int_0^1 x^{${i}} \\, dx = \\frac{1}{${i + 1}}$$\n\nMore text after the math, to close the section.\n\n`;
    }
    const small = "# Small\n\nA small note.\n";
    const pane = () => document.querySelector("[data-look-pane]");
    const openSmall = async () => {
      S().setCurrentFile(`${vault}/notes/small-perf.md`, small);
      await until(() => pane()?.getAttribute("data-file")?.endsWith("small-perf.md") && /A small note/.test(pane()?.textContent ?? ""));
      await frames();
      await new Promise((r) => setTimeout(r, 300));
    };
    const md = [];
    for (let k = 0; k < runs; k++) {
      await openSmall();
      const t = performance.now();
      S().setCurrentFile(`${vault}/notes/long-perf-${k}.md`, long);
      await until(() => (pane()?.querySelector(".prose-md")?.querySelectorAll("h2").length ?? 0) >= SECTIONS);
      await frames();
      md.push(performance.now() - t);
    }
    const pdf = [];
    for (let k = 0; k < runs; k++) {
      await openSmall();
      const t = performance.now();
      S().setCurrentFile(`${vault}/papers/attention-survey.pdf`, "");
      await until(() => {
        const c = pane()?.querySelector('canvas.pdf-page[data-page="1"]');
        return !!c && c.width > 0;
      }, 60000);
      await frames();
      pdf.push(performance.now() - t);
    }
    return { md: stats(md), pdf: stats(pdf), viewer: pane()?.getAttribute("data-viewer") ?? "(none: before)" };
  }, { base, runs });
  console.log(JSON.stringify({ origin, ...out }));
} finally {
  await browser.close();
}
