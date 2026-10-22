// The board's clipboard in WebKit as Carl's iPad (board/preview/ipad.mjs): Cut, Copy and Delete on the selection pill
// (Fluent icons, short labels), and Paste from a long-press on empty canvas with the select tool.
//   1. copy/paste within a board: ink (a dashed red stroke and a blue one) copied with the Pencil's tap, pasted from a
//      Pencil long-press (the pill at the press, the paste centred there, same layout and style, selected); one undo
//      step takes it back; again from a finger's long-press, pasted with the mouse;
//   2. a long-press never offers Paste where it should not: on ink (it selects that stroke instead), from a palm, with
//      the pen tool (it writes), or once the press has moved (a lasso);
//   3. cut/paste across boards: an image and its ink cut from one board (one undo step: undo brings both back, redo
//      cuts again), pasted on another board from a finger's long-press: the image's file is copied into that board's
//      assets, the board saves, and after a reload the paste is still there; undo takes the paste back.
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/clipboard.mjs [board url] [shots dir]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ipadPage, checker, touchScript } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const SHOTS = process.argv[3] ?? join(tmpdir(), "vc-board-clipboard");
mkdirSync(SHOTS, { recursive: true });
const { check, failed } = checker();
const { browser, page } = await ipadPage();
page.on("pageerror", (e) => check(false, "no page error", e.message));
await page.route("**/api/v1/board/log", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' }));
await page.addInitScript(touchScript());
// The Pencil along a path or held in place (pointer id 901), dispatched like the real thing.
await page.addInitScript(() => {
  let down = null;
  const fire = (type, x, y, buttons) => {
    const target = type === "pointerdown" ? (document.elementFromPoint(x, y) ?? document.body) : down;
    if (type === "pointerdown") down = target;
    target.dispatchEvent(new PointerEvent(type, { pointerId: 901, pointerType: "pen", isPrimary: true, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, width: 1, height: 1, pressure: buttons ? 0.5 : 0, buttons, button: type === "pointermove" ? -1 : 0 }));
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__penPoly = async (pts, stepMs = 12) => {
    fire("pointerdown", pts[0][0], pts[0][1], 1);
    for (const [x, y] of pts.slice(1)) {
      await sleep(stepMs);
      fire("pointermove", x, y, 1);
    }
    const l = pts[pts.length - 1];
    fire("pointerup", l[0], l[1], 0);
  };
  window.__penHold = async (x, y, ms) => {
    fire("pointerdown", x, y, 1);
    for (let t = 0; t < ms; t += 50) {
      await sleep(50);
      fire("pointermove", x + (t % 100 ? 0.5 : 0), y, 1);
    }
    fire("pointerup", x, y, 0);
  };
});

const dbg = () => page.evaluate(() => window.__board.debug());
const settle = (ms = 250) => page.waitForTimeout(ms);
const center = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  return [b.x + b.width / 2, b.y + b.height / 2];
};
const tapFinger = async (sel) => {
  const [x, y] = await center(sel);
  await page.touchscreen.tap(x, y);
  await settle(150);
};
const tapPen = async (sel) => {
  const [x, y] = await center(sel);
  await page.evaluate(([x, y]) => window.__penPoly([[x, y], [x, y]], 30), [x, y]);
  await settle(150);
};
const tapMouse = async (sel) => {
  const [x, y] = await center(sel);
  await page.mouse.click(x, y);
  await settle(150);
};
const penLine = (pts) => page.evaluate((p) => window.__penPoly(p), pts);
const penHold = (x, y, ms = 700) => page.evaluate(([x, y, ms]) => window.__penHold(x, y, ms), [x, y, ms]);
const fingerHold = (x, y, ms = 700, size = 41.75) => page.evaluate(([x, y, ms, size]) => window.__gesture([{ id: 31, from: [x, y], to: [x, y], size }], ms, 0, 6), [x, y, ms, size]);
/** A lasso drawn with the Pencil around a screen rect. */
const lasso = (x0, y0, x1, y1) => {
  const pts = [];
  for (let i = 0; i <= 12; i++) pts.push([x0 + ((x1 - x0) * i) / 12, y0]);
  for (let i = 0; i <= 12; i++) pts.push([x1, y0 + ((y1 - y0) * i) / 12]);
  for (let i = 0; i <= 12; i++) pts.push([x1 - ((x1 - x0) * i) / 12, y1]);
  for (let i = 0; i <= 12; i++) pts.push([x0, y1 - ((y1 - y0) * i) / 12]);
  return penLine(pts);
};
const setMode = (m) => tapFinger(m === "eraser" ? '[data-mode="eraser"]' : `.tb [data-mode="${m}"]`);
const pasteBar = () =>
  page.evaluate(() => {
    const b = document.querySelector(".pastebar");
    const r = b.getBoundingClientRect();
    return { shown: !b.hidden, at: b.dataset.at, x: r.x + r.width / 2, bottom: r.bottom, top: r.top, label: b.innerText.trim(), icon: !!b.querySelector("svg") };
  });
const toWorld = (x, y) => page.evaluate(([x, y]) => { const c = window.__board.debug().cam; const r = document.querySelector(".stage").getBoundingClientRect(); return { x: c.x + (x - r.left) / c.z, y: c.y + (y - r.top) / c.z }; }, [x, y]);
const strokesNow = () => page.evaluate(() => window.__board.board.strokes.map((s) => ({ id: s.id, color: s.color, w: s.w, style: s.style, xy: s.xy })));
const boxOf = (ss) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of ss) for (let i = 0; i < s.xy.length; i += 2) (x0 = Math.min(x0, s.xy[i])), (y0 = Math.min(y0, s.xy[i + 1])), (x1 = Math.max(x1, s.xy[i])), (y1 = Math.max(y1, s.xy[i + 1]));
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
};
const newBoard = async (name) => {
  await page.evaluate(() => window.__board?.flush?.()).catch(() => {});
  await page.goto(url);
  const slug = await page.evaluate(async (n) => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) })).json()).slug, name);
  await openBoard(slug);
  return slug;
};
const openBoard = async (slug) => {
  await page.evaluate(() => window.__board?.flush?.()).catch(() => {});
  await page.goto("about:blank");
  await page.goto(`${url}#/b/${slug}`);
  await page.waitForFunction(() => !!window.__board?.debug);
  await settle(400);
};

