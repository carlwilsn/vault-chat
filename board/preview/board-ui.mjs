// The board's paper and tools, in WebKit as Carl's iPad (Mac UA, touch; board/preview/ipad.mjs):
//   - a new board starts blank (no writing on it) with the grid;
//   - the grid is drawn every frame of a pinch (sampled mid-pinch), visible but never a solid fill, at 0.5×, 1×, 2×
//     (screenshots in light and dark: SHOTS dir);
//   - the colour slots: one tap switches colour (finger, Pencil, mouse), the active slot is marked, the active slot
//     tapped again or a long-press opens the palette that sets it, slots are remembered per tool across a reload;
//   - dashed and dotted pen lines: chosen in the pen's popover, stored as style in board.json (round trip through the
//     box), drawn as dashes, kept by the precise eraser and by a move;
//   - the selection pill: centred above at a fixed gap, flipped below, clamped in view and clear of the controls,
//     never on a handle — near every edge, at several zooms, during a drag, with ink and items mixed.
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/board-ui.mjs [board url] [shots dir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ipadPage, checker, touchScript } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const SHOTS = process.argv[3] ?? join(tmpdir(), "vc-board-ui");
mkdirSync(SHOTS, { recursive: true });
const { check, failed } = checker();
const { browser, ctx, page } = await ipadPage();
page.on("pageerror", (e) => check(false, "no page error", `${e.message} ${String(e.stack ?? "").split("\n").slice(0, 4).join(" | ")}`));
await page.route("**/api/v1/board/log", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' }));
await page.addInitScript(touchScript());

const newBoard = async (name) => {
  await page.goto(url);
  const slug = await page.evaluate(async (n) => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) })).json()).slug, name);
  await openBoard(slug);
  return slug;
};
const openBoard = async (slug) => {
  // Saved first: a save cut off by the navigation is a fetch WebKit reports as a page error.
  await page.evaluate(() => window.__board?.flush?.()).catch(() => {});
  await page.goto("about:blank");
  await page.goto(`${url}#/b/${slug}`);
  await page.waitForFunction(() => !!window.__board?.debug);
  await page.waitForTimeout(300);
};
const dbg = () => page.evaluate(() => window.__board.debug());
const pen = (from, to, ms = 200, steps = 10) => page.evaluate(([a, b, m, s]) => window.__pen(a, b, m, s), [from, to, ms, steps]);
const gesture = (paths, ms, stagger = 20, steps = 12) => page.evaluate(([p, m, s, n]) => window.__gesture(p, m, s, n), [paths, ms, stagger, steps]);
const center = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};
const tapFinger = async (sel) => {
  const [x, y] = await center(sel);
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(120);
};
/** A long touch on an element: down, held `ms`, up (PointerEvents as iPadOS sends them). */
const holdFinger = async (sel, ms = 650) => {
  const [x, y] = await center(sel);
  await page.evaluate(([x, y, ms]) => window.__gesture([{ id: 7, from: [x, y], to: [x, y], size: 41.75 }], ms, 0, 4), [x, y, ms]);
  await page.waitForTimeout(120);
};
const tapPen = async (sel) => {
  const [x, y] = await center(sel);
  await pen([x, y], [x, y], 40, 1);
  await page.waitForTimeout(120);
};
const tapMouse = async (sel) => {
  const [x, y] = await center(sel);
  await page.mouse.click(x, y);
  await page.waitForTimeout(120);
};

// ------------------------------------------------------------------ a new board: blank, the grid
const slug = await newBoard(`UI ${Date.now() % 100000}`);
await pen([200, 300], [260, 310]); // the Pencil is seen: from now on fingers navigate
await page.evaluate(() => window.__board.undo());
const text = await page.evaluate(() => document.querySelector(".board").innerText);
check(!/Write anywhere|Two fingers|two-finger/i.test(text), "a new board has no writing on it", JSON.stringify(text.slice(0, 80)));
check((await dbg()).grid === "grid", "a new board has the grid");
check((await dbg()).prefs.pan1 === undefined && !(await page.locator('[data-pan1]').count()), "no one-finger scroll setting");
await tapFinger('[data-pop="menu"]');
const menu = await page.evaluate(() => document.querySelector(".pop").innerText);
check(/Background/.test(menu) && /Grid/.test(menu) && !/One-finger/.test(menu), "the ⋯ menu keeps the background choice, without one-finger scroll", menu.replace(/\s+/g, " ").slice(0, 120));
await tapFinger('[data-pop="menu"]');

