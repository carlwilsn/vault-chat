// Dev probe: open one preview URL headless, print console errors, outbound
// requests and the preview's own reports, save a screenshot.
//   node preview/tools/probe.mjs "<url>" [out.png] [waitMs]
import { launch } from "./browser.mjs";

const [url, out = "probe.png", wait = "4000"] = process.argv.slice(2);
const { browser, page, log } = await launch({ width: 1400, height: 900 });
await page.goto(url);
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out });
const st = await page.evaluate(() => {
  const p = window.__preview;
  return p ? { unknown: p.unknown(), refused: p.refused(), reports: p.reports(), stepsDone: p.stepsDone, stepError: p.stepError, calls: p.calls().length } : null;
});
const first = (t) => t.split("\n")[0];
console.log(
  JSON.stringify(
    {
      errors: log.console.filter((m) => m.type === "error").map((m) => m.text.slice(0, 600)).slice(0, 30),
      pageErrors: log.pageErrors.map((e) => e.text.slice(0, 600)),
      warnings: log.console.filter((m) => m.type === "warning").map((m) => first(m.text)).slice(0, 30),
      outbound: log.outbound,
      preview: st,
    },
    null,
    2,
  ),
);
await browser.close();
