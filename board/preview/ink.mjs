// Ink on the iPad, measured in WebKit (board/preview/ipad.mjs: iPad Pro 11 at DPR 2, Mac UA, touch):
//   1. crisp ink: the screen's pixels against the same strokes drawn natively at the device's resolution, at 1×
//      and 2× zoom (edge width and the difference to native);
//   2. the highlighter: one path at one alpha (no darkening where it overlaps itself), under the pen's ink (a blue
//      line keeps its colour under it, while it is drawn and after), even across tile seams;
//   3. scribble to erase: a scribble over a word erases it (one undo step, the scribble gone, a fade), a scribble
//      on empty paper stays ink, and normal writing over ink (m, w, z, ∑, zigzags) never erases.
// Screenshots go to OUT (default: the OS temp dir).
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/ink.mjs [http://localhost:1431/board/]
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipadPage, checker } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const OUT = process.env.OUT ?? join(tmpdir(), "board-ink");
mkdirSync(OUT, { recursive: true });
const { check, failed } = checker();
const { browser, page } = await ipadPage();
page.on("pageerror", (e) => check(false, "no page error", e.message));
await page.route("**/api/v1/board/log", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' }));
// A Pencil along a path, with the samples' real spacing in time (a busy-wait: a page's timers run late).
await page.addInitScript(() => {
  let down = null;
  const fire = (type, x, y, buttons) => {
    const target = type === "pointerdown" ? (document.elementFromPoint(x, y) ?? document.body) : down;
    if (type === "pointerdown") down = target;
    target.dispatchEvent(new PointerEvent(type, { pointerId: 950, pointerType: "pen", isPrimary: true, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, width: 1, height: 1, pressure: buttons ? 0.5 : 0, buttons, button: type === "pointermove" ? -1 : 0 }));
  };
  const until = (t) => {
    while (performance.now() < t);
  };
  /** pts: [{x, y, t}] in css px and ms from the start; `hold`: leave the pen down (lift with __penUp). */
  window.__penPath = async (pts, hold = false) => {
    const t0 = performance.now();
    fire("pointerdown", pts[0].x, pts[0].y, 1);
    for (let i = 1; i < pts.length; i++) {
      until(t0 + pts[i].t - pts[0].t);
      fire("pointermove", pts[i].x, pts[i].y, 1);
      // Let a frame through now and then, as a real stroke would.
      if (i % 24 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const l = pts[pts.length - 1];
    window.__penAt = l;
    if (!hold) fire("pointerup", l.x, l.y, 0);
  };
  window.__penUp = () => fire("pointerup", window.__penAt.x, window.__penAt.y, 0);
});

/** A straight-ish path from a to b, a sample every 4 ms at `speed` px/ms. */
const line = (a, b, speed = 0.4) => {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(2, Math.ceil(d / (speed * 4)));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a[0] + ((b[0] - a[0]) * i) / n, y: a[1] + ((b[1] - a[1]) * i) / n, t: i * 4 }));
};
const poly = (ps, speed = 0.4) => {
  const out = [];
  for (let i = 0; i + 1 < ps.length; i++) {
    const seg = line(ps[i], ps[i + 1], speed);
    const t0 = out.length ? out[out.length - 1].t : 0;
    out.push(...(out.length ? seg.slice(1) : seg).map((p) => ({ ...p, t: p.t + t0 })));
  }
  return out;
};
const pen = (pts, hold) => page.evaluate(([p, h]) => window.__penPath(p, h), [pts, !!hold]);
const dbg = () => page.evaluate(() => window.__board.debug());
const settle = (ms = 700) => page.waitForTimeout(ms);