// ------------------------------------------------------------------ the grid, live
/** Grid pixels in a band of the base canvas with nothing else in it: the fraction that are grid-coloured. */
const gridShare = () =>
  page.evaluate(() => {
    const c = document.querySelector("canvas.base"), g = c.getContext("2d");
    const y0 = Math.round(c.height * 0.55), h = Math.round(c.height * 0.3);
    const d = g.getImageData(0, y0, c.width, h).data;
    let on = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 20) on++;
    return on / (d.length / 4);
  });
const setZoom = (k) =>
  page.evaluate((k) => {
    const v = window.__board;
    v.cam = { x: -200, y: -200, z: v.homeZ * k };
    v.drawS = v.screenScale();
    v.renderBase();
  }, k);
for (const scheme of ["light", "dark"]) {
  await page.emulateMedia({ colorScheme: scheme });
  for (const k of [0.5, 1, 2]) {
    await setZoom(k);
    await page.waitForTimeout(200);
    const share = await gridShare();
    check(share > 0.015 && share < 0.25, `grid at ${k}× (${scheme}): visible, not a fill`, `${(share * 100).toFixed(1)}% of the band`);
    await page.screenshot({ path: join(SHOTS, `grid-${scheme}-${k}x.png`) });
  }
}
await page.emulateMedia({ colorScheme: "light" });
// Mid-pinch, zooming out: every sampled frame has the grid at the zoom of that frame.
await setZoom(1.5);
await page.waitForTimeout(150);
const pinch = gesture(
  [
    { id: 11, from: [390, 400], to: [560, 400], size: 41.75 },
    { id: 12, from: [790, 400], to: [620, 400], size: 41.75 },
  ],
  1600,
  10,
  40,
);
const frames = [];
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(200);
  frames.push({ z: (await dbg()).cam.z, share: await gridShare() });
}
await pinch;
const zs = frames.map((f) => f.z);
check(zs[zs.length - 1] < zs[0] - 0.05, "the pinch zooms out while it is sampled", zs.map((z) => z.toFixed(2)).join(" → "));
check(frames.every((f) => f.share > 0.015 && f.share < 0.25), "the grid is drawn in every sampled frame mid-pinch, never a fill", frames.map((f) => `${(f.share * 100).toFixed(1)}%`).join(" "));
await page.screenshot({ path: join(SHOTS, "grid-after-pinch.png") });

