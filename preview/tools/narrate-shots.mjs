// Watch a narrated scenario play end to end, as a person would (narrate=1,
// a given speed), and screenshot each beat while its highlight is up.
//   node preview/tools/narrate-shots.mjs [--url http://127.0.0.1:2100/after] [--id conv-a] [--speed 1] [--phone]
// Shots + timings → preview-proof/narrated/<id>/.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const ORIGIN = opt("url", "http://127.0.0.1:1521/after");
const ID = opt("id", "conv-a");
const SPEED = opt("speed", "1");
const PHONE = argv.includes("--phone");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "preview-proof", "narrated", ID);
mkdirSync(OUT, { recursive: true });

const { browser, page, log } = await launch(PHONE ? { width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 } : { width: 1400, height: 900 });
const url = PHONE ? `${ORIGIN}/phone?scenario=${ID}&base=synthetic&narrate=1&speed=${SPEED}` : `${ORIGIN}/?scenario=${ID}&side=after&base=synthetic&narrate=1&speed=${SPEED}`;
const t0 = Date.now();
await page.goto(url, { timeout: 120000 });
const card = () =>
  page.evaluate(() => {
    const r = document.querySelector("#vc-narrate")?.shadowRoot;
    if (!r) return null;
    const c = r.querySelector(".card").getBoundingClientRect();
    const g = r.querySelector(".ring");
    const gr = g.getBoundingClientRect();
    return { n: r.querySelector(".n").textContent, t: r.querySelector(".t").textContent, ring: g.classList.contains("on"), card: [c.x, c.y, c.width, c.height].map(Math.round), ringRect: [gr.x, gr.y, gr.width, gr.height].map(Math.round) };
  });
const seen = new Map();
let last = null;
for (;;) {
  const c = await card().catch(() => null);
  if (c) {
    last = c;
    const key = c.n;
    const s = seen.get(key) ?? { title: c.t, captionAt: (Date.now() - t0) / 1000, shot: false, ring: false };
    seen.set(key, s);
    if (/whole conversation/.test(c.t)) break;
    // The beat's highlight is up: that's the moment to see.
    if (!s.shot && c.ring) {
      await page.waitForTimeout(450);
      const file = `${key.replace("/", "-of-")}.png`;
      await page.screenshot({ path: join(OUT, file) });
      Object.assign(s, { shot: file, ring: true, ringRect: c.ringRect, card: c.card, overlap: overlap(c.card, c.ringRect) });
    }
  }
  if (Date.now() - t0 > 400000 || (!last && Date.now() - t0 > 90000)) break;
  await page.waitForTimeout(120);
}
// Beats with no highlight: shoot their caption once.
await page.screenshot({ path: join(OUT, "end.png") });
const total = (Date.now() - t0) / 1000;
function overlap(a, b) {
  return a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
}
const errors = log.console.filter((m) => m.type === "error" && !/React DevTools/.test(m.text)).map((m) => m.text.slice(0, 200));
const result = { url, speed: SPEED, seconds: total, last, beats: Object.fromEntries(seen), errors, pageErrors: log.pageErrors.map((e) => e.text.slice(0, 200)), outbound: log.outbound };
writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 1));
for (const [k, s] of seen) console.log(`${k.padEnd(6)} ${String(s.captionAt.toFixed(1)).padStart(6)}s  ${s.ring ? "ring" : "    "} ${s.overlap ? "OVERLAP" : ""} ${s.title}`);
console.log(`\n${total.toFixed(1)} s total; ${errors.length} console errors, ${log.pageErrors.length} page errors, ${log.outbound.length} outbound → ${OUT}`);
await browser.close();
