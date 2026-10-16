// A running turn shows live in the fullscreen chat and in the chat popout:
// the running state (Stop), the thinking, the tool line, the reply streaming in — while the
// turn runs, not all at once when it ends. conv-a's world (a box vault, the
// fake box's /poll events), its drive stages played one by one.
//   node preview/tools/live-check.mjs [--url http://127.0.0.1:1600/before]
// Needs the preview server running.
import { launch, sideBase } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const base = opt("url", null) ?? (await sideBase(1600));
const STAGES = [0, 1, 2, 3];

/** Sample what the chat shows every 40 ms (in the page). */
const SAMPLER = () => {
  const w = window;
  w.__live = new Set();
  setInterval(() => {
    const has = (s) => !!document.querySelector(s);
    if (has("[title='Stop the agent']")) w.__live.add("running");
    if (has("[data-el='stream']") && has("[title='Stop the agent']")) w.__live.add("streaming");
    if (has("[data-el='live-tool']")) w.__live.add("tool");
    if (has("[data-el='live-thinking']")) w.__live.add("thinking");
  }, 40);
};

async function storeOf(page) {
  return page.evaluateHandle(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/src\/store\.ts/.test(n));
    return (await import(url)).useStore;
  });
}

const results = [];
const { browser, context, page, log } = await launch({ width: 1400, height: 900 });
try {
  // 1. Fullscreen chat (Ctrl+Shift+F) in the main window.
  await page.goto(`${base}/?scenario=conv-a&side=before&narrate=0&steps=0`);
  await page.waitForFunction(() => window.__preview?.ready, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.keyboard.press("Control+Shift+F");
  await page.waitForSelector("[data-el='chats-sidebar']");
  await page.evaluate(SAMPLER);
  for (const i of STAGES) await page.evaluate((n) => window.__preview.play(n), i);
  await page.waitForTimeout(400);
  results.push({ where: "fullscreen", seen: await page.evaluate(() => [...window.__live]) });
  await page.close();

  // 2. The chat popped out: Carl asks in the popout, main runs the turn (the
  // fake box's next steps), the popout window shows it.
  const main = await context.newPage();
  await main.goto(`${base}/?scenario=conv-a&side=before&narrate=0&steps=0`);
  await main.waitForFunction(() => window.__preview?.ready, null, { timeout: 30000 });
  await main.waitForTimeout(1200);
  await main.evaluate(() => window.__preview.play(0)); // open the conversation
  const pop = await context.newPage();
  await pop.setViewportSize({ width: 980, height: 820 });
  await pop.goto(`${base}/?view=chat&scenario=conv-a&side=before&narrate=0`);
  await pop.waitForFunction(() => window.__preview?.ready, null, { timeout: 30000 });
  const store = await storeOf(main);
  await main.evaluate((s) => s.getState().setPopoutOpen(true), store);
  await main.evaluate(() => window.__preview.emit("chat:ready"));
  await pop.waitForSelector("[data-el='chats-sidebar']");
  await pop.evaluate(SAMPLER);
  await pop.fill("textarea", "Write the KV-cache section for the writeup from the attention survey — the methods, a table, and the math for the 4-bit cache.");
  await pop.press("textarea", "Enter");
  await main.waitForTimeout(900);
  for (let i = 0; i < 5; i++) {
    await main.evaluate(() => window.__preview.boxNext());
    await main.waitForTimeout(1200);
  }
  results.push({ where: "popout", seen: await pop.evaluate(() => [...window.__live]) });
} finally {
  await browser.close();
}

let bad = 0;
for (const r of results) {
  const missing = ["running", "thinking", "tool", "streaming"].filter((k) => !r.seen.includes(k));
  if (missing.length) bad++;
  console.log(`${missing.length ? "FAIL" : "ok  "} ${r.where.padEnd(10)} seen while running: ${r.seen.join(", ") || "nothing"}${missing.length ? ` — missing ${missing.join(", ")}` : ""}`);
}
const errs = log.console.filter((m) => m.type === "error").concat(log.pageErrors);
for (const e of errs) console.log(`  console: ${String(e.text).split("\n")[0].slice(0, 200)}`);
process.exit(bad ? 1 : 0);
