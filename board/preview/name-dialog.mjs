// The board's name dialog on an iPad, in WebKit: New board and Rename are opened with a touch tap, the field
// is focused inside that tap while fully visible (iOS raises no keyboard for a field focused while transparent
// or outside the gesture), typing lands in it, and Create / Rename take it. Then, with a board open, typing and
// Backspace in a focused field stay the field's (the board's Delete-the-selection key leaves it alone).
//
//   npm run dev:board                 (VC_BOX=http://127.0.0.1:7432, a preview box)
//   node board/preview/name-dialog.mjs [http://localhost:1431/board/]
//
// Needs playwright-core with its WebKit (npx playwright install webkit); if it is not in node_modules, point
// PLAYWRIGHT_CORE at its folder. Exits non-zero on the first failed check.
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const pwPath = process.env.PLAYWRIGHT_CORE;
const { webkit, devices } = await import(pwPath ? pathToFileURL(join(pwPath, "index.mjs")).href : "playwright-core");
// iPadOS sends a Mac UA (board/preview/ipad.mjs): MAC_UA=0 runs with the iPad profile's own UA.
const { MAC_UA } = await import("./ipad.mjs");

let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices["iPad Pro 11"], ...(process.env.MAC_UA === "0" ? {} : { userAgent: MAC_UA }), hasTouch: true, isMobile: true });
// Every focus() the page makes: how visible the element was (its opacity times every ancestor's, animations
// included) and the event it ran in.
await ctx.addInitScript(() => {
  const real = HTMLElement.prototype.focus;
  window.__focusLog = [];
  HTMLElement.prototype.focus = function (...a) {
    let o = 1;
    for (let el = this; el && el.nodeType === 1; el = el.parentElement) o *= Number(getComputedStyle(el).opacity);
    const ev = window.event;
    window.__focusLog.push({ tag: this.tagName, opacity: o, ev: ev ? ev.type : null, trusted: !!ev?.isTrusted });
    return real.apply(this, a);
  };
});
const page = await ctx.newPage();
const logged = [];
await page.route("**/api/v1/board/log", async (route) => {
  try {
    logged.push(...(JSON.parse(route.request().postData() ?? "{}").events ?? []));
  } catch {
    /* not JSON */
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' });
});
page.on("pageerror", (e) => check(false, "no page error", e.message));

const tapAt = async (sel) => {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error(`nothing to tap: ${sel}`);
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
};
const focusEntry = () => page.evaluate(() => window.__focusLog.filter((f) => f.tag === "INPUT").at(-1) ?? null);
const active = () => page.evaluate(() => document.activeElement?.tagName ?? null);

// ---- New board
await page.goto(url);
await page.waitForSelector('[data-act="new"]');
await tapAt('[data-act="new"]');
await page.waitForSelector(".name-dialog input");
let f = await focusEntry();
check(f?.ev === "click" && f.trusted, "New board: the field is focused inside the tap's click", JSON.stringify(f));
check(f?.opacity === 1, "New board: the field is fully visible when focused", `opacity ${f?.opacity}`);
check((await active()) === "INPUT", "New board: the field has focus");
await tapAt(".name-dialog input");
check((await active()) === "INPUT", "New board: a tap on the field keeps it focused");
await page.locator(".name-dialog input").fill("");
const name = `Typed ${Date.now() % 100000}`;
await page.keyboard.type(name + "x");
await page.keyboard.press("Backspace");
check((await page.locator(".name-dialog input").inputValue()) === name, "New board: typing and Backspace land in the field", await page.locator(".name-dialog input").inputValue());
await tapAt('.name-dialog button[type="submit"]');
await page.waitForFunction(() => location.hash.startsWith("#/b/"), null, { timeout: 5000 }).catch(() => {});
const slug = (await page.evaluate(() => location.hash)).replace("#/b/", "");
check(!!slug, "New board: Create opens the new board", slug);
await page.waitForSelector(".tb-name", { state: "attached", timeout: 5000 }); // shown only when it fits beside undo (chrome-layout)
check((await page.locator(".tb-name").textContent()) === name, "New board: it has the typed name");

// ---- A hardware keyboard on an open board: a focused field keeps Backspace even with a selection.
const keys = await page.evaluate(() => {
  const v = window.__board;
  let deletes = 0;
  v.deleteSel = () => void deletes++;
  v.sel = { strokes: new Set(), items: new Set() }; // any selection: Backspace on the board would delete it
  const input = document.createElement("input");
  input.value = "abc";
  v.el.appendChild(input);
  input.focus();
  window.__keys = { input, deletes: () => deletes };
  return true;
});
await page.keyboard.type("d");
await page.keyboard.press("Backspace");
await page.keyboard.press("Backspace");
const kv = await page.evaluate(() => ({ value: window.__keys.input.value, deletes: window.__keys.deletes() }));
check(kv.value === "ab" && kv.deletes === 0, "Open board: typing and Backspace in a field are the field's, not delete-selection", JSON.stringify(kv));
await page.evaluate(() => {
  window.__keys.input.remove();
  window.__board.sel = null;
});

// ---- Rename from the long-press menu
await page.evaluate(() => (location.hash = ""));
await page.waitForSelector(`.card[data-slug="${slug}"]`);
// Hold the tile (the menu opens 450 ms into a press that has not moved), then lift.
await page.evaluate((s) => {
  const c = document.querySelector(`.card[data-slug="${s}"]`);
  const r = c.getBoundingClientRect();
  const o = { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 3 };
  c.dispatchEvent(new PointerEvent("pointerdown", o));
  setTimeout(() => c.dispatchEvent(new PointerEvent("pointerup", o)), 600);
}, slug);
await page.waitForSelector('[data-m="rename"]');
await page.waitForTimeout(700);
await page.evaluate(() => (window.__focusLog.length = 0));
await tapAt('[data-m="rename"]');
await page.waitForSelector(".name-dialog input");
f = await focusEntry();
check(f?.ev === "click" && f.trusted, "Rename: the field is focused inside the tap's click", JSON.stringify(f));
check(f?.opacity === 1, "Rename: the field is fully visible when focused", `opacity ${f?.opacity}`);
check((await page.locator(".name-dialog input").inputValue()) === name, "Rename: the field holds the current name");
await tapAt(".name-dialog input");
await page.locator(".name-dialog input").fill("");
await page.keyboard.type(name + " renamed");
check((await page.locator(".name-dialog input").inputValue()) === `${name} renamed`, "Rename: typing lands in the field");
await tapAt('.name-dialog button[type="submit"]');
await page.waitForSelector(".name-dialog", { state: "detached", timeout: 5000 }).catch(() => {});
await page.waitForFunction((s) => document.querySelector(`.card[data-slug="${s}"] .font-semibold`)?.textContent?.endsWith("renamed"), slug, { timeout: 5000 }).catch(() => {});
check(((await page.locator(`.card[data-slug="${slug}"] .font-semibold`).textContent()) ?? "").endsWith("renamed"), "Rename: the list shows the new name");

// ---- The field's CSS
const us = await page.evaluate(() => {
  const i = document.createElement("input");
  document.querySelector("#app").appendChild(i);
  const s = getComputedStyle(i).webkitUserSelect;
  i.remove();
  return s;
});
check(us === "text", "Fields are selectable under the page's user-select: none", us);

// ---- Nothing lies over the field (after a board was open: the voice pill is on the page), and it says what it is.
await page.evaluate(() => (location.hash = ""));
await page.waitForSelector('[data-act="new"]');
await tapAt('[data-act="new"]');
await page.waitForSelector(".name-dialog input");
const top = await page.evaluate(() => {
  const i = document.querySelector(".name-dialog input");
  const r = i.getBoundingClientRect();
  const pts = [[0.5, 0.5], [0.1, 0.5], [0.9, 0.5]].map(([fx, fy]) => document.elementFromPoint(r.x + r.width * fx, r.y + r.height * fy));
  return { onTop: pts.every((el) => el === i), pill: !!document.querySelector(".voice-pill"), inputmode: i.getAttribute("inputmode"), enterkeyhint: i.getAttribute("enterkeyhint"), type: i.type };
});
check(top.onTop, "the field is the top element under every point of a tap on it", JSON.stringify(top));
check(top.inputmode === "text" && top.enterkeyhint === "done" && top.type === "text", "the field is a text field: inputmode text, enterkeyhint done", JSON.stringify(top));
// A tap on the field with no keyboard up (this WebKit shows none) focuses it again inside the tap.
await page.evaluate(() => (window.__focusLog.length = 0));
await tapAt(".name-dialog input");
const re = await page.evaluate(() => window.__focusLog.filter((f) => f.tag === "INPUT").at(-1) ?? null);
check(re?.ev === "touchend" && re.opacity === 1 && (await active()) === "INPUT", "a tap on the field refocuses it inside the tap (iOS raises the keyboard for that)", JSON.stringify(re));
await page.waitForTimeout(1200);
await tapAt('.name-dialog [data-act="cancel"]');
await page.evaluate(() => (location.hash = "#/b/none") && (location.hash = ""));
await page.goto("about:blank");
await page.waitForTimeout(500);
const dl = logged.filter((e) => e.ev === "dialog" || e.ev === "dialog.tap");
check(dl.some((e) => e.ev === "dialog" && e.what === "new" && e.how === "touch" && e.focused === true && typeof e.keyboard === "boolean" && e.ih > 0), "the board log says how the dialog opened, whether the field took focus and whether a keyboard came up", JSON.stringify(dl));
check(dl.some((e) => e.ev === "dialog.tap" && e.field === true), "…and each refocusing tap on the field");
await page.goto(url);

// Clean up the board this made.
await page.evaluate(async (s) => {
  const { deleteBoard } = await import("/board/src/api.ts").catch(() => ({}));
  if (deleteBoard) await deleteBoard(s);
}, slug).catch(() => {});

await browser.close();
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
