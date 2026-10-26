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
  await shot("1-started-turn-over", (l) => !!l.chip && /running/.test(l.chip) && l.last.some((x) => /in the background/.test(x)));
  await shot("2-moving-reading", (l) => /reading notes\/physics/.test(l.chip ?? ""));
  await shot("3-moving-writing", (l) => /writing physics\.html/.test(l.chip ?? ""));
  await shot("4-answered-while-running", (l) => l.last.some((x) => /Brought it back/.test(x)) && /running/.test(l.chip ?? ""));
  await shot("5-list-open-stop-steer", (l) => l.rows.some((r) => r.state === "running" && r.stop && r.steer));
  await shot("6-moving-check", (l) => l.rows.some((r) => /running node check-physics\.js/.test(r.text)));
  // The chat closed: the titlebar says "1 running"; a click on it opens the chat again.
  await page.click("button[title*='chat panel']");
  await shot("6b-chat-closed-titlebar", () => true, 1000).then(async () => {
    const t = await page.textContent("[data-el='titlebar-tasks']").catch(() => null);
    shots.at(-1).titlebar = t;
    if (!/1 running/.test(t ?? "")) throw new Error("titlebar: no 1 running");
  });
  await page.click("[data-el='titlebar-tasks']");
  await shot("7-result-arrived", (l) => !l.chip && l.taskEnd.length === 1 && l.last.some((x) => /physics animation is ready/.test(x)), 25000);
  await page.waitForTimeout(1500);
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
console.log(JSON.stringify(shots.map((s) => ({ name: s.name, chip: s.chip, rows: s.rows, taskEnd: s.taskEnd, inline: s.inlineChips, raw: s.raw, tokens: s.tokens })), null, 1));
if (errors.length) console.log("page errors:", errors);
