// The background-tasks proof (scenarios/background.ts): one muted, headless run of the real desktop frontend
// recorded to video, with screenshots at the moments that matter and what the page measured at each.
//   node preview/tools/bg-proof.mjs [--origin http://127.0.0.1:1520/before] [--out preview/proof/bg-tasks]
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const origin = opt("origin", process.env.PREVIEW_BEFORE ?? "http://127.0.0.1:1520/before");
const out = resolve(opt("out", join(HERE, "..", "proof", "bg-tasks")));
mkdirSync(out, { recursive: true });
const size = { width: 1400, height: 900 };

const { browser, context, page } = await launch({ ...size, recordVideo: { dir: out, size } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${origin}/?scenario=bg-tasks&side=before&overlay=0`, { timeout: 180000 });

// What the chat shows now: the chip, its rows, the thread's last lines.
const look = () =>
  page.evaluate(() => {
    const t = (sel) => [...document.querySelectorAll(sel)].map((e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());
    return {
      chip: t("[data-el='subagents'][data-variant='strip'] [data-el='tasks-chip']")[0] ?? null,
      inlineChips: t("[data-el='subagents'][data-variant='inline'] [data-el='tasks-chip']"),
      rows: [...document.querySelectorAll("[data-el='task']")].map((e) => ({ state: e.getAttribute("data-state"), text: (e.textContent ?? "").replace(/\s+/g, " ").trim(), stop: !!e.querySelector("[data-el='task-stop']"), steer: !!e.querySelector("[data-el='task-steer']") })),
      pulse: !!document.querySelector("[data-el='subagents'] [data-el='task-pulse']"),
      taskEnd: t("[data-el='task-end']"),
      raw: document.body.innerText.includes("## Completed"),
      tokens: /\d+ tokens\b/.test(document.body.innerText),
      open: document.querySelector("[data-el='subagents'][data-variant='strip']")?.getAttribute("data-open") === "1",
      stripPx: document.querySelector("[data-el='subagents'][data-variant='strip']")?.getBoundingClientRect().height ?? 0,
      text: document.body.innerText,
      busy: !!document.querySelector("[data-el='live-thinking']"),
      last: t(".prose-chat").slice(-3),
    };
  });

const shots = [];
const shot = async (name, until, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    const l = await look();
    if (until(l)) {
      await page.screenshot({ path: join(out, `${name}.png`) });
      shots.push({ name, at: Date.now(), ...l });
      return l;
    }
    if (Date.now() - t0 > ms) {
      await page.screenshot({ path: join(out, `${name}-TIMEOUT.png`) });
      throw new Error(`${name}: not seen within ${ms} ms: ${JSON.stringify(l)}`);
    }
    await page.waitForTimeout(150);
  }
};

try {
  // Closed by default: one line, never opened on its own.
  await shot("1-started-turn-over", (l) => /2 background tasks running/.test(l.chip ?? "") && !l.open && l.stripPx < 40 && l.last.some((x) => /in the background/.test(x)));
  await shot("2-moving-reading", (l) => /reading notes\/physics/.test(l.chip ?? "") && !l.open);
  await shot("3-moving-writing", (l) => /writing physics\.html/.test(l.chip ?? "") && !l.open);
  await shot("4-answered-while-running", (l) => l.last.some((x) => /Brought it back/.test(x)) && /running/.test(l.chip ?? "") && !l.open);
  // The scenario clicks the chip: the list opens (Stop, Steer).
  await shot("5-list-open-stop-steer", (l) => l.open && l.rows.some((r) => r.state === "running" && r.stop && r.steer));
  // Esc folds it (and never stops the agent); a click opens it again; a click elsewhere folds it.
  await page.keyboard.press("Escape");
  await shot("5b-esc-folds", (l) => !l.open && l.rows.length === 0, 3000);
  await page.click("[data-el='tasks-chip']");
  await shot("5c-click-opens", (l) => l.open, 3000);
  await page.mouse.click(1150, 300);
  await shot("5d-outside-click-folds", (l) => !l.open, 3000);
  await shot("6-moving-check", (l) => /running node check-physics.js/.test(l.chip ?? ""));
  // The chat closed: the titlebar says how many run; a click on it opens the chat again.
  await page.click("button[title*='chat panel']");
  await shot("6b-chat-closed-titlebar", () => true, 1000).then(async () => {
    const t = await page.textContent("[data-el='titlebar-tasks']").catch(() => null);
    shots.at(-1).titlebar = t;
    if (!/2 running/.test(t ?? "")) throw new Error("titlebar: " + t);
  });
  await page.click("[data-el='titlebar-tasks']");
  // Done: the job leaves the screen (no row, no folded chip); the reply carries the result; the dev server stays in the one line.
  await shot("7-done-leaves-the-screen", (l) => l.last.some((x) => /physics animation is ready/.test(x)) && /^1 background task running.*ready on http/.test(l.chip ?? "") && l.taskEnd.length === 0 && l.inlineChips.length === 0 && !/Background task finished/.test(l.text), 25000);
  // Nothing runs: the chip is gone.
  await shot("8-nothing-running-no-chip", (l) => !l.chip && l.inlineChips.length === 0, 15000);
  await page.waitForTimeout(1000);
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  try {
    renameSync(await video.path(), join(out, "bg-tasks.webm"));
  } catch (e) {
    console.error("video:", e);
  }
  writeFileSync(join(out, "result.json"), JSON.stringify({ origin, shots, errors }, null, 1));
}
console.log(JSON.stringify(shots.map((s) => ({ name: s.name, chip: s.chip, open: s.open, stripPx: s.stripPx, titlebar: s.titlebar, rows: s.rows, taskEnd: s.taskEnd, inline: s.inlineChips, raw: s.raw, tokens: s.tokens })), null, 1));
if (errors.length) console.log("page errors:", errors);
