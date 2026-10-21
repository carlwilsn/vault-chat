// Show on the board (server/show.ts: the agent's Show {where: "board", label}), in WebKit as Carl's iPad: the board
// follows the box's feed as client=board; a {type:"show", to:"board", target:{label:"Problem 3"}} signal centres the
// item labelled "Problem 3" in the view below the controls (zoomed out only if it would not fit), outlines it for a
// moment, and acks {ok, landed}; a label on no item acks {ok:false} naming the labelled items. The feed is the real
// board app's long poll, answered here (the preview box runs without an agent to call Show).
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/show-label.mjs [board url]
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipadPage, checker, touchScript } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const OUT = process.env.OUT ?? join(tmpdir(), "board-show");
mkdirSync(OUT, { recursive: true });
const { check, failed } = checker();
const { browser, page } = await ipadPage();
await page.addInitScript(touchScript());
page.on("pageerror", (e) => check(false, "no page error", e.message));
await page.route("**/api/v1/board/log", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' }));

// The feed: the board's long poll, held until a show signal is queued.
const queued = [];
const clients = new Set();
let seq = 1000, polls = 0;
await page.route("**/poll?**", async (route) => {
  const u = new URL(route.request().url());
  clients.add(u.searchParams.get("client"));
  const after = u.searchParams.get("after");
  if (after === "latest") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ next: seq, events: [], epoch: "e1" }) });
  // Only the newest poll takes the queue (one left over from a page navigated away would swallow it).
  const me = ++polls;
  for (let i = 0; i < 400 && !(queued.length && me === polls); i++) await new Promise((r) => setTimeout(r, 50));
  const events = (me === polls ? queued.splice(0) : []).map((signal) => ({ seq: ++seq, type: "signal", signal }));
  if (process.env.DEBUG) console.log("poll answer", after, JSON.stringify(events));
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ next: seq, events, epoch: "e1" }) }).catch(() => {});
});
const acks = new Map();
await page.route("**/api/v1/show/*/ack", async (route) => {
  const id = decodeURIComponent(route.request().url().split("/show/")[1].split("/")[0]);
  acks.set(id, JSON.parse(route.request().postData() ?? "{}"));
  await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"waiting":true}' });
});
const showAndWait = async (id, label) => {
  queued.push({ type: "show", to: "board", id, target: { label } });
  for (let i = 0; i < 100 && !acks.has(id); i++) await page.waitForTimeout(50);
  return acks.get(id);
};

await page.goto(url);
await page.evaluate(() => localStorage.clear());
const slug = await page.evaluate(async () => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Show ${Date.now() % 100000}` }) })).json()).slug);
await page.goto("about:blank");
await page.goto(`${url}#/b/${slug}`);
await page.waitForFunction(() => !!window.__board?.debug);

// The Cauchy problem set from the inbox, added: five items labelled Problem 1–5.
const entry = await page.evaluate(async () => (await (await fetch("/api/v1/inbox")).json()).entries.find((e) => e.title.startsWith("Cauchy")));
check(!!entry, "the preview box's inbox has the problem set");
await page.locator('[data-act="inbox"]').tap();
await page.locator(`aside.inbox button[data-id="${entry.id}"]`).tap();
await page.locator('aside.inbox button[data-add="all"]').tap();
await page.waitForFunction(() => window.__board.debug().itemsList.length >= 5, null, { timeout: 15000 });
await page.waitForTimeout(800);
check(clients.has("board"), "the board follows the feed as client=board", [...clients].join(","));

// Away from them: panned far off and zoomed in.
await page.evaluate(() => {
  const v = window.__board;
  v.cam = { x: v.cam.x + 3000, y: v.cam.y + 2000, z: v.homeZ * 3 };
  v.camMoved();
});
await page.waitForTimeout(600);
const ack = await showAndWait("s1", "Problem 3");
await page.waitForTimeout(250);
const where = await page.evaluate(() => {
  const v = window.__board, it = v.board.items.find((x) => x.label === "Problem 3");
  const r = v.stage.getBoundingClientRect();
  const { x, y, z } = v.cam;
  const sx = (it.x - x) * z, sy = (it.y - y) * z, sw = it.w * z, sh = it.h * z;
  return { cx: sx + sw / 2, cy: sy + sh / 2, x0: sx, y0: sy, x1: sx + sw, y1: sy + sh, W: r.width, H: r.height, z: z / v.homeZ, shown: !!v.shown };
});
await page.screenshot({ path: join(OUT, "show-problem-3.png"), scale: "device" });
check(ack?.ok === true && /Problem 3/.test(ack.landed ?? ""), "the board acks the show with what it did", JSON.stringify(ack));
check(Math.abs(where.cx - where.W / 2) < 4 && Math.abs(where.cy - (76 + (where.H - 76) / 2)) < 4, "Problem 3 is centred in the view below the controls", `centre ${where.cx.toFixed(0)},${where.cy.toFixed(0)} in ${where.W}×${where.H}`);
check(where.x0 >= 0 && where.x1 <= where.W && where.y0 >= 76 && where.y1 <= where.H, "…whole (zoomed out to fit, from 3×)", `${where.z.toFixed(2)}× · ${where.x0.toFixed(0)},${where.y0.toFixed(0)} → ${where.x1.toFixed(0)},${where.y1.toFixed(0)}`);
check(where.shown, "…and outlined for a moment");

const miss = await showAndWait("s2", "Problem 9");
check(miss?.ok === false && /Problem 9/.test(miss.error ?? "") && /Problem 1/.test(miss.error ?? ""), "a label on no item acks an honest no, naming the labelled items", JSON.stringify(miss));

// On the board list there is no board to show it on: an honest no.
await page.evaluate(() => (location.hash = ""));
await page.waitForSelector('[data-act="inbox-list"]');
const list = await showAndWait("s3", "Problem 3");
check(list?.ok === false && /board list/.test(list.error ?? ""), "on the board list: an honest no", JSON.stringify(list));

console.log(`screenshots: ${OUT}`);
await browser.close();
console.log(failed() ? `${failed()} check(s) failed` : "all checks passed");
process.exit(failed() ? 1 : 0);
