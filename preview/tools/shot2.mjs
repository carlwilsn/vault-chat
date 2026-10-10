// dev: screenshot a scenario on a given side's port, after its steps + extra wait.
//   node preview/tools/shot2.mjs <port> <scenario> <out.png> [extraMs] [js]
// Like shot.mjs, for a harness started on other ports (serve.mjs --before-port/--after-port).
import { launch } from "./browser.mjs";
const [port, id, out, extra = "3000", js] = process.argv.slice(2);
const { browser, page, log } = await launch({ width: 1400, height: 900 });
await page.goto(`http://127.0.0.1:${port}/?scenario=${id}`);
await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 60000 }).catch(() => {});
if (js) await page.evaluate(js);
await page.waitForTimeout(Number(extra));
await page.screenshot({ path: out });
console.log(JSON.stringify({ errors: log.console.filter((m) => m.type === "error").map((m) => m.text.slice(0, 300)), pageErrors: log.pageErrors.map((e) => e.text.slice(0, 300)), outbound: log.outbound }));
await browser.close();
