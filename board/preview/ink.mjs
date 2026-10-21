// Ink on the iPad, measured in WebKit (board/preview/ipad.mjs: iPad Pro 11 at DPR 2, Mac UA, touch):
//   1. crisp ink: the screen's pixels against the same strokes drawn natively at the device's resolution, at 1×
//      and 2× zoom (edge width and the difference to native);
//   2. the highlighter: one path at one alpha (no darkening where it overlaps itself), under the pen's ink (a blue
//      line keeps its colour under it, while it is drawn and after), even across tile seams;
//   2b. no gaps in the highlighter: jittery strokes that cross themselves and the ink, across tile seams, at 1×, 2×
//      and 0.5×: every device px along each stroke's path is highlight (or ink on top); and after the Pencil lifts it
//      stays on screen every frame for 2 s (the live layer hands over to the tiles with no blank frame);
//   3. scribble to erase, deliberate (GoodNotes): while a long scribble is written over a word, the word dims (a
//      preview) and nothing is erased yet; on lift it is erased (one undo step, the scribble gone, a fade); a short
//      scribble over a word stays ink and the word comes back whole; a scribble on empty paper stays ink; normal
//      writing over ink (m, w, z, ∑, quick zigzags) never erases;
//   4. handwriting, small letters and fast long strokes (board/src/inkTraces.ts) written with the Pencil at 1× and 2×:
//      screenshots, and the stroke the pen left is the one drawn while it was down (no jump on lift).
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
  // A board still saving finishes first (navigating away cancels its request: WebKit reports that as a page error).
  await page.evaluate(() => window.__board?.flush?.()).catch(() => {});
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

