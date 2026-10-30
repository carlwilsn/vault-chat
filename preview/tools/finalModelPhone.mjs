// Record the phone on a REAL box (dev only; muted browser): the real server's /phone page.
//   node preview/tools/finalModelPhone.mjs --box http://127.0.0.1:<port> --out <dir>
// The list is Main and the projects (no folders, no vault switcher); a project opens its thread; Main is back.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const box = opt("box");
const out = opt("out", "preview/out/final-model-phone");
mkdirSync(out, { recursive: true });
const size = { width: 390, height: 844 };
const { browser, context, page, log } = await launch({ ...size, isMobile: true, recordVideo: { dir: out, size } });
const result = { steps: [], errors: [] };
let n = 0;
const drawer = () => page.evaluate(() => (document.getElementById("cdraw")?.innerText ?? "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20));
const menu = () => page.evaluate(() => (document.getElementById("menu")?.innerText ?? "").split("\n").map((s) => s.trim()).filter(Boolean));
const title = () => page.evaluate(() => (document.querySelector("header")?.innerText ?? "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 4));
async function step(name) {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(out, `${String(++n).padStart(2, "0")}-${name}.png`) });
  const s = { step: name, header: await title(), drawer: await drawer(), menu: await menu() };
  result.steps.push(s);
  console.log(JSON.stringify(s));
}
try {
  await page.goto(`${box}/phone`);
  await page.waitForTimeout(4000);
  await step("main");
  await page.click("#convBtn");
  await step("list-main-and-projects");
  await page.locator("#cdraw").getByText("vault-chat", { exact: true }).first().click();
  await step("project-thread");
  await page.click("#menuBtn");
  await step("menu-no-vaults");
  await page.mouse.click(200, 700);
  await page.click("#convBtn");
  await page.locator("#cdraw").getByText("Main", { exact: true }).first().click();
  await step("back-to-main");
} catch (e) {
  result.errors.push(String(e?.stack ?? e));
  console.error(e);
}
const video = page.video();
await context.close();
await browser.close();
renameSync(await video.path(), join(out, "phone.webm"));
result.pageErrors = log.pageErrors;
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
console.log(`wrote ${out}`);