// ------------------------------------------------------------------ colour slots
await setZoom(1);
const prefs = async () => (await dbg()).prefs;
check((await page.locator(".tb .slot").count()) === 5, "five colour slots in the toolbar");
await tapFinger('.tb [data-mode="pen"]');
await tapFinger('.tb .slot[data-slot="2"]');
let p = await prefs();
check(p.penSlot === 2 && p.penColor === p.penSlots[2], "a finger tap on a slot switches the pen's colour", `${p.penSlot} ${p.penColor}`);
check((await page.locator('.tb .slot[aria-pressed="true"]').getAttribute("data-slot")) === "2", "the active slot is marked");
await pen([300, 500], [500, 520]);
check((await page.evaluate(() => window.__board.board.strokes.at(-1).color)) === p.penSlots[2], "the pen writes in the slot's colour");
await tapPen('.tb .slot[data-slot="1"]');
check((await prefs()).penSlot === 1, "a Pencil tap on a slot switches too");
await tapMouse('.tb .slot[data-slot="3"]');
check((await prefs()).penSlot === 3, "a mouse click on a slot switches too");
// The active slot tapped again: its palette; a colour from it sets the slot.
await tapFinger('.tb .slot[data-slot="3"]');
const palette = await page.locator(".pop [data-color]").count();
check(palette >= 16, "tapping the active slot opens the palette", `${palette} colours`);
const pick = await page.locator(".pop [data-color]").nth(13).getAttribute("data-color");
await tapFinger(`.pop [data-color="${pick}"]`);
p = await prefs();
check(p.penSlots[3] === pick && p.penColor === pick && (await page.locator(".pop").isHidden()), "a palette colour sets that slot and closes the palette", `${p.penSlots[3]} vs ${pick}`);
// A long-press on another slot: its palette (and the lift does not close it).
await holdFinger('.tb .slot[data-slot="0"]');
check(await page.locator(".pop [data-color]").first().isVisible(), "a long-press on a slot opens its palette");
check((await prefs()).penSlot === 0, "…for that slot");
await tapFinger('.tb [data-act="undo"]');
// The highlighter has its own slots.
await tapFinger('.tb [data-mode="hl"]');
await tapFinger('.tb .slot[data-slot="4"]');
p = await prefs();
check(p.hlSlot === 4 && p.hlColor === p.hlSlots[4] && p.penSlots[3] === pick, "the highlighter's slots are its own", `${p.hlSlot} ${p.hlColor}`);
const swatch = await page.evaluate(() => getComputedStyle(document.querySelector('.tb .slot[data-slot="4"] i')).backgroundColor);
check(!/31, 31, 36/.test(swatch), "the strip shows the highlighter's colours while it is the tool", swatch);
await openBoard(slug);
p = await prefs();
check(p.hlSlot === 4 && p.penSlots[3] === pick && p.penSlot === 0, "slots are remembered per tool across a reload");
await page.screenshot({ path: join(SHOTS, "slots.png"), clip: { x: 300, y: 0, width: 640, height: 90 } });

// ------------------------------------------------------------------ dashed and dotted lines
await tapFinger('.tb [data-mode="pen"]');
await tapFinger(".tb .sz");
check((await page.locator('.pop [data-line]').count()) === 3, "the pen's popover offers solid, dashed and dotted");
await tapFinger('.pop [data-line="dash"]');
check((await prefs()).penStyle === "dash", "dashed chosen (and remembered in the prefs)");
await tapFinger(".tb .sz");
await setZoom(1);
await pen([200, 300], [900, 300], 400, 30);
await page.waitForTimeout(150);
const last = await page.evaluate(() => window.__board.board.strokes.at(-1));
check(last.style === "dash", "the stroke stores style: dash");
/** Ink/no-ink transitions along the stroke's line on the base canvas. */
const runs = () =>
  page.evaluate(() => {
    const v = window.__board, c = document.querySelector("canvas.base"), g = c.getContext("2d");
    const s = v.board.strokes.at(-1);
    const d = v.dpr, y = Math.round((s.xy[1] - v.cam.y) * v.cam.z * d);
    const x0 = Math.max(0, Math.round((s.xy[0] - v.cam.x) * v.cam.z * d) + 30), x1 = Math.min(c.width, Math.round((s.xy.at(-2) - v.cam.x) * v.cam.z * d) - 30);
    const row = g.getImageData(x0, y, x1 - x0, 1).data;
    let flips = 0, prev = null;
    for (let i = 0; i < row.length; i += 4) {
      const ink = row[i + 3] > 100 && row[i] + row[i + 1] + row[i + 2] < 400;
      if (prev !== null && ink !== prev) flips++;
      prev = ink;
    }
    return flips;
  });
