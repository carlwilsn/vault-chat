// A project's folder on the box, in the real app (the preview's real frontend on its fake box): the left panel
// with a project that works in ~/github/vault-chat, "+ New project" with where it works and the folder chooser,
// and the project's file tree in its thread (a file opened from the box, edited, written back).
//   node preview/tools/project-folder-shots.mjs <out> [--url http://127.0.0.1:1555/before]
import { launch } from "./browser.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const out = resolve(argv[0] ?? "preview-proof/project-folder");
const origin = (() => {
  const i = argv.indexOf("--url");
  return i >= 0 ? argv[i + 1] : "http://127.0.0.1:1555/before";
})();
mkdirSync(out, { recursive: true });
const result = { shots: [], checks: {} };

const { browser, page, log } = await launch({ width: 1400, height: 900 });
const shot = async (name) => {
  const p = join(out, `${name}.png`);
  await page.screenshot({ path: p });
  result.shots.push(p);
};
try {
  // 1. The project's thread: its folder's tree from the box.
  await page.goto(`${origin}/?scenario=project-folder-tree&narrate=0`, { timeout: 180000 });
  await page.waitForFunction(() => window.__preview?.ready, null, { timeout: 120000 });
  await page.waitForSelector("[data-el='project-tree'] [data-box-path$='/README.md']", { timeout: 30000 });
  await page.click("[data-el='project-tree'] [data-box-path$='/src']");
  await page.waitForSelector("[data-box-path$='/src/boxFiles.ts']");
  await page.click("[data-box-path$='/README.md']");
  await page.waitForTimeout(1200);
  result.checks.treeRows = await page.$$eval("[data-el='project-tree'] [data-box-path]", (els) => els.map((e) => e.getAttribute("data-box-path")));
  result.checks.viewerHasReadme = await page.evaluate(() => document.body.innerText.includes("A viewer + chat for a folder of notes"));
  await shot("1-project-tree");
  // Edit it in the app's editor: the edit is written back to the box.
  await page.click("button:has-text('view')");
  await page.waitForSelector(".cm-content");
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Edited from the laptop.");
  await page.waitForTimeout(1500);
  result.checks.boxCopy = await page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/preview\/runtime\/backend\/host\.ts/.test(n));
    const { fakeBoxDisk } = await import(url);
    return fakeBoxDisk().get("/home/carl/github/vault-chat/README.md");
  });
  await shot("1b-edited");
  // The Vault tab: the vault's own tree, as before.
  await page.click("[data-el='tree-tab-vault']");
  await page.waitForTimeout(600);
  await shot("2-vault-tab");
  await page.click("[data-el='tree-tab-project']");
  await page.waitForTimeout(400);

  // 2. The left panel and + New project.
  await page.keyboard.press("Control+Shift+F");
  await page.waitForSelector("[data-el='chats-sidebar'] [data-el='new-project']");
  await page.waitForTimeout(500);
  await shot("3-left-panel");
  await page.click("[data-el='new-project']");
  await page.fill("[data-el='new-project-name']", "Lecture Tools");
  await page.waitForSelector("[data-el='folder-new']");
  await shot("4-new-project-where");
  await page.click("[data-el='folder-pick']");
  await page.waitForSelector("[data-el='folder-chooser-dir']");
  await page.waitForTimeout(400);
  result.checks.chooserAtHome = await page.textContent("[data-el='folder-chooser-path']");
  result.checks.useDisabledAtHome = await page.$eval("[data-el='folder-chooser-use']", (b) => b.disabled);
  await shot("5-folder-chooser-home");
  await page.click("[data-el='folder-chooser-dir']:has-text('github')");
  await page.waitForTimeout(400);
  await page.click("[data-el='folder-chooser-dir']:has-text('AgentOS')");
  await page.waitForTimeout(400);
  result.checks.chooserAt = await page.textContent("[data-el='folder-chooser-path']");
  await shot("6-folder-chooser-picked");
  await page.click("[data-el='folder-chooser-use']");
  await page.waitForTimeout(300);
  await shot("7-new-project-chosen");
  await page.click("[data-el='new-project-create']");
  await page.waitForTimeout(1500);
  result.checks.posted = await page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/preview\/runtime\/backend\/host\.ts/.test(n));
    const { boxPostLog } = await import(url);
    return boxPostLog().filter((p) => p.path === "/projects").map((p) => p.body);
  });
  await page.keyboard.press("Control+Shift+F");
  await page.waitForSelector("[data-el='project-tree'][data-root='/home/carl/github/AgentOS']", { timeout: 10000 });
  await shot("8-new-project-thread");
  result.checks.errors = [...log.console.filter((l) => l.type === "error").map((l) => l.text), ...log.pageErrors.map((l) => l.text)].slice(0, 20);
} catch (e) {
  result.error = String(e?.stack ?? e);
  await shot("error").catch(() => {});
} finally {
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
  await browser.close();
}
console.log(JSON.stringify(result, null, 2));
