// Record the final folder model on the real desktop frontend against a REAL box (dev only; muted browser):
//   node preview/tools/finalModelRecord.mjs --url http://127.0.0.1:1742/after --out <dir>
// The box is preview/tools/finalModelBox.ts behind the dev server's VC_REALBOX. Real clicks on the folder picker:
// switching vaults (the chats never change), the Projects tab, Make this a project, Rename, Delete (both choices).
// Writes laptop.webm, a screenshot per step and result.json (what each step read off the page).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
const base = opt("url", "http://127.0.0.1:1742/after");
const out = opt("out", "preview/out/final-model");
mkdirSync(out, { recursive: true });
const size = { width: 1400, height: 900 };
const { browser, context, page, log } = await launch({ ...size, recordVideo: { dir: out, size } });
const result = { steps: [], errors: [] };
page.on("response", async (r) => {
  const u = r.url();
  if (r.request().method() === "POST" && /intent|projects|folders/.test(u)) console.log("POST", u.slice(-60), r.request().postData()?.slice(0, 200), r.status(), (await r.text().catch(() => "")).slice(0, 200));
});
let n = 0;

const chats = () => page.evaluate(() => [...document.querySelectorAll("[data-el=thread-main],[data-el=thread-project]")].map((e) => e.textContent.trim()));
const folder = () => page.evaluate(() => document.querySelector("[data-el=vault-picker]")?.textContent.trim());
const tree = () => page.evaluate(() => [...document.querySelectorAll("[data-path]")].map((e) => e.getAttribute("data-path")).filter((p) => p && !p.includes("/.")).slice(0, 12));
const rows = () => page.evaluate(() => [...document.querySelectorAll("[data-el=vault-picker-item]")].map((e) => `${e.getAttribute("data-rel")}${e.getAttribute("data-project") ? ` [project ${e.getAttribute("data-project")}]` : ""}`));
const active = () => page.evaluate(() => [...document.querySelectorAll("[data-el=thread-main],[data-el=thread-project]")].find((e) => e.classList.contains("bg-accent"))?.textContent.trim() ?? null);
async function step(name, extra = {}) {
  await page.waitForTimeout(900);
  // With the picker closed, the chats list is shown again: Main and the projects, whatever folder is open.
  if (!(await page.locator("[data-el=vault-picker-menu]").count()) && !(await page.locator("[data-el=thread-main]").count())) {
    await page.locator("[data-el=chats-toggle]").first().click().catch(() => {});
    await page.waitForTimeout(1200);
  }
  const shot = join(out, `${String(++n).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: shot });
  const s = { step: name, folder: await folder(), chats: await chats(), active: await active(), tree: await tree(), pickerRows: await rows(), ...extra };
  result.steps.push(s);
  console.log(JSON.stringify(s));
}
const click = async (sel) => {
  const el = page.locator(sel).first();
  await el.waitFor({ state: "visible", timeout: 15000 });
  await el.hover();
  await page.waitForTimeout(250);
  await el.click();
};
const openPicker = async () => {
  if (!(await page.locator("[data-el=vault-picker-menu]").count())) await click("[data-el=vault-picker]");
  await page.locator("[data-el=vault-picker-menu]").waitFor();
};
const row = (rel) => `[data-el=vault-picker-item][data-rel="${rel}"]`;
const menuOn = async (rel) => {
  await page.locator(row(rel)).hover();
  await page.waitForTimeout(300);
  await click(`${row(rel)} [data-el=picker-row-menu]`);
};

try {
  await page.goto(`${base}/?scenario=folders-final&side=after&overlay=0&narrate=0`);
  await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 60000 }).catch(() => {});
  // The chats (Main and the projects) in the sidebar, so every step shows they stay.
  await page.waitForTimeout(1500);
  // The chat panel (it starts hidden in this scenario), then its list of chats: Main and the projects.
  if (await page.locator("[title^='Show chat panel']").count()) await click("[title^='Show chat panel']");
  await page.waitForTimeout(800);
  if (!(await page.locator("[data-el=thread-main]").count())) await click("[data-el=chats-toggle]");
  await page.waitForTimeout(2500);
  await step("start");

  await openPicker();
  await step("picker-vaults-tab");
  await click(row("vaults/school2"));
  await page.waitForTimeout(1500);
  await step("opened-school2");

  await openPicker();
  await click(row("vaults/vault-chat"));
  await page.waitForTimeout(1500);
  await step("opened-vault-chat-vault");

  await openPicker();
  await click("[data-el=picker-tab-projects]");
  await step("picker-projects-tab");
  await click(row("vaults/school2/IEMS 469"));
  await page.waitForTimeout(2000);
  await step("opened-project-iems");

  // Make this a project: the physics vault.
  await openPicker();
  await click("[data-el=picker-tab-vaults]");
  await menuOn("vaults/physics");
  await step("row-menu");
  await click("[data-el=picker-make-project]");
  await page.waitForTimeout(2000);
  await step("made-physics-a-project");

  // Rename a project (a folder in a vault): its folder is renamed on the box, its thread stays.
  await page.waitForTimeout(1500);
  await click("[data-el=picker-tab-projects]");
  await page.mouse.move(700, 600);
  await page.waitForTimeout(1500);
  await menuOn("vaults/school2/IEMS 469");
  console.log("menus open:", await page.locator("[data-el=picker-row-menu-list]").count());
  await click("[data-el=picker-row-menu-list] [data-el=picker-rename]");
  const input = page.locator("[data-el=picker-rename-input]");
  await input.fill("IEMS 469 Notes");
  console.log("renaming:", await input.inputValue());
  await page.waitForTimeout(400);
  await input.press("Enter");
  await page.waitForTimeout(1500);
  console.log("picker error:", await page.locator("[data-el=picker-error]").allTextContents());
  await page.waitForTimeout(2000);
  await step("renamed-iems");

  // Delete, choice 1: the conversation only — physics stays, a plain vault.
  await menuOn("vaults/physics");
  await click("[data-el=picker-delete]");
  await step("delete-asks-two-choices");
  await click("[data-el=picker-delete-conversation]");
  await page.waitForTimeout(2000);
  await step("deleted-conversation-only");
  await click("[data-el=picker-tab-vaults]");
  await step("physics-still-a-folder");

  // Delete, choice 2: everything — IEMS 469 Notes, folder and all (git keeps it).
  await click("[data-el=picker-tab-projects]");
  await menuOn("vaults/school2/IEMS 469 Notes");
  await click("[data-el=picker-delete]");
  await page.waitForTimeout(500);
  await click("[data-el=picker-delete-everything]");
  await page.waitForTimeout(2500);
  await step("deleted-everything");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  await step("end");
} catch (e) {
  result.errors.push(String(e?.stack ?? e));
  console.error(e);
  await page.screenshot({ path: join(out, "error.png") }).catch(() => {});
}
const video = page.video();
await context.close();
await browser.close();
renameSync(await video.path(), join(out, "laptop.webm"));
result.pageErrors = log.pageErrors;
result.outbound = log.outbound;
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
console.log(`wrote ${out}`);