check((await runs()) >= 8, "it is drawn dashed", `${await runs()} ink/gap changes along it`);
// Zoomed in (about the stroke): the dashes scale with the canvas (longer on screen, never a solid line).
await page.evaluate(() => {
  const v = window.__board, s = v.board.strokes.at(-1);
  const z = v.homeZ * 2, cx = (s.xy[0] + s.xy.at(-2)) / 2, cy = s.xy[1];
  v.cam = { z, x: cx - 150 / z - (s.xy.at(-2) - s.xy[0]) / 4, y: cy - 400 / z };
  v.drawS = v.screenScale();
  v.renderBase();
});
await page.waitForTimeout(150);
let zr = 0;
for (let i = 0; i < 20 && zr < 4; i++) {
  await page.waitForTimeout(100);
  zr = await runs();
}
check(zr >= 4, "zoomed in it is still dashed", `${zr} changes`);
await setZoom(1);
// Saved to the box with its style: board.json round-trips it.
await page.evaluate(() => window.__board.flush());
const saved = await page.evaluate(async (s) => (await (await fetch(`/api/v1/boards/${s}`)).json()), slug);
const savedStroke = (saved.board ?? saved).strokes.find((x) => x.id === last.id);
check(savedStroke?.style === "dash", "board.json on the box keeps style: dash", JSON.stringify(savedStroke && { style: savedStroke.style }));
await openBoard(slug);
check((await page.evaluate((id) => window.__board.board.strokes.find((x) => x.id === id)?.style, last.id)) === "dash", "…and it reads back dashed after a reload");
// The precise eraser cuts it in two: both pieces stay dashed.
await page.evaluate(() => {
  const v = window.__board;
  v.prefs.eraser = "cut";
});
await tapFinger('.tb [data-mode="eraser"]');
await pen([550, 270], [550, 330], 150, 8);
const pieces = await page.evaluate((id) => {
  const all = window.__board.board.strokes;
  return { gone: !all.some((s) => s.id === id), dashed: all.filter((s) => s.style === "dash").length };
}, last.id);
check(pieces.gone && pieces.dashed >= 2, "the precise eraser cuts it, and its pieces stay dashed", JSON.stringify(pieces));
// Dotted, and a move keeps it.
await tapFinger('.tb [data-mode="pen"]');
await tapFinger(".tb .sz");
await tapFinger('.pop [data-line="dot"]');
await tapFinger(".tb .sz");
await pen([200, 600], [700, 600], 300, 20);
check((await page.evaluate(() => window.__board.board.strokes.at(-1).style)) === "dot", "a dotted stroke stores style: dot");
await tapFinger('.tb [data-mode="lasso"]');
await pen([450, 600], [451, 600], 60, 2); // tap the dotted line
await pen([450, 600], [450, 700], 250, 10); // drag it down
check((await page.evaluate(() => window.__board.board.strokes.at(-1).style)) === "dot", "a moved stroke stays dotted");
const shot = await page.evaluate(async () => !!(await window.__board.snapshotView()));
check(shot, "the snapshot draws the board with its styled lines");
await page.screenshot({ path: join(SHOTS, "dashes.png") });
await tapFinger('.tb [data-mode="pen"]');
await tapFinger(".tb .sz");
await tapFinger('.pop [data-line="solid"]');
await tapFinger(".tb .sz");