async function openBoard() {
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  const slug = await page.evaluate(async () => {
    const r = await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Ink ${Date.now() % 100000}` }) });
    return (await r.json()).slug;
  });
  await page.goto("about:blank");
  await page.goto(`${url}#/b/${slug}`);
  await page.waitForFunction(() => !!window.__board?.debug);
  await page.evaluate(() => {
    const v = window.__board;
    v.board.grid = "plain";
    v.setMode?.("pen");
  });
  await settle(400);
}
/** Set the camera (canvas units at the view's top-left, zoom as a multiple of home) and let it settle. */
const camTo = async (x, y, k) => {
  await page.evaluate(([x, y, k]) => {
    const v = window.__board;
    v.cam = { x, y, z: v.homeZ * k };
    v.camMoved();
  }, [x, y, k]);
  await settle(900);
};
const setTool = (mode, extra = {}) =>
  page.evaluate(([m, e]) => {
    const v = window.__board;
    Object.assign(v.prefs, e);
    v.setMode(m);
  }, [mode, extra]);

/** The screen's device pixels in a css-px rect (a real screenshot, decoded in the page). */
async function pixels(clip) {
  const png = await page.screenshot({ clip, scale: "device" });
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0);
    return { w: c.width, h: c.height, d: Array.from(x.getImageData(0, 0, c.width, c.height).data) };
  }, png.toString("base64"));
}
const px = (im, x, y) => {
  const k = (Math.round(y) * im.w + Math.round(x)) * 4;
  return [im.d[k], im.d[k + 1], im.d[k + 2]];
};
const lum = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
const shot = async (name, clip) => {
  const f = join(OUT, `${name}.png`);
  writeFileSync(f, await page.screenshot({ clip, scale: "device" }));
  return f;
};

