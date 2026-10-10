// dev: screenshot a scenario after its steps + extra wait; optional JS to run first.
//   node preview/tools/shot.mjs <scenario> <out.png> [extraMs] [js]
import { launch } from "./browser.mjs";
const [id, out, extra = "3000", js] = process.argv.slice(2);
const { browser, page, log } = await launch({ width: 1400, height: 900 });
await page.goto(`http://127.0.0.1:1520/before/?scenario=${id}`);
await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 40000 }).catch(() => {});
if (js) await page.evaluate(js);
await page.waitForTimeout(Number(extra));
await page.screenshot({ path: out });
console.log(JSON.stringify({ errors: log.console.filter((m) => m.type === "error").map((m) => m.text.slice(0, 300)), pageErrors: log.pageErrors.map((e) => e.text.slice(0, 300)), outbound: log.outbound }));
await browser.close();