// ------------------------------------------------------------------ the selection pill
const s2 = await newBoard(`Pill ${Date.now() % 100000}`);
await pen([200, 300], [260, 310]);
await page.evaluate(() => window.__board.undo());
// An image item (from the inbox) and ink beside it.
const entries = await page.evaluate(async () => (await (await fetch("/api/v1/inbox")).json()).entries);
const img = entries.find((e) => e.parts?.[0]?.kind === "image");
await page.evaluate((id) => window.__board.addFromInbox(id, 0), img.id);
await page.waitForTimeout(300);
const geo = () =>
  page.evaluate(async () => {
    // Read just after a frame draws (the pill is placed with the frame).
    await new Promise((r) => requestAnimationFrame(() => r()));
    const v = window.__board, bar = document.querySelector(".selbar");
    const b = v.selBox();
    if (!b) return null;
    const xf = v.g?.k === "xf" ? v.g.xf : { s: 1, ox: 0, oy: 0 };
    const q = { x0: b.x0 * xf.s + xf.ox, y0: b.y0 * xf.s + xf.oy, x1: b.x1 * xf.s + xf.ox, y1: b.y1 * xf.s + xf.oy };
    const a = v.toScreen(q.x0, q.y0), c = v.toScreen(q.x1, q.y1);
    const r = bar.getBoundingClientRect(), st = document.querySelector(".stage").getBoundingClientRect();
    const ctl = [...document.querySelectorAll(".board > .material")].map((e) => e.getBoundingClientRect()).map((e) => ({ x0: e.left - st.left, y0: e.top - st.top, x1: e.right - st.left, y1: e.bottom - st.top }));
    const at = (bar.dataset.at ?? "").split(",").map(Number);
    return { hidden: bar.hidden, now: { x0: a.x, y0: a.y, x1: c.x, y1: c.y }, sel: at.length === 4 ? { x0: at[0], y0: at[1], x1: at[2], y1: at[3] } : { x0: a.x, y0: a.y, x1: c.x, y1: c.y }, pill: { x0: r.left - st.left, y0: r.top - st.top, x1: r.right - st.left, y1: r.bottom - st.top }, W: st.width, H: st.height, ctl, side: bar.dataset.side };
  });
const pillOk = (g, what) => {
  if (!g || g.hidden) return check(false, what, "no pill");
  const { sel, pill, W, H } = g;
  const meets = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const inView = pill.x0 >= 0 && pill.y0 >= 76 - 0.5 && pill.x1 <= W && pill.y1 <= H;
  const clearCtl = !g.ctl.some((c) => meets(c, pill));
  const handles = [[sel.x0, sel.y0], [sel.x1, sel.y0], [sel.x0, sel.y1], [sel.x1, sel.y1]];
  const clearHandles = handles.every(([hx, hy]) => {
    const nx = Math.max(pill.x0, Math.min(hx, pill.x1)), ny = Math.max(pill.y0, Math.min(hy, pill.y1));
    return Math.hypot(hx - nx, hy - ny) > 9;
  });
  const visCx = (Math.max(sel.x0, 0) + Math.min(sel.x1, W)) / 2, pillCx = (pill.x0 + pill.x1) / 2;
  const clampedX = pill.x0 <= 10.5 || pill.x1 >= W - 10.5;
  const centred = clampedX || Math.abs(visCx - pillCx) < 1.5;
  // The box the pill was placed by is the selection as drawn (the frame it was drawn in: at most a frame behind).
  const lag = Math.max(Math.abs(sel.x0 - g.now.x0), Math.abs(sel.y0 - g.now.y0), Math.abs(sel.x1 - g.now.x1), Math.abs(sel.y1 - g.now.y1));
  if (lag > 40) return check(false, what, `the pill's box is ${Math.round(lag)} px behind the selection`);
  const gapOk = g.side === "above" ? Math.abs(sel.y0 - pill.y1 - 18) < 1.5 : g.side === "below" ? Math.abs(pill.y0 - sel.y1 - 18) < 1.5 : true;
  return check(inView && clearCtl && clearHandles && centred && gapOk, what, `${g.side}; pill ${[pill.x0, pill.y0, pill.x1, pill.y1].map(Math.round)} sel ${[sel.x0, sel.y0, sel.x1, sel.y1].map(Math.round)}${inView ? "" : " OUT OF VIEW"}${clearCtl ? "" : " ON THE CONTROLS"}${clearHandles ? "" : " ON A HANDLE"}${centred ? "" : " NOT CENTRED"}${gapOk ? "" : " GAP"}`);
};
const it0 = (await dbg()).itemsList[0];
/** Put the selection's (canvas) box at screen spot (sx, sy) for its centre, at zoom k × home. */
const aim = (k, sx, sy) =>
  page.evaluate(([k, sx, sy, it]) => {
    const v = window.__board;
    const z = v.homeZ * k;
    v.cam = { z, x: it.x + it.w / 2 - sx / z, y: it.y + it.h / 2 - sy / z };
    v.camMoved();
  }, [k, sx, sy, it0]);
