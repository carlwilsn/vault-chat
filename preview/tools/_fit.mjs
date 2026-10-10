import { launch } from "./browser.mjs";
const [w, h, phase, out] = process.argv.slice(2);
const { browser, page } = await launch({ width: Number(w), height: Number(h) });
await page.goto(`http://127.0.0.1:1600/#tour=${phase}`);
await page.waitForFunction(() => window.__tour?.results?.length > 0, null, { timeout: 90000 });
await page.waitForTimeout(1500);
console.log(await page.evaluate(() => { const f = document.querySelector(".tour-frames:not(.pre) .tframe"); const r = f?.getBoundingClientRect(); const l = document.querySelector("#tour-bar").getBoundingClientRect(); return JSON.stringify({ vw: innerWidth, vh: innerHeight, frame: r && [r.x, r.y, r.width, r.height].map(Math.round), label: [l.x, l.y, l.width, l.height].map(Math.round), ifr: f?.querySelector("iframe").style.transform }); }));
await page.screenshot({ path: out });
await browser.close();
