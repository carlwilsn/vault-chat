// Self-test: boot every scenario (desktop; phone for phone scenarios) on each
// running side and assert zero console errors, zero page errors, zero
// unknown ("not faked") commands, zero refused/outbound requests and that the
// scenario's open-steps completed.
//   node preview/test.mjs [--side before|after|both] [--only id,id] [--shots dir]
// Needs `npm run preview` running (or set PREVIEW_BEFORE / PREVIEW_AFTER).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch } from "./tools/browser.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const sides = { before: process.env.PREVIEW_BEFORE ?? "http://127.0.0.1:1520", after: process.env.PREVIEW_AFTER ?? "http://127.0.0.1:1521" };
const which = opt("side", "before");
const only = opt("only", "")?.split(",").filter(Boolean);
const shots = opt("shots", null);
if (shots) mkdirSync(shots, { recursive: true });
const base = opt("base", "synthetic");

// Console noise that is the app's own expected logging, not a failure.
const ALLOWED_ERRORS = [/Download the React DevTools/];

async function alive(url) {
  try {
    return (await fetch(url + "/__preview/info", { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

const results = [];
const targets = which === "both" ? ["before", "after"] : [which];
for (const side of targets) {
  const origin = sides[side];
  if (!(await alive(origin))) {
    results.push({ side, id: "(server)", ok: false, problems: [`${origin} not running`] });
    continue;
  }
  const list = await (await fetch(origin + "/__preview/scenarios.json")).json();
  for (const sc of list) {
    if (only?.length && !only.includes(sc.id)) continue;
    const surfaces = sc.surfaces.includes("phone") ? ["desktop", "phone"] : ["desktop"];
    for (const surface of surfaces) {
      const phone = surface === "phone";
      const { browser, page, log } = await launch(phone ? { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 } : { width: 1400, height: 900 });
      const url = phone ? `${origin}/phone?scenario=${sc.id}&base=${base}` : `${origin}/?scenario=${sc.id}&side=${side}&base=${base}`;
      const problems = [];
      try {
        await page.goto(url, { timeout: 30000 });
        if (phone) {
          await page.waitForFunction(() => window.__previewPhone?.ready && !document.querySelector(".gate"), null, { timeout: 25000 }).catch(() => problems.push("phone did not render / steps did not finish"));
          await page.waitForTimeout(1500);
          const pst = await page.evaluate(() => ({ refused: window.__previewPhone?.refused ?? [], stepError: window.__previewPhone?.stepError ?? null }));
          for (const r of pst.refused) problems.push(`refused: ${r}`);
          if (pst.stepError) problems.push(`phone step: ${pst.stepError}`);
        } else {
          await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 30000 }).catch(() => problems.push("steps did not finish in 30 s"));
          await page.waitForTimeout(1500);
        }
        const st = await page.evaluate(() => {
          const p = window.__preview;
          return p ? { unknown: p.unknown(), refused: p.refused().map((r) => `${r.kind} ${r.url}`), stepError: p.stepError, reports: p.reports().filter((r) => r.kind === "error").map((r) => r.text) } : null;
        });
        if (st) {
          if (st.unknown.length) problems.push(`not faked: ${st.unknown.join(", ")}`);
          if (st.refused.length) problems.push(`refused: ${st.refused.join(" | ")}`);
          if (st.stepError) problems.push(`step: ${st.stepError}`);
          for (const r of st.reports) problems.push(`report: ${r}`);
        } else if (!phone) problems.push("preview boot did not run");
        if (shots) await page.screenshot({ path: join(shots, `${side}-${surface}-${sc.id}.png`) });
      } catch (e) {
        problems.push(`load: ${String(e?.message ?? e).split("\n")[0]}`);
      }
      const errs = log.console.filter((m) => m.type === "error" && !ALLOWED_ERRORS.some((r) => r.test(m.text)));
      for (const e of errs) problems.push(`console: ${e.text.split("\n")[0].slice(0, 220)}`);
      for (const e of log.pageErrors) problems.push(`pageerror: ${e.text.split("\n")[0].slice(0, 220)}`);
      for (const u of log.outbound) problems.push(`outbound: ${u}`);
      results.push({ side, surface, id: sc.id, ok: problems.length === 0, problems });
      console.log(`${problems.length ? "FAIL" : "ok  "} ${side.padEnd(6)} ${surface.padEnd(7)} ${sc.id}${problems.length ? "\n      " + problems.join("\n      ") : ""}`);
      await browser.close();
    }
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