check((await dbg()).selection?.items === 1, "the added image is selected");
for (const k of [0.5, 1, 2]) {
  for (const [name, sx, sy] of [["centre", 590, 450], ["top edge", 590, 120], ["bottom edge", 590, 780], ["left edge", 20, 450], ["right edge", 1160, 450], ["top-left", 30, 100], ["bottom-right", 1150, 800]]) {
    await aim(k, sx, sy);
    await page.waitForTimeout(90);
    const g = await geo();
    if (!g || g.hidden) {
      // Out of view entirely is the only time there is no pill.
      const out = g && (g.sel.x1 < 0 || g.sel.y1 < 76 || g.sel.x0 > g.W || g.sel.y0 > g.H);
      check(!!out, `pill at ${k}×, selection near the ${name}`, "hidden while the selection is in view");
      continue;
    }
    pillOk(g, `pill at ${k}×, selection near the ${name}`);
  }
}
await page.screenshot({ path: join(SHOTS, "pill-edge.png") });
// While it is dragged: the pill rides with it.
await aim(1, 590, 450);
await page.waitForTimeout(100);
const g0 = await geo();
const cx = (g0.sel.x0 + g0.sel.x1) / 2, cy = (g0.sel.y0 + g0.sel.y1) / 2;
const drag = pen([cx, cy], [cx + 200, cy - 250], 900, 30);
let rode = 0;
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(170);
  const g = await geo();
  if (g && !g.hidden && (await page.evaluate(() => window.__board.g?.k === "xf"))) {
    pillOk(g, `pill attached mid-drag (${i + 1})`);
    rode++;
  }
}
await drag;
check(rode >= 2, "the pill was there through the drag", `${rode} samples mid-drag`);
pillOk(await geo(), "pill after the drag");
// Ink and the item, selected together.
await aim(0.5, 420, 450);
const g1 = await geo();
await tapFinger('.tb [data-mode="pen"]');
await pen([g1.sel.x1 + 30, g1.sel.y0 + 20], [g1.sel.x1 + 160, g1.sel.y1 - 20], 200, 10);
await tapFinger('.tb [data-mode="lasso"]');
const box = { x0: g1.sel.x0 - 20, y0: g1.sel.y0 - 20, x1: g1.sel.x1 + 190, y1: g1.sel.y1 + 20 };
// One continuous Pencil loop round both.
await page.evaluate(async (b) => {
  const st = document.querySelector(".stage");
  const fire = (t, x, y) => st.dispatchEvent(new PointerEvent(t, { pointerId: 950, pointerType: "pen", bubbles: true, cancelable: true, clientX: x, clientY: y, pressure: t === "pointerup" ? 0 : 0.5, buttons: t === "pointerup" ? 0 : 1 }));
  const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1], [b.x0, b.y0 + 2]];
  fire("pointerdown", ...pts[0]);
  for (let i = 1; i < pts.length; i++)
    for (let s = 1; s <= 8; s++) {
      await new Promise((r) => setTimeout(r, 12));
      fire("pointermove", pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * s) / 8, pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * s) / 8);
    }
  fire("pointerup", ...pts.at(-1));
}, box);
await page.waitForTimeout(150);
const mixed = (await dbg()).selection;
check(mixed?.items === 1 && mixed?.strokes >= 1, "ink and the image selected together", JSON.stringify(mixed));
for (const [k, sx, sy] of [[1, 590, 450], [0.5, 590, 110], [2, 590, 450]]) {
  await aim(k, sx, sy);
  await page.waitForTimeout(90);
  pillOk(await geo(), `pill for ink + item at ${k}×`);
}
await page.screenshot({ path: join(SHOTS, "pill-mixed.png") });
void s2;

await browser.close();
console.log(`\nshots: ${SHOTS}`);
console.log(failed() ? `${failed()} check(s) failed` : "all checks passed");
process.exit(failed() ? 1 : 0);