// ------------------------------------------------------------------ 1. copy and paste within a board
await page.goto(url);
await page.evaluate(() => localStorage.clear());
const a = await newBoard(`Clip A ${Date.now() % 100000}`);
await page.evaluate(() => {
  const v = window.__board;
  Object.assign(v.prefs, { penColor: "#ff3b30", penStyle: "dash" });
});
await setMode("pen");
await page.evaluate(() => Object.assign(window.__board.prefs, { penColor: "#ff3b30", penStyle: "dash" }));
await penLine([[300, 300], [340, 320], [380, 300], [420, 330]]);
await page.evaluate(() => Object.assign(window.__board.prefs, { penColor: "#0a84ff", penStyle: "solid" }));
await penLine([[300, 360], [360, 400], [420, 360]]);
await settle();
const orig = await strokesNow();
check(orig.length === 2 && orig[0].style === "dash" && orig[0].color === "#ff3b30", "two strokes written (a dashed red one, a blue one)", JSON.stringify(orig.map((s) => [s.color, s.style])));

await setMode("lasso");
await lasso(270, 270, 450, 430);
await settle();
check((await dbg()).selection?.strokes === 2, "lassoed both", JSON.stringify((await dbg()).selection));
const pill = await page.evaluate(() => [...document.querySelectorAll(".selbar button")].map((b) => ({ act: b.dataset.act, label: b.innerText.trim(), icon: !!b.querySelector("svg.ph") })));
check(JSON.stringify(pill.map((b) => b.act)) === JSON.stringify(["cut", "copy", "delete"]) && pill.every((b) => b.icon && b.label), "the pill: Cut, Copy, Delete, each a Fluent icon with a short label", JSON.stringify(pill));
await page.screenshot({ path: join(SHOTS, "pill.png") });

await tapPen('.selbar [data-act="copy"]');
const clip = await page.evaluate(() => JSON.parse(localStorage.getItem("vc_board_clip") ?? "null"));
check(clip?.strokes?.length === 2 && clip.from === a, "Copy (the Pencil's tap) puts both strokes on the board clipboard", JSON.stringify({ n: clip?.strokes?.length, from: clip?.from }));
check((await dbg()).selection?.strokes === 2 && (await dbg()).strokes === 2, "…and changes nothing on the board (still selected)");

