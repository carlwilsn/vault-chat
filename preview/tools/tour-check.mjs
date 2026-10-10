// The Tour, played end to end in a real browser through the shell (one origin,
// no cross-port frames — as the Claude desktop app's browser pane sees it):
// a screenshot per phase into preview/proof/tour/, and every console error,
// page error, frame report (not faked / refused) and outbound request.
//   node preview/tools/tour-check.mjs [shellUrl=http://127.0.0.1:1600] [--from N] [--to N]
import { mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const shell = argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:1600";
let from = Number(opt("from", 0));
let to = opt("to", null);
// --slide <id> [--until <id>]: phases by slide id (same flattening as shell/tour.js).
if (opt("slide", null)) {
  const { slides } = await (await fetch(`${argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:1600"}/tour/tour.json`)).json();
  const ids = [];
  for (const s of slides) {
    ids.push(s.id);
    if (s.card) continue;
    if (s.before !== false) ids.push(s.id);
    for (const _ of s.options?.length ? s.options : [null]) ids.push(s.id);
  }
  from = ids.indexOf(opt("slide"));
  to = ids.lastIndexOf(opt("until", opt("slide")));
}
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "proof", "tour");
mkdirSync(out, { recursive: true });
if (from === 0) for (const f of readdirSync(out)) if (f.endsWith(".png")) rmSync(join(out, f));

const [vw, vh] = String(opt("size", "1664x932")).split("x").map(Number);
const { browser, page, log } = await launch({ width: vw, height: vh });
const crossPort = [];
page.on("request", (r) => {
  const u = new URL(r.url());
  const s = new URL(shell);
  if ((u.protocol === "http:" || u.protocol === "ws:") && u.host !== s.host && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) crossPort.push(r.url());
});
await page.goto(`${shell}/#tour=${from}`);
await page.waitForFunction(() => window.__tour?.phases?.length > 0, null, { timeout: 60000 });
const phases = await page.evaluate(() => window.__tour.phases.map((p) => ({ ...p, id: window.__tour.slides[p.si] })));
const last = to !== null ? Number(to) : phases.length - 1;
console.log(`tour: ${phases.length} phases; checking ${from}..${last}`);
let seen = 0;
const t0 = Date.now();
const results = [];
const splashSeen = [];
for (;;) {
  const st = await page.evaluate(() => {
    // A splash (desktop #vault-splash, phone .gate) inside a frame that is on screen.
    let splash = false;
    for (const f of document.querySelectorAll(".tour-frames.show iframe")) {
      try {
        const d = f.contentDocument;
        if (d && (d.getElementById("vault-splash") || d.querySelector(".gate") || !d.querySelector("body *"))) splash = true;
      } catch {
        /* navigating */
      }
    }
    return { results: window.__tour.results, index: window.__tour.index, done: window.__tour.done, splash };
  });
  if (st.splash) splashSeen.push(st.index);
  while (seen < st.results.length) {
    const r = st.results[seen++];
    const name = `${String(r.phase).padStart(2, "0")}-${r.id}-${r.kind}${r.option !== null && r.option !== undefined ? "-opt" + "ABC"[r.option] : ""}.png`;
    // Title cards are recorded once shown; live phases during the hold after their steps.
    await page.screenshot({ path: join(out, name) });
    results.push(r);
    console.log(`${r.ok ? "ok  " : "FAIL"} ${String(r.phase).padStart(2)} ${r.id} ${r.kind}${r.option != null ? " opt " + "ABC"[r.option] : ""} ${Math.round((r.ms ?? 0) / 100) / 10}s${r.error ? "  " + r.error : ""}`);
  }
  if (st.done || results.some((r) => r.phase >= last)) break;
  if (Date.now() - t0 > 40 * 60_000) {
    console.log("timeout");
    break;
  }
  await page.waitForTimeout(250);
}
const reports = await page.evaluate(() => window.__tour.reports);
const errs = log.console.filter((m) => m.type === "error");
const warnNotFaked = log.console.filter((m) => /not faked/.test(m.text));
const summary = {
  phases: results.length,
  failed: results.filter((r) => !r.ok).map((r) => `${r.phase} ${r.id} ${r.kind}: ${r.error}`),
  consoleErrors: errs.map((m) => `${m.url.replace(/^https?:\/\/[^/]+/, "")}: ${m.text.slice(0, 240)}`),
  pageErrors: log.pageErrors.map((e) => e.text.slice(0, 240)),
  notFaked: warnNotFaked.map((m) => m.text.slice(0, 200)),
  reports,
  outbound: log.outbound,
  crossPortRequests: crossPort,
  splashVisibleInPhases: [...new Set(splashSeen)],
  minutes: Math.round((Date.now() - t0) / 6000) / 10,
};
writeFileSync(join(out, "result.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
await browser.close();
process.exit(summary.failed.length || summary.consoleErrors.length || summary.pageErrors.length || summary.outbound.length || summary.crossPortRequests.length || summary.splashVisibleInPhases.length || summary.notFaked.length || reports.length ? 1 : 0);
