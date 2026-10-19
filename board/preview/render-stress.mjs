// Nothing on the board disappears — in WebKit as Carl's iPad (Mac UA, touch, DPR 2), under what an iPad does to a
// page that WebKit on a desktop does not:
//
//   - a cap on canvas memory (iPadOS: past it, getContext("2d") returns null): emulated here, counting every canvas
//     that has a context and has not been given back (width 0) — as if the garbage collector never ran, the worst
//     case; CANVAS_MB (default 256) is the cap;
//   - going to the background and back: iPadOS may drop canvases' backing stores; emulated by wiping every canvas
//     while the page is hidden, then visibilitychange and pageshow as it returns.
//
// Then a random session (seeded): Pencil strokes, inbox adds (images, PDF pages, math), undo/redo, pinches to new
// zooms (every settle is a new tile scale), pans, scribble-erase, background/foreground. After each action, once the
// camera settles: every pen stroke in view has its ink on the base canvas, every image/PDF item in view has its
// picture there, every math item in view is laid out where its box is. Screenshots of failures go to
// board/preview/out/render-stress-*.png.
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/render-stress.mjs [board url] [actions] [seed]
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ipadPage, checker, touchScript } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const ACTIONS = Number(process.argv[3] ?? 120);
let seed = Number(process.argv[4] ?? 7);
const CANVAS_MB = Number(process.env.CANVAS_MB ?? 256);
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });
const { check, failed } = checker();
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const { browser, page } = await ipadPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.route("**/api/v1/board/log", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' }));
await page.addInitScript(touchScript());
await page.addInitScript((capMB) => {
  // iPadOS's canvas memory cap, with no garbage collection: a canvas counts from its first context until its width
  // or height is set to 0.
  const live = new Set();
  const bytes = () => {
    let n = 0;
    for (const c of live) n += c.width * c.height * 4;
    return n;
  };
  const get = HTMLCanvasElement.prototype.getContext;
  window.__canvas = { live, bytes, refused: 0 };
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    if (type === "2d" && !live.has(this)) {
      if (bytes() + this.width * this.height * 4 > capMB * 1048576) {
        window.__canvas.refused++;
        return null;
      }
      live.add(this);
    }
    return get.call(this, type, opts);
  };
  for (const k of ["width", "height"]) {
    const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, k);
    Object.defineProperty(HTMLCanvasElement.prototype, k, {
      get: d.get,
      set(v) {
        d.set.call(this, v);
        if (!v) live.delete(this);
      },
      configurable: true,
    });
  }
  // Background: iPadOS may drop every canvas's pixels.
  window.__background = async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    for (const c of live) get.call(c, "2d")?.clearRect(0, 0, c.width, c.height);
    await new Promise((r) => setTimeout(r, 200));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  };
}, CANVAS_MB);

