// A make streams into the inbox (server/inbox.ts: BoardSend {make, more:true} lands parts while the entry is still
// "being made"), in WebKit as Carl's iPad. The box's answers are the seeded problem set's, cut to the parts landed
// so far (so the part files are real): the card says "Being made… N problems so far" and opens; the open entry
// grows as parts land (without jumping back to the top), each landed part can be added on its own while the rest
// are still being made, and the last send clears "being made".
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/inbox-stream.mjs [board url]
import { ipadPage, checker } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const { check, failed } = checker();
const { browser, page } = await ipadPage();
page.on("pageerror", (e) => check(false, "no page error", e.message));
await page.route("**/api/v1/board/log", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' }));

await page.goto(url);
const real = await page.evaluate(async () => {
  const list = (await (await fetch("/api/v1/inbox")).json()).entries;
  const set = list.find((e) => e.parts.length >= 4 && e.parts.every((p) => p.kind === "math"));
  return { summary: set, entry: await (await fetch(`/api/v1/inbox/${encodeURIComponent(set.id)}`)).json() };
});
check(!!real.summary, "the seeded problem set is there", real.summary?.title);
const id = real.entry.id;
let landed = 1, making = true;
const entry = () => ({ ...real.entry, status: "unread", parts: real.entry.parts.slice(0, landed), ...(making ? { making: { request: "a problem set", startedAt: Date.now() } } : {}) });
const summary = () => ({ ...real.summary, status: "unread", making, parts: real.summary.parts.slice(0, landed), added: 0 });
await page.route("**/api/v1/inbox", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [summary()], unread: making ? 0 : 1 }) }));
await page.route(`**/api/v1/inbox/${encodeURIComponent(id)}`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(entry()) }));
await page.route(`**/api/v1/inbox/${encodeURIComponent(id)}/read`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }));

const slug = await page.evaluate(async () => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Stream ${Date.now() % 100000}` }) })).json()).slug);
await page.goto("about:blank");
await page.goto(`${url}#/b/${slug}`);
await page.waitForFunction(() => !!window.__board?.debug);
const tap = async (sel) => {
  await page.locator(sel).first().waitFor({ state: "visible", timeout: 8000 });
  await page.waitForTimeout(300); // the sheet slides in
  const b = await page.locator(sel).first().boundingBox();
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForTimeout(150);
};
// A part lands: the box's /poll event makes the page fetch the list (here: coming back to the page does the same).
const land = async () => {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(500);
};

await tap('[data-act="inbox"]');
await page.waitForSelector(`aside.inbox button[data-id="${id}"]`);
const card = await page.locator(`aside.inbox button[data-id="${id}"]`).innerText();
check(/Being made/.test(card) && /1 problem so far/.test(card), "the card: being made, with the part that landed", card.replace(/\s+/g, " "));
check((await page.locator(`aside.inbox button[data-id="${id}"]`).getAttribute("data-inert")) === null, "…and it opens");
await tap(`aside.inbox button[data-id="${id}"]`);
await page.waitForSelector("aside.inbox [data-part]");
check((await page.locator("aside.inbox [data-part]").count()) === 1, "open: the landed part");
check(/Being made/.test(await page.locator("aside.inbox").innerText()), "open: it says more parts are coming");
for (landed = 2; landed <= real.entry.parts.length; landed++) {
  // Scrolled down a little (when there is room to), as Carl would be, reading.
  const scrolled = await page.evaluate(() => {
    const el = document.querySelector("aside.inbox [data-scroll]");
    el.scrollTop = 40;
    return el.scrollTop;
  });
  await land();
  await page.waitForFunction((n) => document.querySelectorAll("aside.inbox [data-part]").length === n, landed, { timeout: 4000 }).catch(() => {});
  const n = await page.locator("aside.inbox [data-part]").count();
  const sc = await page.evaluate(() => document.querySelector("aside.inbox [data-scroll]").scrollTop);
  check(n === landed, `part ${landed} lands in the open entry`, `${n} parts shown`);
  if (scrolled >= 30) check(sc >= 30, "…without jumping back to the top", `scrollTop ${sc}`);
  if (landed === 2) {
    // A landed part, added while the rest are still being made.
    await tap('aside.inbox [data-part="1"] button[data-add="1"]');
    await page.waitForFunction(() => window.__board.debug().items === 1, null, { timeout: 8000 }).catch(() => {});
    check((await page.evaluate(() => window.__board.debug().items)) === 1, "a landed part is added while the make goes on");
    await tap('[data-act="inbox"]');
    await tap(`aside.inbox button[data-id="${id}"]`);
    await page.waitForSelector("aside.inbox [data-part]");
  }
}
landed = real.entry.parts.length;
making = false;
await land();
await page.waitForFunction(() => !/Being made/.test(document.querySelector("aside.inbox").innerText), null, { timeout: 4000 }).catch(() => {});
const text = await page.locator("aside.inbox").innerText();
check(!/Being made/.test(text), "the last send: no longer being made", text.slice(0, 80).replace(/\s+/g, " "));
check((await page.locator("aside.inbox [data-part]").count()) === landed, "…with every part");

await browser.close();
console.log(failed() ? `${failed()} check(s) failed` : "all checks passed");
process.exit(failed() ? 1 : 0);
