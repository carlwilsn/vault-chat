// The inbox badge, live, in WebKit as Carl's iPad (Mac UA, touch): with a board open and the inbox closed, a send
// from the box (the real validated POST /api/v1/inbox) shows the badge — the count of entries new to this iPad —
// within a second; it pops; it still does after the page goes to the background and comes back, and after the
// box's /poll feed drops and reconnects; opening the inbox sees them all (the badge goes); the board list shows the
// count too. (An entry being made that gets another part counts again: inbox.ts unseenCount, by its parts.)
//
// Before (25dc8c2): the board listened for {type:"inbox"} on /poll, but the box's vault log wraps every inbox
// change as {type:"signal", signal:{type:"inbox", …}} — the badge never moved until the inbox was opened.
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/inbox-badge.mjs [board url]
import { ipadPage, checker, touchScript } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const { check, failed } = checker();
const { browser, page } = await ipadPage();
await page.addInitScript(touchScript());
page.on("pageerror", (e) => check(false, "no page error", e.message));
await page.route("**/api/v1/board/log", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' }));

await page.goto(url);
await page.evaluate(() => localStorage.clear());
const slug = await page.evaluate(async () => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Badge ${Date.now() % 100000}` }) })).json()).slug);
await page.goto("about:blank");
await page.goto(`${url}#/b/${slug}`);
await page.waitForFunction(() => !!window.__board?.debug);

const badge = () => page.evaluate(() => {
  const b = document.querySelector('[data-act="inbox"] .badge');
  return b && !b.classList.contains("hidden") ? Number(b.textContent.replace("+", "")) : 0;
});
const send = (title) =>
  page.evaluate(async (title) => {
    const r = await fetch("/api/v1/inbox", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, note: "badge check", parts: [{ kind: "math", label: "P", markdown: "Show that $x^2 \\ge 0$." }] }) });
    return (await r.json()).id;
  }, title);
/** Send, then how long from the box accepting it until the badge reads `want` (ms; Infinity after 3 s). */
const timed = async (title, want) => {
  await send(title);
  const t0 = Date.now();
  for (;;) {
    if ((await badge()) >= want) return Date.now() - t0;
    if (Date.now() - t0 > 3000) return Infinity;
    await page.waitForTimeout(25);
  }
};

// Let the first poll settle, and see whatever the preview box's seeded inbox holds (opening the inbox sees it all).
await page.waitForTimeout(800);
await page.locator('[data-act="inbox"]').tap();
await page.waitForSelector("aside.inbox");
await page.waitForTimeout(300);
await page.locator('aside.inbox [data-x="close"]').tap();
await page.waitForTimeout(400);
check((await badge()) === 0, "opening the inbox sees everything in it: no badge", String(await badge()));

const ms1 = await timed("Badge check 1", 1);
check(ms1 <= 1000, "a send from the box shows the badge within a second (board open, inbox closed)", `${ms1} ms`);
const popped = await page.evaluate(() => document.querySelector('[data-act="inbox"] .badge').classList.contains("animate-badge-pop"));
check(popped, "…and the badge pops when it goes up");
const ms2 = await timed("Badge check 2", 2);
check(ms2 <= 1000, "a second send makes it 2", `${ms2} ms, badge ${await badge()}`);

// The background and back (iPadOS freezes a hidden page's requests; coming back reconnects at once).
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
await send("Sent while away");
await page.waitForTimeout(500);
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
await page.waitForFunction(() => Number(document.querySelector('[data-act="inbox"] .badge')?.textContent) >= 3, null, { timeout: 2000 }).catch(() => {});
check((await badge()) === 3, "back from the background, what was sent meanwhile is counted", String(await badge()));
const ms3 = await timed("Badge check after the background", 4);
check(ms3 <= 1000, "…and the next send shows within a second", `${ms3} ms`);

// The feed drops (the box restarting, the network gone) and comes back.
await page.route("**/poll?**", (route) => route.abort());
await page.evaluate(() => window.dispatchEvent(new Event("offline")));
await page.waitForTimeout(1500);
await send("Sent while the feed was down");
await page.unroute("**/poll?**");
const t0 = Date.now();
await page.waitForFunction(() => Number(document.querySelector('[data-act="inbox"] .badge')?.textContent) >= 5, null, { timeout: 8000 }).catch(() => {});
check((await badge()) === 5, "after the feed drops and reconnects, what was sent meanwhile is counted", `${await badge()} after ${Date.now() - t0} ms`);
const ms4 = await timed("Badge check after a reconnect", 6);
check(ms4 <= 1000, "…and the next send shows within a second", `${ms4} ms`);

// Opening the inbox sees them all.
await page.locator('[data-act="inbox"]').tap();
await page.waitForSelector("aside.inbox");
await page.waitForTimeout(300);
check((await badge()) === 0, "opening the inbox: the badge goes", String(await badge()));
await page.locator('aside.inbox [data-x="close"]').tap();
await page.waitForTimeout(300);
check((await badge()) === 0, "…and stays gone after it closes", String(await badge()));

// The board list shows it too.
await page.evaluate(() => (location.hash = ""));
await page.waitForSelector('[data-act="inbox-list"]');
await send("Sent while on the board list");
await page.waitForFunction(() => Number(document.querySelector('[data-act="inbox-list"] .badge')?.textContent) >= 1, null, { timeout: 1500 }).catch(() => {});
check((await page.evaluate(() => document.querySelector('[data-act="inbox-list"] .badge')?.textContent)) === "1", "the board list shows the new entry's badge too", String(await page.evaluate(() => document.querySelector('[data-act="inbox-list"] .badge')?.textContent)));

await browser.close();
console.log(failed() ? `${failed()} check(s) failed` : "all checks passed");
process.exit(failed() ? 1 : 0);
