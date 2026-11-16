// The chat transcript's render speed on a very long chat (scenario chat-long: 600 turns, 1 200+ rows of every kind).
//   node preview/tools/chat-rows-perf.mjs [--url http://127.0.0.1:1521/after] [--runs 9]
// Measures, in the page (performance.now, to the second animation frame after the change):
//   open    switching to the long chat (its last 60 rows render)
//   older   each "load older" step (scrolled to the top: 60 more rows), and the whole history loaded
//   typing  a key in the composer to the next frame, with the whole history on screen
// Prints JSON: medians and p90s in ms.
import { launch } from "./browser.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const origin = arg("url", process.env.PREVIEW_AFTER ?? "http://127.0.0.1:1521/after");
const runs = Number(arg("runs", 9));
const { browser, page, log } = await launch({ width: 1400, height: 900 });
try {
  await page.goto(`${origin}/?scenario=chat-long&narrate=0`, { timeout: 60000 });
  await page.waitForSelector("[data-message-id]", { timeout: 60000 });
  await page.waitForTimeout(1500);
  const base = new URL(origin).pathname.replace(/\/$/, "");
  const out = await page.evaluate(async ({ base, runs }) => {
    const { useStore } = await import(`${base}/src/store.ts`);
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const list = () => document.querySelector("[data-message-id]")?.parentElement;
    const rows = () => list()?.childElementCount ?? 0;
    const until = async (f, ms = 20000) => {
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
    const open = [];
    for (let k = 0; k < runs; k++) {
      useStore.getState().selectConversation("c-spectral");
      await until(() => !document.querySelector("[data-message-id]") || rows() < 40);
      await frames();
      await new Promise((r) => setTimeout(r, 200));
      const t = performance.now();
      useStore.getState().selectConversation("c-perf");
      await until(() => rows() >= 60);
      await frames();
      open.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 200));
    }
    // Load the whole history, a window at a time, as scrolling to the top does.
    const scroller = list().parentElement;
    const older = [];
    const t0 = performance.now();
    let n = rows();
    for (let k = 0; k < 100; k++) {
      const t = performance.now();
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
      try {
        await until(() => rows() > n, 3000);
      } catch {
        break;
      }
      await frames();
      older.push(performance.now() - t);
      n = rows();
    }
    const all = performance.now() - t0;
    return { open: stats(open), older: stats(older), allHistoryMs: +all.toFixed(0), rowsOnScreen: rows() };
  }, { base, runs });
  // Typing with the whole history on screen: keydown → the next frame.
  const box = page.locator("textarea").first();
  await box.click();
  await page.evaluate(() => {
    window.__keyLat = [];
    document.addEventListener("keydown", (e) => {
      const t = e.timeStamp;
      requestAnimationFrame(() => setTimeout(() => window.__keyLat.push(performance.now() - t), 0));
    }, true);
  });
  for (const ch of "the quick brown fox jumps over the lazy dog again and again") {
    await page.keyboard.type(ch);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(300);
  const lat = await page.evaluate(() => window.__keyLat);
  const s = [...lat].sort((x, y) => x - y);
  out.typing = { n: s.length, median: +s[Math.floor(s.length / 2)].toFixed(1), p90: +s[Math.floor(s.length * 0.9)].toFixed(1) };
  out.pageErrors = log.pageErrors.length;
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
}