/** The same strokes drawn natively at the device's resolution on white (what a crisp screen shows), in a css rect. */
const nativeRef = (clip) =>
  page.evaluate(async (clip) => {
    const { drawStroke } = await import("/board/src/ink.ts");
    const v = window.__board;
    const d = v.dpr, { x, y, z } = v.cam;
    const r = v.stage.getBoundingClientRect();
    const c = document.createElement("canvas");
    c.width = Math.round(clip.width * d);
    c.height = Math.round(clip.height * d);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(z * d, 0, 0, z * d, (-x * z - (clip.x - r.left)) * d, (-y * z - (clip.y - r.top)) * d);
    for (const s of v.board.strokes) drawStroke(ctx, s);
    return { w: c.width, h: c.height, d: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
  }, clip);

/**
 * Sharpness of the ink in a rect: the mean width (device px) of its edges' ramps from 10% to 90% of the ink's
 * darkness, along each column through the strokes (a crisp anti-aliased edge is about 1 px), and the mean absolute
 * difference (0–255) from the native rendering where either has ink.
 */
function sharpness(im, ref) {
  let ramps = 0, edges = 0, diff = 0, nd = 0;
  for (let x = 0; x < im.w; x++) {
    const col = [];
    for (let y = 0; y < im.h; y++) col.push(255 - lum(px(im, x, y)));
    const peak = Math.max(...col);
    if (peak < 120) continue;
    // Each rising edge: from 10% to 90% of the peak.
    for (let y = 1; y < im.h; y++) {
      if (col[y - 1] < 0.1 * peak && col[y] >= 0.1 * peak) {
        let k = y;
        while (k < im.h && col[k] < 0.9 * peak) k++;
        if (k < im.h && k - y < 12) {
          ramps += k - y + 1;
          edges++;
        }
      }
    }
  }
  for (let y = 0; y < im.h; y++)
    for (let x = 0; x < im.w; x++) {
      const a = 255 - lum(px(im, x, y)), b = 255 - lum(px(ref, x, y));
      if (a > 8 || b > 8) (diff += Math.abs(a - b)), nd++;
    }
  return { edgePx: edges ? ramps / edges : NaN, diffToNative: nd ? diff / nd : NaN };
}

const report = {};

// ================================================================ 1. crisp ink
await openBoard();
await setTool("pen", { pen: 1.4, penColor: "#1f1f24" });
// Handwriting-like curves and a slanted line.
const word = (x, y) => [
  poly([[x, y + 20], [x + 8, y], [x + 16, y + 22], [x + 24, y + 2], [x + 34, y + 21]], 0.3),
  poly(Array.from({ length: 25 }, (_, i) => [x + 44 + i * 2, y + 10 + 10 * Math.sin(i / 3)]), 0.3),
  line([x, y + 40], [x + 120, y + 52], 0.4),
];
for (const p of word(300, 300)) await pen(p);
await settle(600);
const inkClip = { x: 290, y: 290, width: 140, height: 72 };
for (const k of [1, 2]) {
  if (k === 2) {
    // Zoomed in 2× about the word.
    const c = await page.evaluate(() => window.__board.cam);
    await camTo(c.x + 300 / c.z - 300 / (c.z * 2) + 40 / c.z, c.y + 300 / c.z - 300 / (c.z * 2) + 20 / c.z, 2);
  }
  const clip = k === 1 ? inkClip : { x: 290, y: 290, width: 280, height: 144 };
  const ref = await nativeRef(clip);
  const s = sharpness(await pixels(clip), ref);
  s.nativeEdgePx = sharpness(ref, ref).edgePx;
  const d = await dbg();
  // (level: the power-of-two tiles before 2026-10-18)
  report[`ink ${k}×`] = { ...s, dpr: await page.evaluate(() => window.__board.dpr), tileScale: d.tileScale ?? 2 ** d.level, screenScale: d.cam.z * (await page.evaluate(() => window.__board.dpr)) };
  await shot(`ink-${k}x`, clip);
  check(s.edgePx <= s.nativeEdgePx + 0.15 && s.diffToNative <= 3, `ink at ${k}× zoom is as crisp as native at DPR 2`, `edge ${s.edgePx.toFixed(2)} px (native ${s.nativeEdgePx.toFixed(2)}), ${s.diffToNative.toFixed(1)}/255 from native; tiles at ${report[`ink ${k}×`].tileScale.toFixed(3)} px/unit for a ${report[`ink ${k}×`].screenScale.toFixed(3)} screen`);
}

// ================================================================ 2. the highlighter
await openBoard();
// Blue vertical lines, then one highlighter stroke across them, along and back (it overlaps itself), long
// enough to cross tile seams.
await setTool("pen", { pen: 2.4, penColor: "#1f5bd6" });
for (let x = 200; x <= 900; x += 70) await pen(line([x, 330], [x, 430], 0.5));
await setTool("hl", { hl: 18, hlColor: "#ffd21f" });
const Y = 380;
const hlPath = poly([[180, Y], [920, Y], [180, Y + 9]], 0.8);
// While it is being drawn (the pen still down).
await pen(hlPath, true);
await page.waitForTimeout(120);
const live = await pixels({ x: 150, y: 330, width: 800, height: 100 });
await shot("hl-live", { x: 150, y: 330, width: 800, height: 100 });
await page.evaluate(() => window.__penUp());
await settle(800);
const done = await pixels({ x: 150, y: 330, width: 800, height: 100 });
await shot("hl-committed", { x: 150, y: 330, width: 800, height: 100 });
{
  const d = await page.evaluate(() => window.__board.dpr);
  const at = (im, x, y) => px(im, (x - 150) * d, (y - 330) * d);
  // The blue line's centre, inside the band and above it.
  const blueOut = at(done, 270, 340), blueIn = at(done, 270, Y + 4), blueLive = at(live, 270, Y + 4);
  // The band: where the stroke overlaps itself (between the two passes) and where it is single.
  const single = at(done, 305, Y - 6), overlap = at(done, 305, Y + 4), single2 = at(done, 305, Y + 14);
  // Along the band (between the blue lines), every device px: the most any pixel strays from the median.
  const row = [];
  for (let x = 205 * d; x < 900 * d; x++) {
    const xc = x / d;
    if ((xc - 200) % 70 < 6 || (xc - 200) % 70 > 64) continue;
    row.push(lum(px(done, x - 150 * d, (Y - 6 - 330) * d)));
  }
  const sorted = [...row].sort((a, b) => a - b), med = sorted[sorted.length >> 1];
  const stray = Math.max(...row.map((v) => Math.abs(v - med)));
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  report.highlighter = { blueOut, blueIn, blueLive, single, overlap, single2, seamStray: stray, tileScale: (await dbg()).tileScale ?? 2 ** (await dbg()).level };
  check(dist(single, overlap) <= 6 && dist(single2, overlap) <= 6, "the highlighter is one path at one alpha (no darkening where it overlaps itself)", `single ${single} · overlap ${overlap} · single ${single2}`);
  check(dist(blueIn, blueOut) <= 12, "under the highlighter the pen's ink keeps its colour (ink above, highlighter below)", `blue ${blueOut} outside, ${blueIn} under it`);
  check(dist(blueLive, blueOut) <= 12, "…while it is being drawn too", `blue ${blueLive} under the live stroke`);
  check(stray <= 4, "no seam along the highlighter (tile edges invisible)", `largest stray from the band's colour: ${stray.toFixed(1)}`);
  // Multiply-like on white: the band is the colour itself, lightened, never greyed.
  check(single[0] > 240 && single[1] > 220 && single[2] < 200, "a yellow band on white paper", String(single));
}

// ================================================================ 3. scribble to erase
const hasScribble = await page.evaluate(() => "scribble" in window.__board.prefs);
await openBoard();
await setTool("pen", { pen: 2.4, penColor: "#1f1f24" });
const traces = await page.evaluate(async () => {
  const m = await import("/board/src/scribbleTraces.ts");
  return m.scribbleTraces(3);
});
const place = (pts, cx, cy) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
  return pts.map((p) => ({ x: p.x - (x0 + x1) / 2 + cx, y: p.y - (y0 + y1) / 2 + cy, t: p.t }));
};
// A word, and a second word beside it.
const write = async (x, y) => {
  for (let i = 0; i < 4; i++) await pen(poly([[x + i * 16, y + 12], [x + i * 16 + 5, y], [x + i * 16 + 10, y + 12]], 0.3));
};
await write(300, 300);
await write(420, 300);
await settle(300);
const before = await dbg();
const scrib = traces.find((t) => t.name.startsWith("horizontal scribble"));
// Freeze the fade at its middle for the screenshot (the page's clock, for this one frame).
await pen(place(scrib.pts, 330, 306));
const fading = await page.evaluate(() => {
  const v = window.__board, f = v.fades?.[0];
  if (!f) return 0;
  f.t0 = performance.now() - 120;
  const real = performance.now.bind(performance);
  performance.now = () => f.t0 + 120;
  v.renderLive();
  window.__unfreeze = () => (performance.now = real);
  return f.strokes.length;
});
await shot("scribble-fade", { x: 270, y: 270, width: 260, height: 80 });
await page.evaluate(() => window.__unfreeze?.());
check(fading === 5, "the erased strokes and the scribble fade out", `${fading} fading`);
await settle(600);
const after = await dbg();
await shot("scribble-after", { x: 270, y: 270, width: 260, height: 80 });
check(hasScribble && after.prefs.scribble === true, "Scribble to erase is a setting, on by default", String(after.prefs.scribble));
check(after.strokes === before.strokes - 4, "a scribble over a word erases its four strokes (not the word beside it), and the scribble leaves no ink", `${before.strokes} → ${after.strokes} strokes`);
check((await page.evaluate(() => window.__board.fades.length)) === 0, "…and the fade is over", "");
check(after.undo === before.undo + 1, "…as one undo step", `${before.undo} → ${after.undo}`);
await page.evaluate(() => window.__board.undo());
check((await dbg()).strokes === before.strokes, "undo brings the word back", `${(await dbg()).strokes}`);
await page.evaluate(() => window.__board.redo());
// On empty paper a scribble is ink (shading).
const n0 = (await dbg()).strokes;
await pen(place(scrib.pts, 700, 600));
await settle(300);
check((await dbg()).strokes === n0 + 1, "a scribble over nothing stays as ink", `${n0} → ${(await dbg()).strokes}`);
// Normal writing over ink never erases.
const normal = traces.filter((t) => !t.scribble);
let x = 150, y = 470, erased = [];
for (const t of normal) {
  await write(x - 10, y - 6); // ink under it
  const k0 = (await dbg()).strokes;
  await pen(place(t.pts, x + 20, y));
  await page.waitForTimeout(30);
  const k1 = (await dbg()).strokes;
  if (k1 !== k0 + 1) erased.push(`${t.name}: ${k0} → ${k1}`);
  x += 120;
  if (x > 1050) (x = 150), (y += 60);
}
await settle(300);
await shot("scribble-normal-writing", { x: 100, y: 430, width: 1000, height: 300 });
check(erased.length === 0, `normal writing over ink never erases (${normal.length} letters and symbols: m, mmm, w, www, z, ∑, M, ☆, zigzags…)`, erased.join("; "));
// Off: the same scribble is ink.
await page.evaluate(() => (window.__board.prefs.scribble = false));
await write(300, 650);
const m0 = (await dbg()).strokes;
await pen(place(scrib.pts, 330, 656));
await settle(200);
check((await dbg()).strokes === m0 + 1, "with Scribble to erase off, a scribble is ink", `${m0} → ${(await dbg()).strokes}`);

console.log(JSON.stringify(report, null, 1));
console.log(`screenshots: ${OUT}`);
await browser.close();
console.log(failed() ? `${failed()} check(s) failed` : "all checks passed");
process.exit(failed() ? 1 : 0);