await page.goto(url);
await page.evaluate(() => localStorage.clear());
const slug = await page.evaluate(async () => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Stress ${Date.now() % 100000}` }) })).json()).slug);
await page.goto("about:blank");
await page.goto(`${url}#/b/${slug}`);
await page.waitForFunction(() => !!window.__board?.debug);
await page.waitForTimeout(300);
const entries = await page.evaluate(async () => (await (await fetch("/api/v1/inbox")).json()).entries.filter((e) => !e.making && !e.failed && e.parts.every((p) => ["image", "pdf", "math"].includes(p.kind))).map((e) => e.id));

const settle = () =>
  page.evaluate(async () => {
    const v = window.__board;
    const t0 = performance.now();
    while (performance.now() - t0 < 5000 && (v.gesturing || v.g || v.debug().tileScale !== v.screenScale())) await new Promise((r) => setTimeout(r, 30));
    // Tiles are drawn a few per frame; images decode; pdf.js sharpens.
    await new Promise((r) => setTimeout(r, 900));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

/** What is in view and whether it shows. */
const inspect = () =>
  page.evaluate(() => {
    const v = window.__board;
    const base = document.querySelector("canvas.base");
    const stage = document.querySelector(".stage").getBoundingClientRect();
    const dpr = base.width / stage.width;
    const ctx = base.getContext("2d");
    if (!ctx) return { fail: ["the base canvas has no context"] };
    const z = v.cam.z;
    const px = (x, y) => {
      const sx = (x - v.cam.x) * z, sy = (y - v.cam.y) * z;
      if (sx < 2 || sy < 80 || sx > stage.width - 2 || sy > stage.height - 2) return null;
      return ctx.getImageData(Math.round(sx * dpr), Math.round(sy * dpr), 1, 1).data;
    };
    const fail = [];
    let strokes = 0, items = 0;
    const covered = (x, y) => v.board.items.some((it) => (it.kind === "math" || it.kind === "widget") && x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h);
    for (const st of v.board.strokes) {
      if (st.tool !== "pen" || st.w * z < 1.2) continue;
      const pts = [];
      for (let k = 0; k + 1 < st.xy.length; k += 2) pts.push([st.xy[k], st.xy[k + 1]]);
      const probe = [pts[0], pts[Math.floor(pts.length / 2)], pts[pts.length - 1]].filter(Boolean);
      for (const [x, y] of probe) {
        const p = px(x, y);
        if (!p) continue;
        strokes++;
        // Ink is dark and opaque on the base canvas (math under the canvas excepted: the canvas is clear there).
        if (!(p[3] > 120 && p[0] + p[1] + p[2] < 450) && !covered(x, y)) fail.push(`stroke ${st.id} missing at ${Math.round(x)},${Math.round(y)} (rgba ${[...p].join(",")})`);
      }
    }
    for (const it of v.board.items) {
      const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
      if (it.kind === "image" || it.kind === "pdf") {
        // Its picture is opaque: a few points inside it, not on ink.
        for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.3], [0.8, 0.7]]) {
          const p = px(it.x + it.w * fx, it.y + it.h * fy);
          if (!p) continue;
          items++;
          if (p[3] < 200) fail.push(`${it.kind} ${it.id} blank at ${fx},${fy} (alpha ${p[3]})`);
        }
      } else if (it.kind === "math") {
        const sx = (cx - v.cam.x) * z, sy = (cy - v.cam.y) * z;
        if (sx < 0 || sy < 80 || sx > stage.width || sy > stage.height) continue;
        items++;
        const el = document.querySelector(`.items > .it[data-item="${it.id}"]`);
        const r = el?.getBoundingClientRect();
        const ex = (it.x - v.cam.x) * z + stage.left, ey = (it.y - v.cam.y) * z + stage.top;
        if (!el || el.style.display === "none" || !el.querySelector(".katex,.vc-math")?.textContent) fail.push(`math ${it.id} not shown`);
        else if (Math.abs(r.left - ex) > 2 || Math.abs(r.top - ey) > 2) fail.push(`math ${it.id} at ${Math.round(r.left)},${Math.round(r.top)}, its box at ${Math.round(ex)},${Math.round(ey)}`);
      }
    }
    return { fail, strokes, items, mb: Math.round(window.__canvas.bytes() / 1048576), canvases: window.__canvas.live.size, refused: window.__canvas.refused, tiles: v.tiles.size };
  });

const tap = async (sel) => {
  // The sheet repaints its list when the box answers: an element can be replaced between finding and tapping it.
  for (let i = 0; i < 40; i++) {
    const el = page.locator(sel).first();
    await el.waitFor({ state: 'visible', timeout: 8000 });
    await el.evaluate((n) => n.scrollIntoView({ block: 'center' })).catch(() => {});
    const b = await el.boundingBox({ timeout: 1000 }).catch(() => null);
    // On screen (a list repainted under the scroll moves it): else found and scrolled again.
    if (b && b.y >= 0 && b.y + b.height <= (page.viewportSize()?.height ?? 1e9)) return page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(50);
  }
  throw new Error(`nothing to tap: ${sel}`);
};

