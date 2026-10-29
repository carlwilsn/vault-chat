// The vault-chat folder in the real app (the preview's real frontend on its fake box, the browser muted): Settings'
// vault-chat folder (this laptop's only), the vault picker (the vaults in the folder and New vault, nothing from
// elsewhere), and + New project (the vault or a synced folder in projects/, no folder elsewhere).
//   node preview/tools/master-shots.mjs <out> [--url http://127.0.0.1:1655/before]
import { launch } from "./browser.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const out = resolve(argv[0] ?? "preview-proof/master");
const origin = (() => {
  const i = argv.indexOf("--url");
  return i >= 0 ? argv[i + 1] : "http://127.0.0.1:1655/before";
})();
mkdirSync(out, { recursive: true });
const result = { shots: [], checks: {} };

const { browser, page, log } = await launch({ width: 1400, height: 900 });
const shot = async (name) => {
  const p = join(out, `${name}.png`);
  await page.screenshot({ path: p });
  result.shots.push(p);
};
const posts = () =>
  page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/preview\/runtime\/backend\/host\.ts/.test(n));
    const { boxPostLog } = await import(url);
    return boxPostLog().map((p) => ({ path: p.path, body: p.body }));
  });
try {
  await page.goto(`${origin}/?scenario=master-folder&narrate=0`, { timeout: 180000 });
  await page.waitForFunction(() => window.__preview?.ready, null, { timeout: 120000 });
  await page.waitForTimeout(5000);
  // 1. Settings → vault-chat folder: this laptop's folder only (the box's is shown), the repos in it.
  await page.click("[title='Settings']");
  await page.waitForSelector("[data-settings='master']");
  await page.waitForTimeout(1500);
  await page.$eval("[data-settings='master']", (el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  result.checks.repos = await page.$$eval("[data-settings='master'] [data-el='master-repo']", (els) => [...new Set(els.map((e) => e.getAttribute("data-repo")))]);
  result.checks.laptopPath = await page.inputValue("[data-el='master-path']");
  result.checks.boxPath = await page.inputValue("[data-el='box-master-path']").catch(() => null);
  result.checks.noBoxControl = (await page.$("[data-el='box-master-path']")) === null && (await page.$("[data-el='master-copy']")) === null;
  await shot("1-settings-folder");
  await page.click("[title='Settings']");
  await page.waitForTimeout(500);
  // 1. The vault picker.
  await page.click("[data-el='vault-picker']");
  await page.waitForSelector("[data-el='vault-picker-menu']");
  await page.waitForTimeout(500);
  result.checks.pickerItems = await page.$$eval("[data-el='vault-picker-item']", (els) => els.map((e) => e.textContent.trim()));
  result.checks.noOtherFolder = (await page.$("[data-el='vault-picker-other']")) === null;
  await shot("3-vault-picker");
  await page.click("[data-el='vault-picker-new']");
  await page.fill("[data-el='vault-picker-new-name']", "Linear Algebra");
  await shot("4-vault-picker-new");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  result.checks.newVaultPost = (await posts().catch(() => [])).filter((p) => p.path === "/api/v1/vaults");
  result.checks.openAfterNew = await page.textContent("[data-el='vault-picker']");
  await page.click("[title='Settings']");
  await page.waitForSelector("[data-settings='master']");
  await page.$eval("[data-settings='master']", (el) => el.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(1500);
  result.checks.reposAfterNew = await page.$$eval("[data-settings='master'] [data-el='master-repo']", (els) => [...new Set(els.map((e) => e.innerText.replace(/\s+/g, " ").trim()))]);
  await shot("5-settings-after-new-vault");
  await page.click("[title='Settings']");
  await page.waitForTimeout(500);
  await page.click("[data-el='vault-picker']");
  await page.click("[data-el='vault-picker-item'][data-path$='/school2']");
  await page.waitForTimeout(1500);
  // 3. + New project.
  await page.keyboard.press("Control+Shift+F");
  await page.waitForSelector("[data-el='chats-sidebar'] [data-el='new-project']");
  await page.click("[data-el='new-project']");
  await page.fill("[data-el='new-project-name']", "Lecture Tools");
  await page.waitForSelector("[data-el='folder-new']");
  await page.click("[data-el='folder-new']");
  await page.waitForTimeout(800);
  result.checks.newChip = await page.textContent("[data-el='folder-new']");
  result.checks.syncNote = await page.textContent("[data-el='new-project-sync-note']");
  await shot("6-new-project-synced");
  result.checks.noFolderElsewhere = (await page.$("[data-el='folder-pick']")) === null;
  result.checks.errors = [...log.console.filter((l) => l.type === "error").map((l) => l.text), ...log.pageErrors.map((l) => l.text)].slice(0, 20);
} catch (e) {
  result.error = String(e?.stack ?? e);
  await shot("error").catch(() => {});
} finally {
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
  await browser.close();
}
console.log(JSON.stringify(result, null, 2));
