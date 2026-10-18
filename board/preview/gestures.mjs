// Finger pan and pinch on the board, as Carl's iPad delivers them (board/preview/ipad.mjs: a Mac UA, touch, real
// iPad contact sizes). Each case starts from a fresh camera and says what moved.
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/gestures.mjs [http://localhost:1431/board/]
import { ipadPage, checker, touchScript } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const { check, failed } = checker();
const { browser, page } = await ipadPage();
page.on("pageerror", (e) => check(false, "no page error", e.message));
// The board's log batches, as the box would get them.
const logged = [];
await page.route("**/api/v1/board/log", async (route) => {
  try {
    logged.push(...(JSON.parse(route.request().postData() ?? "{}").events ?? []));
  } catch {
    /* not JSON */
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' });
});
await page.addInitScript(touchScript());

async function openBoard(fresh) {
  await page.goto(url);
  if (fresh) await page.evaluate(() => localStorage.clear());
  const slug = await page.evaluate(async () => {
    const r = await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Gestures ${Date.now() % 100000}` }) });
    return (await r.json()).slug;
  });
  // A fresh load (whether a Pencil was seen is read when the page loads).
  await page.goto("about:blank");
  await page.goto(`${url}#/b/${slug}`);
  await page.waitForFunction(() => !!window.__board?.debug);
  await page.waitForTimeout(300);
  return slug;
}
const cam = () => page.evaluate(() => window.__board.debug().cam);
const dbg = () => page.evaluate(() => window.__board.debug());
const gesture = (paths, ms, stagger) => page.evaluate(([p, m, s]) => window.__gesture(p, m, s), [paths, ms ?? 300, stagger ?? 30]);
const pen = (from, to) => page.evaluate(([a, b]) => window.__pen(a, b), [from, to]);
const moved = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * a.z;

// ---------------------------------------------------------------- a Pencil has been seen (Carl's iPad)
await openBoard(true);
await pen([300, 400], [500, 420]); // the Pencil writes once: from now on fingers navigate
await page.waitForTimeout(800);
check((await dbg()).penSeen === true, "the Pencil is seen");
const F = 41.75, F2 = 62.6, THUMB = 83.5;

// Fresh camera each case (the board's own home).
const reset = () =>
  page.evaluate(() => {
    const v = window.__board;
    v.cam = { x: 0, y: -60, z: v.homeZ };
    v.renderBase();
  });
async function caseRun(name, fn, expect) {
  await reset();
  // Let the board finish redrawing (headless WebKit draws slowly; a busy page delays the touches' timers).
  await page.waitForTimeout(900);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const a = await cam();
  await fn();
  await page.waitForTimeout(300);
  const b = await cam();
  const r = expect(a, b);
  check(r.ok, name, r.why);
}

await caseRun(
  "two fingertips pan (41.75 px contacts)",
  () => gesture([{ id: 1, from: [500, 400], to: [700, 500], size: F }, { id: 2, from: [600, 400], to: [800, 500], size: F }]),
  (a, b) => ({ ok: moved(a, b) > 150 && Math.abs(b.z - a.z) < 1e-6, why: `moved ${moved(a, b).toFixed(0)} px, zoom ${a.z.toFixed(3)}→${b.z.toFixed(3)}` }),
);
await caseRun(
  "two fingers pan with iPad's common 62.6 px contacts",
  () => gesture([{ id: 3, from: [500, 400], to: [300, 300], size: F2 }, { id: 4, from: [620, 400], to: [420, 300], size: F2 }]),
  (a, b) => ({ ok: moved(a, b) > 150, why: `moved ${moved(a, b).toFixed(0)} px` }),
);
await caseRun(
  "thumb and index pinch out (83.5 + 41.75 px) zooms in",
  () => gesture([{ id: 5, from: [560, 420], to: [420, 520], size: THUMB }, { id: 6, from: [640, 380], to: [780, 280], size: F }]),
  (a, b) => ({ ok: b.z > a.z * 1.5, why: `zoom ${a.z.toFixed(3)}→${b.z.toFixed(3)}` }),
);
await caseRun(
  "a pinch whose contacts grow as the fingers press (41.75 → 83.5) keeps zooming",
  () => gesture([{ id: 7, from: [520, 420], to: [600, 410], size: F, grow: THUMB - F }, { id: 8, from: [760, 420], to: [680, 410], size: F, grow: THUMB - F }]),
  (a, b) => ({ ok: b.z < a.z * 0.5, why: `zoom ${a.z.toFixed(3)}→${b.z.toFixed(3)}` }),
);
await caseRun(
  "second finger 250 ms after the first still pans",
  () => gesture([{ id: 9, from: [500, 400], to: [650, 300], size: F }, { id: 10, from: [600, 420], to: [750, 320], size: F }], 300, 250),
  (a, b) => ({ ok: moved(a, b) > 100, why: `moved ${moved(a, b).toFixed(0)} px` }),
);
await caseRun(
  "two fingers on the writing hand's side 150 ms after the pen lifts pan",
  async () => {
    await pen([700, 300], [760, 310]);
    await page.waitForTimeout(150);
    await gesture([{ id: 11, from: [600, 500], to: [450, 600], size: F }, { id: 12, from: [680, 520], to: [530, 620], size: F }]);
  },
  (a, b) => ({ ok: moved(a, b) > 100, why: `moved ${moved(a, b).toFixed(0)} px` }),
);
await caseRun(
  "two fingers pan while the Pencil hovers",
  async () => {
    const p = gesture([{ id: 13, from: [400, 400], to: [600, 450], size: F }, { id: 14, from: [500, 400], to: [700, 450], size: F }], 400);
    await page.evaluate(async () => {
      for (let i = 0; i < 8; i++) {
        document.querySelector(".stage")?.dispatchEvent(new PointerEvent("pointermove", { pointerId: 901, pointerType: "pen", buttons: 0, bubbles: true, clientX: 900, clientY: 200 + i }));
        await new Promise((r) => setTimeout(r, 40));
      }
    });
    await p;
  },
  (a, b) => ({ ok: moved(a, b) > 100, why: `moved ${moved(a, b).toFixed(0)} px` }),
);
await caseRun(
  "one finger pans (a Pencil seen, one-finger scroll on by default)",
  () => gesture([{ id: 15, from: [500, 450], to: [300, 350], size: F }], 300),
  (a, b) => ({ ok: moved(a, b) > 100, why: `moved ${moved(a, b).toFixed(0)} px` }),
);
await caseRun(
  "a palm (124 px contact) moves nothing",
  () => gesture([{ id: 16, from: [500, 450], to: [300, 350], size: 124 }], 300),
  (a, b) => ({ ok: moved(a, b) < 1, why: `moved ${moved(a, b).toFixed(0)} px` }),
);
await caseRun(
  "two fingers while the Pencil is writing move nothing",
  async () => {
    const w = page.evaluate(() => window.__pen([300, 600], [600, 640], 500, 20));
    await page.waitForTimeout(60);
    await gesture([{ id: 17, from: [700, 400], to: [900, 500], size: F }, { id: 18, from: [800, 400], to: [1000, 500], size: F }], 300);
    await w;
  },
  (a, b) => ({ ok: moved(a, b) < 1, why: `moved ${moved(a, b).toFixed(0)} px` }),
);

// ---------------------------------------------------------------- no Pencil seen yet (a fresh install)
await openBoard(true);
check((await dbg()).penSeen === false, "a fresh board has seen no Pencil");
await caseRun(
  "one finger pans before any Pencil is seen",
  () => gesture([{ id: 21, from: [500, 450], to: [320, 330], size: F }], 300),
  (a, b) => ({ ok: moved(a, b) > 100, why: `moved ${moved(a, b).toFixed(0)} px` }),
);
check((await dbg()).strokes === 0, "…and draws nothing", `${(await dbg()).strokes} strokes`);
await caseRun(
  "two fingers pinch before any Pencil is seen",
  () => gesture([{ id: 22, from: [560, 420], to: [440, 480], size: F2 }, { id: 23, from: [660, 400], to: [780, 340], size: F }]),
  (a, b) => ({ ok: b.z > a.z * 1.3, why: `zoom ${a.z.toFixed(3)}→${b.z.toFixed(3)}` }),
);

// ---------------------------------------------------------------- the log says what the fingers did
await page.evaluate(() => import("/board/src/log.ts").then((m) => m.flushBoardLog()));
await page.waitForTimeout(400);
const g = logged.filter((e) => e.ev === "gestures");
const sum = (k) => g.reduce((a, e) => a + (e[k] ?? 0), 0);
check(g.length > 0, "the board log has gesture batches", JSON.stringify(g.slice(-2)));
check(sum("pan") + sum("pinch") >= 8, "…counting pans and pinches", `pan ${sum("pan")}, pinch ${sum("pinch")}`);
const palms = g.flatMap((e) => Object.keys(e.palm ?? {}));
check(palms.some((r) => /size/.test(r)) && palms.some((r) => /pen/.test(r)), "…and each rejected-as-palm reason", JSON.stringify(g.map((e) => e.palm)));

await browser.close();
console.log(failed() ? `${failed()} check(s) failed` : "all checks passed");
process.exit(failed() ? 1 : 0);
