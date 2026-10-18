// "Add all" from the inbox lands every part visibly, in view, every time — in WebKit as Carl's iPad (Mac UA,
// touch): an image, five typeset math problems and three PDF pages (the preview box's seeded inbox,
// board/preview/box.ts). Each round moves the camera somewhere new (pan and zoom), opens the inbox with a tap,
// opens an entry, taps Add all, and checks every new item: inside the visible board (below the controls),
// drawn (a PDF page or an image has ink on the base canvas where it is; math is typeset DOM, none of it cut
// off), the inbox closed, the parts selected. Ten rounds.
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/inbox-add.mjs [board url] [rounds]
import { ipadPage, checker } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const ROUNDS = Number(process.argv[3] ?? 10);
const { check, failed } = checker();
const { browser, page } = await ipadPage();
page.on("pageerror", (e) => check(false, "no page error", e.message));
const logged = [];
await page.route("**/api/v1/board/log", async (route) => {
  try {
    logged.push(...(JSON.parse(route.request().postData() ?? "{}").events ?? []));
  } catch {
    /* not JSON */
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' });
});

await page.goto(url);
await page.evaluate(() => localStorage.clear());
const slug = await page.evaluate(async () => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Inbox ${Date.now() % 100000}` }) })).json()).slug);
await page.goto("about:blank");
await page.goto(`${url}#/b/${slug}`);
await page.waitForFunction(() => !!window.__board?.debug);
const entries = await page.evaluate(async () => (await (await fetch("/api/v1/inbox")).json()).entries.filter((e) => !e.making && !e.failed && e.parts.some((p) => ["image", "math", "pdf"].includes(p.kind))).map((e) => ({ id: e.id, title: e.title, kinds: e.parts.map((p) => p.kind) })));
check(entries.length >= 3, "the inbox has an image, math and PDF entries", JSON.stringify(entries.map((e) => e.kinds)));

const tap = async (sel) => {
  // The inbox repaints its list when the box's answer lands: an element can be replaced between finding it and
  // tapping it (a finger meets the new one; chrome.ts presses it).
  for (let i = 0; i < 40; i++) {
    const el = page.locator(sel).first();
    await el.waitFor({ state: "visible", timeout: 8000 });
    const b = await el.boundingBox().catch(() => null);
    if (b) return page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(50);
  }
  throw new Error(`nothing to tap: ${sel}`);
};

/** Every item added since `before`: where it is on screen and whether it shows. */
const inspect = (before) =>
  page.evaluate(async (known) => {
    const v = window.__board;
    const d = v.debug();
    const stage = document.querySelector(".stage").getBoundingClientRect();
    const TOP = 76;
    const out = [];
    const base = document.querySelector("canvas.base");
    const ctx = base.getContext("2d");
    const dpr = base.width / stage.width;
    for (const it of d.itemsList.filter((x) => !known.includes(x.id))) {
      const sx = (it.x - d.cam.x) * d.cam.z, sy = (it.y - d.cam.y) * d.cam.z, sw = it.w * d.cam.z, sh = it.h * d.cam.z;
      const inView = sx >= -1 && sy >= TOP - 1 && sx + sw <= stage.width + 1 && sy + sh <= stage.height + 1 && sw > 40 && sh > 20;
      let shows = false, why = "";
      if (it.kind === "math") {
        const el = document.querySelector(`.items > .it[data-item="${it.id}"]`);
        const m = el?.querySelector(".vc-math");
        const r = el?.getBoundingClientRect();
        const typeset = !!m && m.querySelectorAll(".katex").length > 0;
        // The typeset content fits its box (the box is cut at its height: overflow hidden).
        const fits = !!m && m.scrollHeight <= el.clientHeight + 2;
        shows = !!el && el.style.display !== "none" && typeset && fits && Math.abs(r.width - sw) < 3;
        why = !el ? "no element" : !typeset ? "not typeset" : !fits ? `cut off: content ${m.scrollHeight}px in a ${el.clientHeight}px box` : `${Math.round(r.width)} vs ${Math.round(sw)} px wide`;
      } else {
        // Ink on the base canvas inside the item's box (sampled on a grid): it was drawn.
        const x0 = Math.max(0, Math.floor(sx * dpr)), y0 = Math.max(0, Math.floor(sy * dpr));
        const w = Math.max(1, Math.min(base.width - x0, Math.floor(sw * dpr))), h = Math.max(1, Math.min(base.height - y0, Math.floor(sh * dpr)));
        const px = ctx.getImageData(x0, y0, w, h).data;
        let ink = 0, n = 0;
        for (let yy = 0; yy < h; yy += 4) for (let xx = 0; xx < w; xx += 4) {
          const i = (yy * w + xx) * 4;
          n++;
          if (px[i + 3] > 0 && px[i] + px[i + 1] + px[i + 2] < 600) ink++;
        }
        shows = ink / n > 0.002;
        why = `${((100 * ink) / n).toFixed(2)}% ink`;
      }
      out.push({ id: it.id, kind: it.kind, inView, shows, why, box: [Math.round(sx), Math.round(sy), Math.round(sw), Math.round(sh)] });
    }
    return { items: out, selected: d.selection?.items ?? 0, inboxOpen: !!document.querySelector("aside.inbox") };
  }, before);

for (let round = 1; round <= ROUNDS; round++) {
  // Somewhere new: pan and zoom as Carl would have left it.
  await page.evaluate((r) => {
    const v = window.__board;
    const z = v.homeZ * [1, 0.6, 1.8, 0.35, 2.5, 1.2, 0.8, 3, 0.5, 1.5][(r - 1) % 10];
    v.cam = { x: r * 900 - 3000 + (r % 3) * 517, y: (r % 4) * 1300 - 1800, z };
    v.drawLevel = v.levelFor();
    v.renderBase();
  }, round);
  await page.waitForTimeout(300);
  for (const e of entries) {
    const before = await page.evaluate(() => window.__board.debug().itemsList.map((x) => x.id));
    await tap('[data-act="inbox"]');
    await tap(`aside.inbox button[data-id="${e.id}"]`);
    await tap('aside.inbox button[data-add="all"]');
    await page.waitForFunction((n) => window.__board.debug().itemsList.length > n, before.length, { timeout: 15000 }).catch(() => {});
    await page.waitForSelector("aside.inbox", { state: "detached", timeout: 5000 }).catch(() => {});
    // Drawn within a moment (an image decodes, a PDF page's PNG is made, math is fetched and typeset).
    let r = await inspect(before);
    for (let i = 0; i < 30 && !(r.items.length && r.items.every((x) => x.shows)); i++) {
      await page.waitForTimeout(200);
      r = await inspect(before);
    }
    const kinds = [...new Set(e.kinds)].join("+");
    const bad = r.items.filter((x) => !x.inView || !x.shows);
    check(r.items.length === e.kinds.length * (e.kinds[0] === "pdf" ? 0 : 1) || r.items.length >= e.kinds.length, `round ${round}, ${kinds}: Add all made ${r.items.length} item(s)`);
    check(r.items.length > 0 && !bad.length, `round ${round}, ${kinds}: every item in view and showing`, bad.length ? JSON.stringify(bad) : `${r.items.length} items`);
    check(!r.inboxOpen && r.selected === r.items.length, `round ${round}, ${kinds}: the inbox closed, the parts selected`, JSON.stringify({ inbox: r.inboxOpen, selected: r.selected }));
  }
}

const fails = logged.filter((e) => e.ev === "inbox.fail");
check(!fails.length, "no inbox.fail in the board's log", JSON.stringify(fails));
await browser.close();
console.log(failed() ? `${failed()} check(s) failed` : "all checks passed");
process.exit(failed() ? 1 : 0);
