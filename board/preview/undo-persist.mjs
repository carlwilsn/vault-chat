// Undo and redo survive leaving the board, reopening it and reloading the page — in WebKit as Carl's iPad (Mac UA,
// touch). Written with the Pencil and an inbox add between the strokes (a real tap on Add), then:
//
//   - every step undone and redone in order, before leaving (the board at each step recorded);
//   - Boards (upper right) → the list → the board again: the same undo and redo counts, and stepping back and
//     forth passes through exactly the recorded boards;
//   - a reload: the same;
//   - 230 strokes: the newest 200 steps come back;
//   - the board changed elsewhere (another save, from "another device"): its stale history is not used (no undo
//     that would take out what is no longer there), nothing breaks.
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/undo-persist.mjs [board url]
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ipadPage, checker, touchScript } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });
const { check, failed } = checker();
const { browser, page } = await ipadPage();
page.on("pageerror", (e) => check(false, "no page error", e.message));
await page.route("**/api/v1/board/log", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' }));
await page.addInitScript(touchScript());
await page.goto(url);
await page.evaluate(() => localStorage.clear());
const mk = (name) => page.evaluate(async (n) => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) })).json()).slug, name);
const slug = await mk(`Undo ${Date.now() % 100000}`);

const open = async (s) => {
  await page.goto("about:blank");
  await page.goto(`${url}#/b/${s}`);
  await page.waitForFunction(() => !!window.__board?.debug);
  await page.waitForTimeout(300);
};
const tap = async (sel) => {
  for (let i = 0; i < 40; i++) {
    const el = page.locator(sel).first();
    await el.waitFor({ state: "visible", timeout: 8000 });
    await el.evaluate((n) => n.scrollIntoView({ block: "center" })).catch(() => {});
    const b = await el.boundingBox().catch(() => null);
    if (b) return page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(50);
  }
  throw new Error(`nothing to tap: ${sel}`);
};
/** The board as a comparable string (ids and geometry of everything on it). */
const state = () => page.evaluate(() => {
  const d = window.__board.debug();
  return JSON.stringify({ s: d.strokesList.map((x) => [x.id, x.x0, x.y0]), i: d.itemsList.map((x) => [x.id, x.kind, x.x, x.y, x.w, x.h]), g: d.grid });
});
const counts = () => page.evaluate(() => ({ undo: window.__board.debug().undo, redo: window.__board.redoStack.length }));
const saved = () => page.waitForFunction(() => window.__board.debug().status === "saved" && !window.__board.debug().dirty, null, { timeout: 15000 });
const pen = (a, b) => page.evaluate(([a, b]) => window.__pen(a, b), [a, b]);

await open(slug);
// Pen, pen, an inbox add, pen on top, a background change.
const steps = [await state()];
await pen([300, 300], [600, 340]);
steps.push(await state());
await pen([320, 380], [640, 420]);
steps.push(await state());
const entry = await page.evaluate(async () => (await (await fetch("/api/v1/inbox")).json()).entries.find((e) => !e.making && !e.failed && e.parts.length === 1 && e.parts[0].kind === "image")?.id);
await tap('[data-act="inbox"]');
await tap(`aside.inbox button[data-id="${entry}"]`);
await tap('aside.inbox button[data-add="all"]');
await page.waitForFunction(() => window.__board.debug().items === 1, null, { timeout: 15000 });
await page.waitForSelector("aside.inbox", { state: "detached", timeout: 5000 }).catch(() => {});
await page.waitForTimeout(600); // the picture decodes; a refit (if any) is not a step
steps.push(await state());
await page.evaluate(() => window.__board.setMode("pen"));
await pen([500, 520], [760, 560]);
steps.push(await state());
await tap('[data-pop="menu"]');
await tap('[data-grid="dots"]');
await page.evaluate(() => window.__board.closePop());
steps.push(await state());
check((await counts()).undo === 5, "five steps written (pen, pen, inbox add, pen, background)", JSON.stringify(await counts()));