// ================================================================ 2b. no gaps in the highlighter
{
  let seed = 5;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  // A Pencil along a curve: a sample every 1/240 s at `speed` px/ms, a little tremor, whole px (as WebKit gives them).
  const trace = (f, n, speed) => {
    const dense = Array.from({ length: n + 1 }, (_, i) => f(i / n));
    const out = [{ x: Math.round(dense[0][0]), y: Math.round(dense[0][1]), t: 0 }];
    let acc = 0, t = 0;
    for (let i = 1; i < dense.length; i++) {
      acc += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]) / speed;
      if (acc >= 1000 / 240) {
        t += acc;
        acc = 0;
        out.push({ x: Math.round(dense[i][0] + rnd() * 0.6), y: Math.round(dense[i][1] + rnd() * 0.6), t });
      }
    }
    return out;
  };
  const hlPaths = () => [
    trace((u) => [120 + 850 * u, 260 + 8 * Math.sin(u * 20)], 600, 0.7), // long and wavy, across tile seams
    trace((u) => [500 + 120 * Math.cos(u * 2.4 * Math.PI) + 200 * u, 400 + 80 * Math.sin(u * 2.4 * Math.PI)], 600, 0.5), // a loop crossing itself
    trace((u) => { const s = u * 7, leg = Math.floor(s), ph = s % 1; return [150 + 560 * (leg % 2 ? 1 - ph : ph), 520 + leg * 6]; }, 1400, 1.2), // back and forth over itself
    trace((u) => [200 + 40 * u + 25 * Math.sin(u * 40), 330 + 120 * u], 500, 0.3), // a tight slow wiggle
  ];
  const gapReport = {};
  for (const k of [1, 2, 0.5]) {
    await openBoard();
    await camTo(0, 0, k);
    await setTool("pen", { pen: 2.4, penColor: "#1f5bd6" });
    for (let x = 150; x < 1000; x += 90) await pen(trace((u) => [x + 3 * Math.sin(u * 6), 200 + 380 * u], 200, 0.5));
    await setTool("hl", { hl: 18, hlColor: "#ffd21f" });
    const paths = hlPaths();
    for (const p of paths) await pen(p);
    await settle(900);
    const full = { x: 0, y: 150, width: 1100, height: 500 };
    // The screen's pixels along each path, read in the page (a whole-screen array is too big to bring back).
    const png = await page.screenshot({ clip: full, scale: "device" });
    const { n, gaps, where } = await page.evaluate(
      async ([b64, paths, full]) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const x = c.getContext("2d");
        x.drawImage(img, 0, 0);
        const px = x.getImageData(0, 0, c.width, c.height).data, d = window.__board.dpr;
        let n = 0, gaps = 0;
        const where = [];
        for (const p of paths)
          for (let i = 1; i < p.length; i++) {
            const a = p[i - 1], b = p[i], m = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * d);
            for (let j = 0; j < m; j++) {
              const X = Math.round((a.x + ((b.x - a.x) * j) / m - full.x) * d), Y = Math.round((a.y + ((b.y - a.y) * j) / m - full.y) * d);
              const k = (Y * c.width + X) * 4;
              n++;
              // Paper (white) where the stroke passed: a gap. Highlight is yellow, ink under it blue.
              if (px[k] > 245 && px[k + 1] > 245 && px[k + 2] > 235) {
                gaps++;
                if (where.length < 5) where.push(`${(X / d + full.x).toFixed(1)},${(Y / d + full.y).toFixed(1)}`);
              }
            }
          }
        return { n, gaps, where };
      },
      [png.toString("base64"), paths, full],
    );
    gapReport[`${k}×`] = { samples: n, gaps };
    await shot(`hl-gaps-${k}x`, full);
    check(gaps === 0, `no gaps in highlighter strokes that cross themselves and the ink, across tile seams, at ${k}×`, `${gaps} of ${n} px along the paths are paper${where.length ? ` (at ${where.join(" ")})` : ""}`);
  }
  report.highlighterGaps = gapReport;

  // After the lift, every frame for 2 s: a point on the stroke away from the ink shows the highlight, on the live
  // canvas while the pen is down and on the tiles after (read straight from the canvases each frame).
  await openBoard();
  await setTool("hl", { hl: 18, hlColor: "#ffd21f" });
  const path = trace((u) => [200 + 600 * u, 420 + 10 * Math.sin(u * 9)], 600, 0.6);
  await pen(path, true);
  const probe = path[Math.floor(path.length / 2)];
  const frames = await page.evaluate(async (probe) => {
    const v = window.__board;
    const r = v.stage.getBoundingClientRect(), d = v.dpr;
    const read = (c) => {
      const x = c.getContext("2d").getImageData(Math.round((probe.x - r.left) * d), Math.round((probe.y - r.top) * d), 1, 1).data;
      return x[3];
    };
    const out = [];
    const t0 = performance.now();
    let lifted = false;
    await new Promise((done) => {
      const tick = () => {
        const t = performance.now() - t0;
        if (!lifted && t > 50) {
          lifted = true;
          window.__penUp();
        }
        out.push({ t: Math.round(t), base: read(v.base), live: read(v.live), lifted });
        if (t < 2050) setTimeout(tick, 16);
        else done();
      };
      // Every ~16 ms (a timer, not rAF: a page the test runner does not keep in front gets few frames), reading
      // the canvases as they stand.
      setTimeout(tick, 0);
    });
    return out;
  }, probe);
  const blank = frames.filter((f) => f.base < 20 && f.live < 20);
  report.highlighterFrames = { frames: frames.length, afterLift: frames.filter((f) => f.lifted).length, blank: blank.length };
  check(frames.length > 60 && blank.length === 0, "the highlighter stays on screen for 2 s after the Pencil lifts, sampled every 16 ms (never blank)", `${frames.length} samples, ${blank.length} blank${blank.length ? ` (at ${blank.slice(0, 5).map((f) => f.t).join(", ")} ms)` : ""}`);
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
// While it is written (the Pencil still down): the word it covers dims, nothing is erased yet.
await pen(place(scrib.pts, 330, 306), true);
await page.waitForTimeout(80);
const mid = await dbg();
await shot("scribble-preview", { x: 270, y: 270, width: 260, height: 80 });
check(mid.dimmed === 4 && mid.strokes === before.strokes, "while a scribble is written over a word, the word dims and nothing is erased yet", `${mid.dimmed} dimmed, ${before.strokes} → ${mid.strokes} strokes`);
// Freeze the fade at its middle for the screenshot (the page's clock, for this one frame).
await page.evaluate(() => window.__penUp());
const fading = await page.evaluate(() => {
  // The word fades from its dimmed look, the scribble from whole: every fade frozen at its middle.
  const v = window.__board, fs = v.fades ?? [];
  if (!fs.length) return 0;
  const t0 = performance.now() - 120;
  for (const f of fs) f.t0 = t0;
  const real = performance.now.bind(performance);
  performance.now = () => t0 + 120;
  v.renderLive();
  window.__unfreeze = () => (performance.now = real);
  return fs.reduce((n, f) => n + f.strokes.length, 0);
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
// A short scribble (six legs) over a word: not deliberate, it stays ink and the word stays whole.
{
  await write(300, 400);
  const k0 = (await dbg()).strokes;
  const short = traces.find((t) => t.name === "short scribble (6 legs)");
  await pen(place(short.pts, 330, 406));
  await settle(300);
  const k1 = await dbg();
  check(k1.strokes === k0 + 1 && k1.dimmed === 0, "a short scribble over a word stays ink, and the word is untouched", `${k0} → ${k1.strokes} strokes, ${k1.dimmed} dimmed`);
}
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

// ================================================================ 4. handwriting, small letters, fast strokes
{
  const inkT = await page.evaluate(async () => (await import("/board/src/inkTraces.ts")).inkTraces(1));
  for (const k of [1, 2]) {
    await openBoard();
    await camTo(0, 0, k);
    await setTool("pen", { pen: 2.4, penColor: "#1f1f24" });
    let x = 60, y = 200, row = 0;
    let jumps = 0;
    const lift = [];
    for (const t of inkT) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of t.pts) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
      const fit = Math.min(1, 300 / (x1 - x0 + 1), 220 / (y1 - y0 + 1));
      if (x + (x1 - x0) * fit > 1150) (x = 60), (y += 240), row++;
      const pts = t.pts.map((p) => ({ x: Math.round((p.x - x0) * fit + x), y: Math.round((p.y - y0) * fit + y), t: p.t }));
      await pen(pts, true);
      // The screen just before the lift (the live layer) and just after (the tiles), over the stroke: the same pixels.
      const clip = { x: x - 6, y: y - 6, width: Math.ceil((x1 - x0) * fit) + 12, height: Math.ceil((y1 - y0) * fit) + 12 };
      await page.waitForTimeout(150); // the last move drawn (the next frame)
      const a = await pixels(clip);
      await page.evaluate(() => window.__penUp());
      await page.waitForTimeout(250);
      const b = await pixels(clip);
      let diff = 0, nd = 0;
      for (let i = 0; i < a.d.length; i += 4) {
        const da = Math.abs(lum([a.d[i], a.d[i + 1], a.d[i + 2]]) - lum([b.d[i], b.d[i + 1], b.d[i + 2]]));
        if (da > 40) nd++;
        diff = Math.max(diff, da);
      }
      jumps = Math.max(jumps, nd);
      lift.push(`${t.name}: ${nd} px`);
      x += (x1 - x0) * fit + 50;
    }
    await settle(400);
    report[`lift ${k}×`] = lift;
    check(jumps <= 6, `at ${k}×, nothing moves when the Pencil lifts (the stroke drawn while writing is the one left)`, `at most ${jumps} device px changed by more than 40/255 (${inkT.length} strokes)`);
    await shot(`handwriting-${k}x`, { x: 0, y: 150, width: 1194, height: 680 });
  }
}

console.log(JSON.stringify(report, null, 1));
console.log(`screenshots: ${OUT}`);
await browser.close();
console.log(failed() ? `${failed()} check(s) failed` : "all checks passed");
process.exit(failed() ? 1 : 0);
