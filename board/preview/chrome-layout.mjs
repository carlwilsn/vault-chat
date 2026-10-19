// The floating controls and the voice pill, in WebKit as Carl's iPad (Mac UA, touch), held sideways and upright:
//
//   - undo and redo sit in the upper-left group (with the board's name), Boards is the last button upper right,
//     the tools are between them; no two groups overlap, and all of them are inside the screen;
//   - undo and redo still work from there (a Pencil stroke, a tap on undo, a tap on redo);
//   - a call (the fake SDK, ?voice=fake) started from the mic: the mic steps aside, the pill is ONE row no taller
//     than 40 px under the controls (waves, the chat's name, mute, end) with exactly one end-call control on screen;
//     the chat's name opens the recent chats; mute toggles; the one end button ends it and the mic comes back;
//   - a selected item's pill (Delete) is never under the controls.
//
// Screenshots: board/preview/out/chrome-*.png.
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/chrome-layout.mjs [board url]
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ipadPage, checker, touchScript } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "out");
mkdirSync(OUT, { recursive: true });
const { check, failed } = checker();

for (const [label, viewport] of [["landscape", { width: 1194, height: 834 }], ["portrait", { width: 834, height: 1194 }]]) {
  const { browser, page } = await ipadPage({ viewport });
  page.on("pageerror", (e) => check(false, `${label}: no page error`, e.message));
  await page.route("**/api/v1/board/log", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' }));
  await page.addInitScript(touchScript());
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  const slug = await page.evaluate(async () => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Chrome layout with a long board name ${Date.now() % 100000}` }) })).json()).slug);
  await page.goto("about:blank");
  await page.goto(`${url}?voice=fake#/b/${slug}`);
  await page.waitForFunction(() => !!window.__board?.debug && !!window.__voice);
  await page.waitForTimeout(400);

  const tapAt = async (sel) => {
    const b = await page.locator(sel).first().boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  };
  const groups = () =>
    page.evaluate(() => {
      const r = (el) => {
        const q = el.getBoundingClientRect();
        return { x0: q.left, y0: q.top, x1: q.right, y1: q.bottom };
      };
      const left = document.querySelector(".tb-left"), mid = document.querySelector(".tb"), right = document.querySelector(".tb-right");
      const btns = [...right.querySelectorAll("button")].filter((b) => b.offsetParent);
      return {
        W: innerWidth,
        left: r(left),
        mid: r(mid),
        right: r(right),
        undoIn: left.contains(document.querySelector('[data-act="undo"]')) && left.contains(document.querySelector('[data-act="redo"]')),
        lastRight: btns[btns.length - 1]?.dataset.act,
        nameShown: document.querySelector(".tb-name").getBoundingClientRect().width,
      };
    });
  const apart = (a, b) => a.x1 <= b.x0 + 0.5 || b.x1 <= a.x0 + 0.5;
  const inside = (a, W) => a.x0 >= 0 && a.x1 <= W;
  const checkGroups = async (when) => {
    const g = await groups();
    check(g.undoIn, `${label}${when}: undo and redo are upper left`);
    check(g.lastRight === "back", `${label}${when}: Boards is the last button upper right`, g.lastRight);
    check(apart(g.left, g.mid) && apart(g.mid, g.right) && apart(g.left, g.right), `${label}${when}: the three groups do not overlap`, JSON.stringify({ left: [g.left.x0, g.left.x1], mid: [g.mid.x0, g.mid.x1], right: [g.right.x0, g.right.x1] }));
    check(inside(g.left, g.W) && inside(g.mid, g.W) && inside(g.right, g.W), `${label}${when}: all inside the screen`);
    return g;
  };
  const g0 = await checkGroups("");
  check(g0.nameShown === 0 || g0.nameShown > 60, `${label}: the board's name shows a few words, or not at all`, `${Math.round(g0.nameShown)} px`);
  await page.screenshot({ path: join(OUT, `chrome-${label}.png`) });

  // Undo and redo from their new place.
  await page.evaluate(() => window.__pen([420, 420], [700, 520]));
  await page.waitForTimeout(250);
  const n0 = await page.evaluate(() => window.__board.debug().strokes);
  await tapAt('[data-act="undo"]');
  await page.waitForTimeout(150);
  const n1 = await page.evaluate(() => window.__board.debug().strokes);
  await tapAt('[data-act="redo"]');
  await page.waitForTimeout(150);
  const n2 = await page.evaluate(() => window.__board.debug().strokes);
  check(n0 === 1 && n1 === 0 && n2 === 1, `${label}: undo and redo work from the upper left`, `${n0} → ${n1} → ${n2}`);

  // A call.
  await tapAt('[data-act="voice"]');
  await page.waitForFunction(() => window.__voice.state.phase === "live", null, { timeout: 8000 });
  await page.waitForTimeout(400);
  const call = await page.evaluate(() => {
    const pill = document.querySelector('.voice-pill [data-voice="live"]');
    const q = pill.getBoundingClientRect();
    const mid = (el) => {
      const r = el.getBoundingClientRect();
      return Math.round(r.top + r.height / 2);
    };
    const kids = [pill.querySelector(".waves"), pill.querySelector('[data-v="chats"]'), pill.querySelector('[data-v="mute"]'), pill.querySelector('[data-v="end"]')];
    const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
    // Every control on the page that would end the call.
    const enders = [...document.querySelectorAll("button")].filter((b) => visible(b) && (/end/i.test(b.getAttribute("aria-label") ?? "") || b.dataset.v === "end" || b.dataset.act === "voice"));
    const controls = document.querySelector(".tb-right").getBoundingClientRect();
    return {
      h: q.height,
      top: q.top,
      controlsBottom: controls.bottom,
      rows: new Set(kids.map(mid)).size,
      allThere: kids.every(visible),
      enders: enders.map((b) => b.getAttribute("aria-label")),
      mic: visible(document.querySelector('[data-act="voice"]')),
      title: pill.querySelector(".v-title").textContent,
    };
  });
  check(!call.mic, `${label}: during a call the mic steps aside`);
  check(call.enders.length === 1 && call.enders[0] === "End call", `${label}: exactly one end-call control on screen`, JSON.stringify(call.enders));
  check(call.allThere && call.rows === 1, `${label}: the pill is one row (waves, chat, mute, end)`, `${call.rows} row(s)`);
  check(call.h <= 40.5, `${label}: the pill is at most 40 px tall`, `${call.h} px`);
  check(call.top >= call.controlsBottom - 0.5, `${label}: under the controls, not over them`, `${call.top} vs ${call.controlsBottom}`);
  await checkGroups(", during a call");
  await page.screenshot({ path: join(OUT, `chrome-${label}-call.png`) });
  await tapAt('.voice-pill [data-v="chats"]');
  await page.waitForTimeout(250);
  check(await page.locator(".voice-pill .v-chats").isVisible(), `${label}: the chat's name opens the recent chats`);
  await page.screenshot({ path: join(OUT, `chrome-${label}-chats.png`) });
  await tapAt('.voice-pill [data-v="chats"]');
  await page.waitForTimeout(150);
  await tapAt('.voice-pill [data-v="mute"]');
  await page.waitForTimeout(100);
  check(await page.evaluate(() => window.__voice.state.muted), `${label}: mute mutes`);
  await tapAt('.voice-pill [data-v="end"]');
  await page.waitForFunction(() => window.__voice.state.phase === "idle", null, { timeout: 5000 }).catch(() => {});
  const after = await page.evaluate(() => ({ phase: window.__voice.state.phase, mic: !!document.querySelector('[data-act="voice"]').offsetParent, pill: document.querySelector(".voice-pill").children.length }));
  check(after.phase === "idle" && after.mic && !after.pill, `${label}: the end button ends the call; the mic is back, the pill gone`, JSON.stringify(after));

  // An item selected near the top: its Delete pill stays clear of the controls.
  await page.evaluate(() => {
    const v = window.__board;
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 300;
    v.board.items.push({ id: "probe", kind: "image", x: v.cam.x + 300 / v.cam.z, y: v.cam.y + 20 / v.cam.z, w: 400 / v.cam.z, h: 300 / v.cam.z });
    v.setMode("lasso");
    v.setSel({ strokes: new Set(), items: new Set([v.board.items[v.board.items.length - 1]]) });
  });
  await page.waitForTimeout(300);
  const sel = await page.evaluate(() => {
    const s = document.querySelector(".selbar").getBoundingClientRect();
    const tops = [".tb-left", ".tb", ".tb-right"].map((q) => document.querySelector(q).getBoundingClientRect());
    return { y0: s.top, clear: tops.every((t) => s.top >= t.bottom || s.right <= t.left || s.left >= t.right) };
  });
  check(sel.clear, `${label}: the selection's pill is clear of the controls`, JSON.stringify(sel));
  await browser.close();
}

console.log(failed() ? `\n${failed()} check(s) failed` : "\nall checks passed");
process.exit(failed() ? 1 : 0);