/** Undo everything, then redo everything: the board passes through each recorded step. */
const walk = async (when, from = steps.length - 1) => {
  let ok = true;
  const seen = [];
  for (let k = from; k > 0; k--) {
    await tap('[data-act="undo"]');
    await page.waitForTimeout(60);
    const s = await state();
    seen.push(s === steps[k - 1]);
    ok &&= s === steps[k - 1];
  }
  for (let k = 1; k <= from; k++) {
    await tap('[data-act="redo"]');
    await page.waitForTimeout(60);
    const s = await state();
    seen.push(s === steps[k]);
    ok &&= s === steps[k];
  }
  check(ok, `${when}: undo walks back through every step and redo forward again`, seen.map((x) => (x ? "✓" : "✗")).join(""));
};
await walk("before leaving");
// Two undone, so there is redo to keep too.
await tap('[data-act="undo"]');
await tap('[data-act="undo"]');
await page.waitForTimeout(100);
const before = { counts: await counts(), state: await state() };
check(before.state === steps[3] && before.counts.undo === 3 && before.counts.redo === 2, "two undone: 3 to undo, 2 to redo", JSON.stringify(before.counts));
await saved();

// Leave by Boards, come back from the list.
await tap('[data-act="back"]');
await page.waitForSelector(`[data-slug="${slug}"], a[href="#/b/${slug}"]`, { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(300);
await page.evaluate((s) => (location.hash = `#/b/${s}`), slug);
await page.waitForFunction(() => !!window.__board?.debug);
await page.waitForTimeout(400);
let after = { counts: await counts(), state: await state() };
check(after.state === before.state, "reopened: the board as it was left");
check(after.counts.undo === 3 && after.counts.redo === 2, "reopened: 3 to undo and 2 to redo, as left", JSON.stringify(after.counts));
check(await page.evaluate(() => !document.querySelector('[data-act="undo"]').disabled && !document.querySelector('[data-act="redo"]').disabled), "reopened: undo and redo are enabled");
// Redo the two, then the full walk.
await tap('[data-act="redo"]');
await tap('[data-act="redo"]');
await page.waitForTimeout(100);
check((await state()) === steps[5], "reopened: redo brings back what was undone before leaving");
await walk("reopened");
await page.screenshot({ path: join(OUT, "undo-persist-reopened.png") });
await saved();

// A reload.
await page.reload();
await page.waitForFunction(() => !!window.__board?.debug);
await page.waitForTimeout(400);
after = { counts: await counts(), state: await state() };
check(after.state === steps[5] && after.counts.undo === 5 && after.counts.redo === 0, "reloaded: the board and its 5 steps", JSON.stringify(after.counts));
await walk("reloaded");
await saved();

// The board changed elsewhere: another device's save bumps its rev; this history no longer describes it.
await page.evaluate(async (s) => {
  const b = await (await fetch(`/api/v1/boards/${s}`)).json();
  b.strokes = b.strokes.slice(1); // a stroke erased over there
  const r = await fetch(`/api/v1/boards/${s}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board: b, base: b.rev }) });
  if (!r.ok) throw new Error(`other save: ${r.status}`);
}, slug);
await open(slug);
after = { counts: await counts(), strokes: await page.evaluate(() => window.__board.debug().strokes) };
check(after.counts.undo === 0 && after.counts.redo === 0, "changed elsewhere: its stale history is not used", JSON.stringify(after.counts));
await pen([300, 700], [600, 720]);
await tap('[data-act="undo"]');
await page.waitForTimeout(100);
check((await page.evaluate(() => window.__board.debug().strokes)) === after.strokes, "…and a new step there undoes cleanly");

// Many steps: the newest 200 come back.
const slug2 = await mk(`Undo many ${Date.now() % 100000}`);
await open(slug2);
await page.evaluate(async () => {
  for (let k = 0; k < 230; k++) await window.__pen([100 + (k % 20) * 40, 200 + Math.floor(k / 20) * 30], [130 + (k % 20) * 40, 215 + Math.floor(k / 20) * 30], 4, 2);
});
await page.waitForTimeout(300);
const many = await counts();
await saved();
await open(slug2);
const back = await counts();
check(many.undo === 200 && back.undo === 200, "230 strokes: the newest 200 steps, kept and reloaded", `${many.undo} → ${back.undo}`);
const n0 = await page.evaluate(() => window.__board.debug().strokes);
for (let k = 0; k < 200; k++) await page.evaluate(() => window.__board.undo());
check((await page.evaluate(() => window.__board.debug().strokes)) === n0 - 200, "…and all 200 undo", `${n0} → ${await page.evaluate(() => window.__board.debug().strokes)}`);

await browser.close();
console.log(failed() ? `\n${failed()} check(s) failed` : "\nall checks passed");
process.exit(failed() ? 1 : 0);