// A Pencil long-press on empty canvas: Paste at that spot.
const undo0 = (await dbg()).undo;
await penHold(700, 520);
await settle();
let pb = await pasteBar();
check(pb.shown && pb.label === "Paste" && pb.icon && pb.at === "700,520" && Math.abs(pb.x - 700) < 2 && pb.bottom < 520, "a Pencil long-press on empty canvas shows Paste, centred above the press", JSON.stringify(pb));
check((await dbg()).selection === null && (await dbg()).strokes === 2, "…the long-press drew no lasso, selected nothing, added nothing");
await page.screenshot({ path: join(SHOTS, "paste-pill.png") });
await tapPen('.pastebar [data-act="paste"]');
await settle();
let now = await strokesNow();
const pasted = now.slice(2);
const want = await toWorld(700, 520);
const pb1 = boxOf(pasted), ob = boxOf(orig);
check(now.length === 4 && Math.abs(pb1.cx - want.x) < 1 && Math.abs(pb1.cy - want.y) < 1, "Paste puts the copy centred on the press", JSON.stringify({ c: [pb1.cx, pb1.cy], want }));
check(Math.abs(pb1.x1 - pb1.x0 - (ob.x1 - ob.x0)) < 0.1 && Math.abs(pb1.y1 - pb1.y0 - (ob.y1 - ob.y0)) < 0.1 && pasted[0].style === "dash" && pasted[0].color === "#ff3b30" && pasted[1].color === "#0a84ff" && pasted[0].w === orig[0].w, "…same layout and style (dashed red, blue, the same widths)");
check(pasted.every((s) => !orig.some((o) => o.id === s.id)), "…new strokes (new ids)");
check((await dbg()).selection?.strokes === 2 && !(await pasteBar()).shown, "…selected, and the Paste pill is gone");
check((await dbg()).undo === undo0 + 1, "…one undo step", `${undo0} → ${(await dbg()).undo}`);
await page.screenshot({ path: join(SHOTS, "pasted.png") });
await tapFinger('[data-act="undo"]');
check((await dbg()).strokes === 2 && (await dbg()).undo === undo0, "undo takes the paste back (one step)", JSON.stringify({ strokes: (await dbg()).strokes, undo: (await dbg()).undo }));

// A finger's long-press, pasted with the mouse.
const camF = JSON.stringify((await dbg()).cam);
await fingerHold(600, 650);
await settle();
pb = await pasteBar();
check(pb.shown && pb.at === "600,650", "a finger's long-press on empty canvas shows Paste there", JSON.stringify(pb));
check(JSON.stringify((await dbg()).cam) === camF && (await dbg()).strokes === 2, "…and it did not pan or write");
await tapMouse('.pastebar [data-act="paste"]');
await settle();
now = await strokesNow();
const w2 = await toWorld(600, 650), b2 = boxOf(now.slice(2));
check(now.length === 4 && Math.abs(b2.cx - w2.x) < 1 && Math.abs(b2.cy - w2.y) < 1, "the mouse pastes it centred on that press", JSON.stringify({ c: [b2.cx, b2.cy], w2 }));
await tapFinger('[data-act="undo"]');
check((await dbg()).strokes === 2, "undo takes it back");

// ------------------------------------------------------------------ 2. never Paste where it should not
await fingerHold(310, 300); // on the red stroke's start
await settle();
check(!(await pasteBar()).shown && (await dbg()).selection?.strokes === 1, "a finger's long-press on ink selects that stroke (no Paste)", JSON.stringify({ pb: await pasteBar(), sel: (await dbg()).selection }));
await penHold(360, 400); // the Pencil on the blue stroke
await settle();
check(!(await pasteBar()).shown && (await dbg()).selection?.strokes === 1, "a Pencil long-press on ink selects that stroke (no Paste)");
const cam0 = JSON.stringify((await dbg()).cam);
await fingerHold(800, 300, 700, 104);
await settle();
check(!(await pasteBar()).shown && JSON.stringify((await dbg()).cam) === cam0, "a palm resting on empty canvas: no Paste, nothing moves");
await penLine([[820, 600], [822, 600], [900, 640], [960, 600]].concat(Array.from({ length: 30 }, (_, i) => [960 - i * 4, 600 + (i % 2)])));
await settle();
check(!(await pasteBar()).shown, "a press that moved is a lasso: no Paste");
await setMode("pen");
const n0 = (await dbg()).strokes;
await penHold(700, 520);
await settle();
check(!(await pasteBar()).shown && (await dbg()).strokes === n0 + 1, "with the pen, a long-press writes (a dot), never Paste", `${n0} → ${(await dbg()).strokes}`);
await tapFinger('[data-act="undo"]');

