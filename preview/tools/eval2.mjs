// dev: run a scenario on a side's port, then evaluate JS in the page and print the result.
//   node preview/tools/eval2.mjs <port> <scenario> "<js expression>" [extraMs]
import { launch } from "./browser.mjs";
const [port, id, js, extra = "1500"] = process.argv.slice(2);
const { browser, page, log } = await launch({ width: 1400, height: 900 });
await page.goto(`http://127.0.0.1:${port}/?scenario=${id}`);
await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(Number(extra));
const out = await page.evaluate(js);
console.log(JSON.stringify(out, null, 1));
console.log(JSON.stringify({ errors: log.console.filter((m) => m.type === "error").map((m) => m.text.slice(0, 300)), pageErrors: log.pageErrors.map((e) => e.text.slice(0, 300)) }));
await browser.close();
