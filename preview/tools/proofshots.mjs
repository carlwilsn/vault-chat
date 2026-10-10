// Before/after screenshots of scenarios, for a branch's proof folder.
//   node preview/tools/proofshots.mjs <outDir> <beforePort> <afterPort> <id[:phone]> …
// Desktop scenarios at 1400×900; ":phone" ones at 390×844 (/phone?scenario=).
// Writes <outDir>/<id>-before.png and -after.png, and prints page errors.
import { launch } from "./browser.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [outDir, beforePort, afterPort, ...ids] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
for (const spec of ids) {
  const [id, kind] = spec.split(":");
  const phone = kind === "phone";
  for (const [side, port] of [["before", beforePort], ["after", afterPort]]) {
    const { browser, page, log } = await launch(phone ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true } : { width: 1400, height: 900 });
    try {
      if (phone) {
        await page.goto(`http://127.0.0.1:${port}/phone?scenario=${id}`);
        await page.waitForFunction(() => window.__previewPhone?.ready, null, { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(1200);
      } else {
        await page.goto(`http://127.0.0.1:${port}/?scenario=${id}`);
        await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 40000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }
      await page.screenshot({ path: join(outDir, `${id}-${side}.png`) });
      const step = phone ? await page.evaluate(() => window.__previewPhone?.stepError ?? null) : await page.evaluate(() => window.__preview?.stepError ?? null);
      const errs = [...log.pageErrors.map((e) => e.text.split("\n")[0]), ...log.console.filter((m) => m.type === "error").map((m) => m.text.slice(0, 200))];
      console.log(`${id} ${side}: ${errs.length ? errs.slice(0, 4).join(" | ") : "ok"}${step ? ` · step: ${step}` : ""}`);
    } finally {
      await browser.close();
    }
  }
}