// ------------------------------------------------------------------ 3. cut on one board, paste on another
// An image item on board A (its file in A's assets), with ink across it.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAGklEQVR4nGP4z8DwnwEJMOHkMTAw/GdgYAAAOwMCAuHU4m0AAAAASUVORK5CYII=";
const src = await page.evaluate(async ([slug, data]) => (await (await fetch(`/api/v1/boards/${slug}/assets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) })).json()).src, [a, PNG]);
await page.evaluate(() => window.__board.flush());
await page.evaluate(async ([slug, src]) => {
  const b = await (await fetch(`/api/v1/boards/${slug}`)).json();
  b.items.push({ id: "img1", kind: "image", x: 600, y: 200, w: 160, h: 120, src });
  const r = await fetch(`/api/v1/boards/${slug}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: b, base: b.rev }) });
  if (!r.ok) throw new Error(`save ${r.status}`);
}, [a, src]);
await openBoard(a);
await setMode("lasso");
const it = (await dbg()).itemsList[0];
const s0 = await page.evaluate(([x, y]) => { const c = window.__board.debug().cam; const r = document.querySelector(".stage").getBoundingClientRect(); return [r.left + (x - c.x) * c.z, r.top + (y - c.y) * c.z]; }, [it.x, it.y]);
const s1 = await page.evaluate(([x, y]) => { const c = window.__board.debug().cam; const r = document.querySelector(".stage").getBoundingClientRect(); return [r.left + (x - c.x) * c.z, r.top + (y - c.y) * c.z]; }, [it.x + it.w, it.y + it.h]);
await setMode("pen");
await penLine([[s0[0] + 20, s0[1] + 30], [s1[0] - 20, s1[1] - 30]]);
await setMode("lasso");
await lasso(s0[0] - 15, s0[1] - 15, s1[0] + 15, s1[1] + 15);
await settle();
let d = await dbg();
check(d.selection?.items === 1 && d.selection?.strokes === 1, "the image and the ink on it lassoed", JSON.stringify(d.selection));
const before = { strokes: d.strokes, items: d.items, undo: d.undo };
await tapFinger('.selbar [data-act="cut"]');
d = await dbg();
check(d.items === 0 && d.strokes === before.strokes - 1 && d.undo === before.undo + 1 && d.selection === null, "Cut takes them off the board as one undo step", JSON.stringify({ before, after: { strokes: d.strokes, items: d.items, undo: d.undo } }));
await tapFinger('[data-act="undo"]');
d = await dbg();
check(d.items === 1 && d.strokes === before.strokes, "undo brings both back");
await tapFinger('[data-act="redo"]');
d = await dbg();
check(d.items === 0 && d.strokes === before.strokes - 1, "redo cuts again");
const clip2 = await page.evaluate(() => JSON.parse(localStorage.getItem("vc_board_clip") ?? "null"));
check(clip2?.items?.length === 1 && clip2.items[0].src === src && clip2.from === a, "the cut is on the clipboard (the image names its file on board A)");

const b = await newBoard(`Clip B ${Date.now() % 100000}`);
const missing = await page.evaluate(async ([slug, src]) => (await fetch(`/api/v1/boards/${slug}/${src}`)).status, [b, src]);
await setMode("lasso");
await fingerHold(640, 480);
await settle();
check((await pasteBar()).shown, "on board B, a finger's long-press offers Paste");
const ub = (await dbg()).undo;
await tapFinger('.pastebar [data-act="paste"]');
await page.waitForFunction(() => window.__board.debug().items === 1, null, { timeout: 5000 }).catch(() => {});
d = await dbg();
const pi = d.itemsList[0];
const wb = await toWorld(640, 480);
check(d.items === 1 && d.strokes === 1 && d.selection?.items === 1 && d.selection?.strokes === 1 && d.undo === ub + 1, "Paste on board B: the image and its ink, selected, one undo step", JSON.stringify({ items: d.items, strokes: d.strokes, sel: d.selection, undo: [ub, d.undo] }));
const pasteBox = { cx: pi.x + pi.w / 2, cy: pi.y + pi.h / 2 };
check(pi && Math.abs(pi.w - it.w) < 0.2 && Math.abs(pi.h - it.h) < 0.2, "…the image keeps its size", JSON.stringify(pi));
check(Math.abs(pasteBox.cx - wb.x) < 25 && Math.abs(pasteBox.cy - wb.y) < 35, "…centred near the press (with its ink)", JSON.stringify({ pasteBox, wb }));
const copied = await page.evaluate(async ([slug, src]) => (await fetch(`/api/v1/boards/${slug}/${src}`)).status, [b, src]);
check(missing === 404 && copied === 200, "…its file copied into board B's assets", `${missing} → ${copied}`);
await page.waitForTimeout(400);
await page.screenshot({ path: join(SHOTS, "pasted-across.png") });
await page.evaluate(() => window.__board.flush());
d = await dbg();
check(d.status === "saved" && !d.dirty, "board B saves with the pasted image", JSON.stringify({ status: d.status, dirty: d.dirty }));
await openBoard(b);
d = await dbg();
check(d.items === 1 && d.strokes === 1, "after a reload, the paste is on board B", JSON.stringify({ items: d.items, strokes: d.strokes }));
await tapFinger('[data-act="undo"]');
d = await dbg();
check(d.items === 0 && d.strokes === 0, "undo (after the reload too) takes the paste back", JSON.stringify({ items: d.items, strokes: d.strokes }));

await page.evaluate(() => window.__board.flush()).catch(() => {});
await browser.close();
console.log(failed() ? `${failed()} FAILED` : "all ok");
process.exit(failed() ? 1 : 0);
