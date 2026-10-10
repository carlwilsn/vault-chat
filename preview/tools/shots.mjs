// Screenshot scenarios on one side of a running preview, after their steps.
//   node preview/tools/shots.mjs <port> <outDir> <prefix> <scenario...>
// e.g. node preview/tools/shots.mjs 1582 preview-proof after history-a history-b
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch } from "./browser.mjs";

const [port, outDir, prefix, ...ids] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { browser, page, log } = await launch({ width: 1400, height: 900 });
const report = {};
for (const id of ids) {
  log.console.length = 0;
  log.pageErrors.length = 0;
  await page.goto(`http://127.0.0.1:${port}/?scenario=${id}`, { timeout: 120000 });
  const done = await page
    .waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(1200);
  const out = join(outDir, `${prefix}-${id}.png`);
  await page.screenshot({ path: out });
  const stepError = await page.evaluate(() => window.__preview?.stepError ?? null).catch(() => null);
  report[id] = {
    stepsDone: done,
    stepError,
    errors: log.console.filter((m) => m.type === "error").map((m) => m.text.slice(0, 200)),
    pageErrors: log.pageErrors.map((e) => e.text.slice(0, 200)),
  };
}
console.log(JSON.stringify(report, null, 1));
await browser.close();
