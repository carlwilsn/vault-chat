// The phone's vault switcher, played with real clicks on the preview's
// phone-vaults scenario (a box with two vaults): the menu lists both, tapping
// physics reopens the page on physics' own conversations, and the menu marks
// it. phone-settings (one vault) shows no vault rows.
//   node preview/tools/vaults-check.mjs [--url http://127.0.0.1:1500/after] [--shots dir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const origin = opt("url", "http://127.0.0.1:1500/after");
const shots = opt("shots", null);
if (shots) mkdirSync(shots, { recursive: true });

const fails = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) fails.push(what);
};

const { browser, page } = await launch({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));
try {
  await page.goto(`${origin}/phone?scenario=phone-vaults&base=synthetic`, { timeout: 30000 });
  await page.waitForFunction(() => window.__previewPhone?.ready, null, { timeout: 25000 });
  const rows = () => page.evaluate(() => [...document.querySelectorAll("#vaultRows .mrow")].filter((e) => e.offsetParent).map((e) => `${e.dataset.vault}${e.classList.contains("cur") ? "*" : ""}`));
  check(JSON.stringify(await rows()) === JSON.stringify(["summer-demo*", "physics"]), `menu lists both vaults, main marked: ${JSON.stringify(await rows())}`);
  if (shots) await page.screenshot({ path: join(shots, "1-menu-two-vaults.png") });

  await page.click('#vaultRows .mrow[data-vault="physics"]');
  await page.waitForURL(/vault=physics/, { timeout: 10000 });
  await page.waitForFunction(() => window.__previewPhone?.ready, null, { timeout: 25000 });
  await page.click("#convBtn");
  await page.waitForTimeout(800);
  const list = await page.evaluate(() => document.querySelector("#clist")?.textContent ?? "");
  check(/Optics — problem set 4/.test(list), "physics' conversations after the switch");
  check(!/BitNet/.test(list), "summer-demo's conversations are not in physics' list");
  if (shots) await page.screenshot({ path: join(shots, "2-physics-conversations.png") });
  await page.evaluate(() => document.getElementById("scrim")?.click());
  await page.waitForTimeout(400);
  await page.click("#menuBtn");
  await page.waitForTimeout(300);
  check(JSON.stringify(await rows()) === JSON.stringify(["summer-demo", "physics*"]), `menu marks physics: ${JSON.stringify(await rows())}`);
  if (shots) await page.screenshot({ path: join(shots, "3-menu-physics.png") });

  await page.goto(`${origin}/phone?scenario=phone-settings&base=synthetic`, { timeout: 30000 });
  await page.waitForFunction(() => window.__previewPhone?.ready, null, { timeout: 25000 });
  check((await rows()).length === 0, "one vault: no vault rows");
  check(!errors.length, `no page errors ${errors.join(" | ")}`);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} failed` : "\nall passed");
process.exit(fails.length ? 1 : 0);
