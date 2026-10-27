// "You keep it": a git project's proof card in the real app (the preview's real frontend on its fake box) —
// the laptop's thread with the card (what changed, why, tests, screenshot) and Keep / Send back, then Keep
// pressed (the answer that goes to the box); and the phone's thread with the same card.
//   node preview/tools/project-review-shots.mjs <out> [--url http://127.0.0.1:1555/before]
import { launch } from "./browser.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const out = resolve(argv[0] ?? "preview-proof/project-review");
const origin = (() => {
  const i = argv.indexOf("--url");
  return i >= 0 ? argv[i + 1] : "http://127.0.0.1:1555/before";
})();
mkdirSync(out, { recursive: true });
const result = { shots: [], checks: {} };
const host = async (page) =>
  page.evaluate(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/preview\/runtime\/backend\/host\.ts/.test(n));
    const { boxPostLog } = await import(url);
    return boxPostLog().map((p) => ({ path: p.path, body: p.body }));
  });

{
  const { browser, page, log } = await launch({ width: 1400, height: 900 });
  try {
    await page.goto(`${origin}/?scenario=project-review&narrate=0`, { timeout: 180000 });
    await page.waitForFunction(() => window.__preview?.ready, null, { timeout: 120000 });
    await page.keyboard.press("Control+Shift+F");
    await page.waitForSelector("[data-el='ask-options'][data-live='1']", { timeout: 30000 });
    await page.waitForTimeout(1200);
    result.checks.card = await page.evaluate(() => document.body.innerText.includes("Ready to keep: Bigger tap targets on the phone"));
    result.checks.options = await page.$$eval("[data-el='ask-option']", (els) => els.map((e) => e.textContent));
    result.checks.image = await page.$$eval("img", (els) => els.filter((e) => /proof|phone-after/.test(e.getAttribute("alt") ?? "") || /phone-after/.test(e.getAttribute("src") ?? "")).map((e) => [e.getAttribute("alt"), e.naturalWidth]));
    await page.screenshot({ path: join(out, "1-laptop-card.png") });
    result.shots.push("1-laptop-card.png");
    await page.click("[data-el='ask-option']:has-text('Keep')");
    await page.waitForTimeout(1200);
    result.checks.keepSent = (await host(page)).filter((p) => /intent|answer/.test(p.path)).map((p) => p.body).slice(-2);
    await page.screenshot({ path: join(out, "2-laptop-kept.png") });
    result.shots.push("2-laptop-kept.png");
    result.checks.errors = [...log.console.filter((l) => l.type === "error").map((l) => l.text), ...log.pageErrors.map((l) => l.text)].slice(0, 10);
  } catch (e) {
    result.error = String(e?.stack ?? e);
    await page.screenshot({ path: join(out, "error-laptop.png") }).catch(() => {});
  } finally {
    await browser.close();
  }
}
{
  const { browser, page, log } = await launch({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
  try {
    await page.goto(`${origin}/phone?scenario=project-review-phone`, { timeout: 180000 });
    // The scenario's own clicks open the drawer and Vault Chat's thread.
    await page.waitForFunction(() => document.body.innerText.includes("Ready to keep"), null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.evaluate(() => [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && /^Keep$/.test(e.textContent?.trim() ?? ""))?.scrollIntoView({ block: "end" }));
    await page.waitForTimeout(500);
    result.checks.phoneCard = await page.evaluate(() => document.body.innerText.includes("Ready to keep"));
    result.checks.phoneOptions = await page.evaluate(() => [...document.querySelectorAll("button, [role=button]")].map((e) => e.textContent?.trim()).filter((t) => /^(\d\s*)?(Keep|Send back)/.test(t ?? "")));
    await page.screenshot({ path: join(out, "3-phone-card.png"), fullPage: false });
    result.shots.push("3-phone-card.png");
    result.checks.phoneErrors = [...log.console.filter((l) => l.type === "error").map((l) => l.text), ...log.pageErrors.map((l) => l.text)].slice(0, 10);
  } catch (e) {
    result.phoneError = String(e?.stack ?? e);
    await page.screenshot({ path: join(out, "error-phone.png") }).catch(() => {});
  } finally {
    await browser.close();
  }
}
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
