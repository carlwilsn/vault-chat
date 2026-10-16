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
let silentOrder = [];
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

  // 3. A turn that reasons silently (OpenAI-family reasoning via OpenRouter streams no text),
  // then writes a long Write: fullscreen shows "Thinking", then "Write", then "Write dog.svg",
  // before the answer — never blank until it all lands at once ("draw an svg of a dog").
  const sp = await context.newPage();
  await sp.goto(`${base}/?scenario=conv-a&side=before&narrate=0&steps=0`);
  await sp.waitForFunction(() => window.__preview?.ready, null, { timeout: 30000 });
  await sp.waitForTimeout(1200);
  await sp.keyboard.press("Control+Shift+F");
  await sp.waitForSelector("[data-el='chats-sidebar']");
  await sp.evaluate(() => window.__preview.play(0));
  await sp.evaluate(() => {
    const w = window;
    w.__order = [];
    const mark = (k) => w.__order.at(-1) !== k && w.__order.push(k);
    setInterval(() => {
      const silent = !!document.querySelector("[data-el='live-thinking'][data-silent]");
      const tool = document.querySelector("[data-el='live-tool']")?.textContent ?? "";
      const answer = [...document.querySelectorAll(".prose-chat")].some((e) => /Saved as dog\.svg/.test(e.textContent ?? ""));
      if (answer) mark("answer");
      else if (silent && tool) mark("both");
      else if (/Write\s*dog\.svg/.test(tool)) mark("tool+path");
      else if (/Write/.test(tool)) mark("tool");
      else if (silent) mark("thinking");
    }, 40);
  });
  const C = "x-full";
  const rt = (o) => ({ type: "runtime", convId: C, text: "", offset: 0, delta: "", len: 0, ...o });
  const playBox = (st) => sp.evaluate((s) => window.__preview.boxPlay(s), st);
  await playBox({ meta: { [C]: { state: "running" } }, status: { [C]: "running" }, events: [{ type: "status", convId: C, status: "running" }] });
  await sp.waitForTimeout(1500); // reasoning, nothing streamed
  await playBox({ events: [rt({ tool: "Write" })] }); // the call starts; its path comes after the content
  await sp.waitForTimeout(1500);
  await playBox({ events: [rt({ tool: "Write", toolArg: "dog.svg" })] });
  await sp.waitForTimeout(1500);
  await playBox({
    append: { [C]: [{ role: "assistant", mid: "m_dog", content: "Saved as dog.svg.", toolCalls: [{ id: "call_dog", name: "Write", input: { path: "dog.svg", content: "<svg/>" }, result: "Successfully wrote to dog.svg" }] }] },
    meta: { [C]: { state: "idle" } },
    status: { [C]: "idle" },
    events: [{ type: "message", convId: C, role: "assistant" }, { type: "status", convId: C, status: "idle" }],
  });
  await sp.waitForTimeout(2500);
  silentOrder = await sp.evaluate(() => window.__order);
} finally {
  await browser.close();
}

let bad = 0;
const want = ["thinking", "tool", "tool+path", "answer"];
const silentOk = JSON.stringify(silentOrder) === JSON.stringify(want);
if (!silentOk) bad++;
console.log(`${silentOk ? "ok  " : "FAIL"} silent     seen in order: ${silentOrder.join(" → ") || "nothing"}${silentOk ? "" : ` — want ${want.join(" → ")}`}`);
for (const r of results) {
  const missing = ["running", "thinking", "tool", "streaming"].filter((k) => !r.seen.includes(k));
  if (missing.length) bad++;
  console.log(`${missing.length ? "FAIL" : "ok  "} ${r.where.padEnd(10)} seen while running: ${r.seen.join(", ") || "nothing"}${missing.length ? ` — missing ${missing.join(", ")}` : ""}`);
}
const errs = log.console.filter((m) => m.type === "error").concat(log.pageErrors);
for (const e of errs) console.log(`  console: ${String(e.text).split("\n")[0].slice(0, 200)}`);
process.exit(bad ? 1 : 0);
