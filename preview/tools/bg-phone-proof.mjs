// The background-tasks chip on the phone (the real phone page on its mock box, phone/src/mock.ts): one line while
// a task runs, opened by a tap, folded by a second tap or a tap elsewhere; a finished task leaves the screen; with
// nothing running, no chip. Muted, headless; screenshots + result.json.
//   node preview/tools/bg-phone-proof.mjs [--origin http://127.0.0.1:1520/before] [--out preview/proof/bg-tasks/phone]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const origin = opt("origin", process.env.PREVIEW_BEFORE ?? "http://127.0.0.1:1520/before");
const out = resolve(opt("out", join(HERE, "..", "proof", "bg-tasks", "phone")));
mkdirSync(out, { recursive: true });

const { browser, page } = await launch({ width: 390, height: 844, isMobile: true });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${origin}/phone`, { timeout: 180000 });
await page.waitForFunction(() => !!window.__vcPhoneBox, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const box = (fn, arg) => page.evaluate(([f, a]) => new Function("b", "a", f)(window.__vcPhoneBox, a), [fn, arg]);
const setTasks = (list) => box(`b.emit("main", { type: "meta", patch: { subagents: a } })`, list);
const look = () =>
  page.evaluate(() => {
    const s = document.querySelector("#pinned [data-el='subagents']");
    return {
      chip: s?.querySelector("[data-el='tasks-chip']")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      open: s?.getAttribute("data-open") === "1",
      rows: [...(s?.querySelectorAll("[data-el='subagent']") ?? [])].map((r) => r.textContent.replace(/\s+/g, " ").trim()),
      px: s ? Math.round(s.getBoundingClientRect().height) : 0,
      inThread: document.querySelectorAll("#msgs [data-el='subagents']").length,
      finishedRow: /Background task finished/.test(document.body.innerText),
    };
  });
const shots = [];
const shot = async (name, until, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const l = await look();
    if (until(l)) {
      await page.screenshot({ path: join(out, `${name}.png`) });
      shots.push({ name, ...l });
      return;
    }
    if (Date.now() - t0 > ms) {
      await page.screenshot({ path: join(out, `${name}-TIMEOUT.png`) });
      throw new Error(`${name}: ${JSON.stringify(l)}`);
    }
    await page.waitForTimeout(150);
  }
};

const now = Date.now();
const dev = { threadId: "dev-1", kind: "job", title: "dev server", state: "running", status: "running", startedAt: now - 7_200_000, activity: "ready on http://localhost:5173", background: true };
const worker = { threadId: "w-physics", title: "guided physics animation", state: "running", status: "running", startedAt: now - 40_000, activity: "writing physics.html", steps: 2, background: true };
try {
  await box(`b.startTurn("main"); b.userLine("main", "u-bg", "Make me a guided physics animation as an HTML page."); b.say("main", "On it — building it in the background. Keep talking to me."); b.endTurn("main");`);
  await setTasks([dev, worker]);
  await shot("1-one-line", (l) => /2 background tasks running/.test(l.chip ?? "") && !l.open && l.rows.length === 0);
  await page.tap("[data-el='tasks-chip']");
  await shot("2-tap-opens", (l) => l.open && l.rows.length === 2);
  await page.tap("[data-el='tasks-chip']");
  await shot("3-tap-again-folds", (l) => !l.open && l.rows.length === 0);
  await page.tap("[data-el='tasks-chip']");
  await shot("4-open-again", (l) => l.open);
  await page.mouse.click(195, 250);
  await shot("5-tap-elsewhere-folds", (l) => !l.open);
  // The worker ends: it leaves the screen; the reply carries the result; the dev server stays in the one line.
  await setTasks([dev, { ...worker, state: "completed", status: "completed", endedAt: Date.now() }]);
  await box(`b.startTurn("main", "wake"); b.userLine("main", "w-rep", 'Delegated work finished: "guided physics animation"\\n\\n## Completed\\nok', "delegate"); b.say("main", "Your physics animation is ready: physics.html, seven minutes, every scene checked."); b.endTurn("main");`);
  await shot("6-done-leaves", (l) => /^1 background task running/.test(l.chip ?? "") && !l.finishedRow && l.inThread === 0);
  await setTasks([{ ...dev, state: "stopped", status: "stopped", endedAt: Date.now() }, { ...worker, state: "completed", status: "completed", endedAt: Date.now() }]);
  await shot("7-nothing-running-no-chip", (l) => l.chip === null && l.inThread === 0);
} finally {
  writeFileSync(join(out, "result.json"), JSON.stringify({ origin, shots, errors }, null, 1));
  await browser.close();
}
console.log(JSON.stringify(shots, null, 1));
if (errors.length) console.log("page errors:", errors);
