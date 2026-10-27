// Voice can LOOK at the board (board/src/voice.ts lookAtBoard), in WebKit as Carl's iPad (Mac UA, touch): the mic
// is tapped (the fake SDK, ?voice=fake), the session is given LookAtScreen as a tool the page answers itself and a
// prompt that says it can see the board; the Pencil writes, the agent calls LookAtScreen and a picture of the view
// comes back through the image path; asked again with nothing changed, it says so (nothing re-sent); after a new
// stroke it sends a new picture, different from the first.
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/voice-look.mjs [board url]
import { ipadPage, checker, touchScript } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const { check, failed } = checker();
const { browser, page } = await ipadPage();
page.on("pageerror", (e) => check(false, "no page error", e.message));
await page.route("**/api/v1/board/log", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' }));
await page.addInitScript(touchScript());
// The pictures the look sends, as the page hands them to the SDK (their bytes' hash).
await page.addInitScript(() => {
  window.__looks = [];
});

await page.goto(url);
await page.evaluate(() => localStorage.clear());
const slug = await page.evaluate(async () => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Look ${Date.now() % 100000}` }) })).json()).slug);
await page.goto("about:blank");
await page.goto(`${url}?voice=fake#/b/${slug}`);
await page.waitForFunction(() => !!window.__board?.debug && !!window.__voice);
await page.waitForTimeout(300);

const pen = (from, to) => page.evaluate(([a, b]) => window.__pen(a, b), [from, to]);
const look = () => page.evaluate(() => window.__voiceFake.tool("LookAtScreen", {}));
const files = () => page.evaluate(() => window.__voiceFake.files);
// The picture the look would send now: the board's own snapshot, hashed as the image path keys it.
const shotKey = () =>
  page.evaluate(async () => {
    const b = await window.__board.snapshotView();
    if (!b) return null;
    const u = new Uint8Array(await b.arrayBuffer());
    let h = 0x811c9dc5;
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193);
    return `${(h >>> 0).toString(16)}-${u.length}`;
  });

// Before anything is written: the view is empty, and the tool says so (no picture).
const mic = await page.locator('[data-act="voice"]').boundingBox();
await page.touchscreen.tap(mic.x + mic.width / 2, mic.y + mic.height / 2);
await page.waitForFunction(() => window.__voice.state.phase === "live", null, { timeout: 8000 });
const tools = await page.evaluate(() => window.__voiceFake.tools);
check(tools.includes("LookAtScreen"), "the board's session has LookAtScreen as a client tool", JSON.stringify(tools));
const prompt = await page.evaluate(() => window.__voiceFake.prompt ?? "");
check(/You CAN see the board: LookAtScreen/.test(prompt), "the session's prompt says it can look at the board");
const empty = await look();
check(/empty/.test(empty) && /Look \d+/.test(empty), "an empty view: the tool says so, with the board's name", empty.slice(0, 120));

// The Pencil writes; the agent looks: a picture of the view comes back.
await pen([400, 400], [700, 460]);
await page.waitForTimeout(400);
const f0 = await files();
const k1 = await shotKey();
const r1 = await look();
const f1 = await files();
check(/^Attached a picture/.test(r1), "after a stroke, LookAtScreen attaches a picture of the view", r1.slice(0, 100));
check(f1 === f0 + 1, "…uploaded through the image path", `${f0} → ${f1}`);
check(/1 stroke/.test(r1), "…with the board as text (its strokes)", r1.slice(0, 200));

// Asked again with nothing changed: no new upload, and it says the picture it has is current.
const r2 = await look();
check(/looks exactly as in the picture of his board you already have/.test(r2) && (await files()) === f1, "unchanged: nothing re-sent, the tool says so", r2.slice(0, 80));

// A new stroke: a new picture, different from the first.
await pen([420, 560], [760, 600]);
await page.waitForTimeout(400);
const k2 = await shotKey();
const r3 = await look();
check(/^Attached a picture/.test(r3) && (await files()) === f1 + 1, "after another stroke, a new picture is attached", r3.slice(0, 100));
check(k1 && k2 && k1 !== k2, "…and it differs from the first", `${k1} vs ${k2}`);
check(/2 strokes/.test(r3), "…and the text counts both strokes", r3.slice(0, 200));

await browser.close();
console.log(failed() ? `\n${failed()} FAILED` : "\nall ok");
process.exit(failed() ? 1 : 0);