const ACTS = {
  async pen() {
    await page.evaluate(async ([a, b]) => {
      window.__board.setMode("pen");
      await window.__pen(a, b);
    }, [[150 + rnd() * 800, 150 + rnd() * 550], [150 + rnd() * 800, 150 + rnd() * 550]]);
  },
  async scribble() {
    await page.evaluate(async ([x, y]) => {
      window.__board.setMode("pen");
      await window.__pen([x, y], [x + 200, y + 20]);
      // A quick zigzag over it.
      const pts = [];
      for (let k = 0; k <= 8; k++) pts.push([x + k * 25, y + (k % 2 ? 30 : -10)]);
      for (let k = 0; k + 1 < pts.length; k++) await window.__pen(pts[k], pts[k + 1], 16, 2);
    }, [200 + rnd() * 500, 200 + rnd() * 400]);
  },
  async add() {
    if (!entries.length) return;
    await tap('[data-act="inbox"]');
    await tap(`aside.inbox button[data-id="${pick(entries)}"]`);
    const n = await page.evaluate(() => window.__board.debug().items);
    await tap('aside.inbox button[data-add="all"]');
    await page.waitForFunction((n) => window.__board.debug().items > n, n, { timeout: 15000 }).catch(() => {});
    await page.waitForSelector("aside.inbox", { state: "detached", timeout: 5000 }).catch(() => {});
  },
  async undo() {
    await page.evaluate(() => window.__board.undo());
  },
  async redo() {
    await page.evaluate(() => window.__board.redo());
  },
  async zoom() {
    // A two-finger pinch about a random point, to a new zoom (each settle is a new tile scale).
    const cx = 300 + rnd() * 600, cy = 250 + rnd() * 400, k = 0.5 + rnd() * 1.6, d0 = 120;
    await page.evaluate(
      ([cx, cy, d0, d1]) =>
        window.__gesture(
          [
            { id: 11, from: [cx - d0, cy], to: [cx - d1, cy], size: 42 },
            { id: 12, from: [cx + d0, cy], to: [cx + d1, cy], size: 42 },
          ],
          260,
          20,
          10,
        ),
      [cx, cy, d0, d0 * k],
    );
  },
  async pan() {
    const dx = (rnd() - 0.5) * 700, dy = (rnd() - 0.5) * 500;
    await page.evaluate(([dx, dy]) => window.__gesture([{ id: 21, from: [600, 420], to: [600 + dx, 420 + dy], size: 42 }], 220, 0, 8), [dx, dy]);
  },
  async background() {
    await page.evaluate(() => window.__background());
  },
  async home() {
    // Back to where things are.
    await page.evaluate(() => {
      const v = window.__board;
      const d = v.debug();
      const all = [...d.itemsList.map((i) => [i.x + i.w / 2, i.y + i.h / 2]), ...v.board.strokes.slice(-5).map((s) => [s.xy[0], s.xy[1]])];
      if (!all.length) return;
      const [x, y] = all[Math.floor(Math.random() * all.length)];
      v.cam = { z: v.homeZ * (0.5 + Math.random()), x: 0, y: 0 };
      v.cam.x = x - 600 / v.cam.z;
      v.cam.y = y - 420 / v.cam.z;
      v.camMoved();
    });
  },
};
const WEIGHTS = [["pen", 5], ["scribble", 1], ["add", 2], ["undo", 2], ["redo", 1], ["zoom", 4], ["pan", 3], ["background", 1], ["home", 2]];
const choose = () => {
  let r = rnd() * WEIGHTS.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of WEIGHTS) if ((r -= w) < 0) return k;
  return "pen";
};

let bad = 0, shots = 0, maxMb = 0;
let seen = { strokes: 0, items: 0 };
for (let n = 1; n <= ACTIONS; n++) {
  const act = n <= 3 ? "pen" : n === 4 ? "add" : choose();
  try {
    await ACTS[act]();
  } catch (e) {
    check(false, `action ${n} (${act}) ran`, String(e.message).slice(0, 160));
    continue;
  }
  const t0 = Date.now();
  await settle();
  const r = await inspect();
  if (process.env.VERBOSE) console.log(`  ${n} ${act}: ${Date.now() - t0} ms settle, ${r.tiles} tiles, ${r.canvases} canvases, ${r.mb} MB`);
  maxMb = Math.max(maxMb, r.mb ?? 0);
  seen.strokes += r.strokes ?? 0;
  seen.items += r.items ?? 0;
  if (r.fail.length) {
    bad++;
    check(false, `after action ${n} (${act}): everything in view shows`, `${r.fail.length} missing: ${r.fail.slice(0, 3).join("; ")} · canvases ${r.canvases}, ${r.mb} MB, ${r.refused} refused`);
    if (shots++ < 6) await page.screenshot({ path: join(OUT, `render-stress-${n}-${act}.png`) });
  }
}
const fin = await page.evaluate(() => ({ mb: Math.round(window.__canvas.bytes() / 1048576), canvases: window.__canvas.live.size, refused: window.__canvas.refused }));
check(bad === 0, `${ACTIONS} actions: nothing in view went missing`, `${seen.strokes} stroke points and ${seen.items} item points checked; canvas memory peak ${maxMb} MB (cap ${CANVAS_MB}), ${fin.canvases} canvases now, ${fin.refused} contexts refused`);
check(!errors.length, "no page errors", errors.slice(0, 3).join(" | "));
await page.screenshot({ path: join(OUT, "render-stress-end.png") });
await browser.close();
console.log(failed() ? `\n${failed()} check(s) failed` : "\nall checks passed");
process.exit(failed() ? 1 : 0);
