// dev: screenshot the Settings pane of a scenario on one side, tall enough to
// hold every section.  node preview/tools/shot-settings.mjs <port> <scenario> <out.png> [height]
import { launch, sideBase } from "./browser.mjs";
const [port, id, out, height = "2200"] = process.argv.slice(2);
const { browser, page, log } = await launch({ width: 1400, height: Number(height) });
await page.goto(`${await sideBase(port)}/?scenario=${id}`);
await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(2500);
const pane = page.locator("span", { hasText: /^Settings$/ }).first().locator("xpath=../..");
await (await pane.count() ? pane : page).screenshot({ path: out });
console.log(JSON.stringify({ errors: log.console.filter((m) => m.type === "error").map((m) => m.text.slice(0, 200)), pageErrors: log.pageErrors.map((e) => e.text.slice(0, 300)), outbound: log.outbound }));
await browser.close();
