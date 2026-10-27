// What the agent sees of the board, and how fresh: from the Pencil lifting to the box's boards/<slug>/overview.png
// (the whole board) and view.png (the part in view) being rewritten once the pen has rested (2 s; never between
// strokes, where drawing them held the next pen down), on a busy board (600 strokes of handwriting,
// an image), in WebKit as Carl's iPad. And LookAtScreen's picture: the part in view and the whole board side by
// side in one image, how long it takes on the iPad, and that it never holds up writing (the time the main thread
// spends drawing the pictures).
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   VAULT=<the box's vault, printed by box.ts> PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/board-pictures.mjs [board url]
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipadPage, checker } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const VAULT = process.env.VAULT;
if (!VAULT) throw new Error("VAULT=<the preview box's vault> (box.ts prints it)");
const OUT = process.env.OUT ?? join(tmpdir(), "board-pictures");
mkdirSync(OUT, { recursive: true });
const { check, failed } = checker();
const { browser, page } = await ipadPage();
page.on("pageerror", (e) => check(false, "no page error", e.message));
const logged = [];
await page.route("**/api/v1/board/log", async (route) => {
  try {
    logged.push(...(JSON.parse(route.request().postData() ?? "{}").events ?? []));
  } catch {
    /* not JSON */
  }
  await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true,"n":0}' });
});
await page.addInitScript(() => {
  let down = null;
  const fire = (type, x, y, buttons) => {
    const target = type === "pointerdown" ? (document.elementFromPoint(x, y) ?? document.body) : down;
    if (type === "pointerdown") down = target;
    target.dispatchEvent(new PointerEvent(type, { pointerId: 950, pointerType: "pen", isPrimary: true, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, width: 1, height: 1, pressure: buttons ? 0.5 : 0, buttons, button: type === "pointermove" ? -1 : 0 }));
  };
  window.__penPath = async (pts) => {
    const t0 = performance.now();
    fire("pointerdown", pts[0].x, pts[0].y, 1);
    for (let i = 1; i < pts.length; i++) {
      while (performance.now() < t0 + pts[i].t - pts[0].t);
      fire("pointermove", pts[i].x, pts[i].y, 1);
      if (i % 24 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const l = pts[pts.length - 1];
    fire("pointerup", l.x, l.y, 0);
    return Date.now();
  };
});

await page.goto(url);
await page.evaluate(() => localStorage.clear());
const slug = await page.evaluate(async () => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Pictures ${Date.now() % 100000}` }) })).json()).slug);
// A busy board: 600 strokes of handwriting spread over three screens, saved once.
await page.goto("about:blank");
await page.goto(`${url}#/b/${slug}`);
await page.waitForFunction(() => !!window.__board?.debug);
await page.evaluate(async () => {
  const { inkTraces } = await import("/board/src/inkTraces.ts");
  const v = window.__board;
  const all = [0, 1, 2, 3, 4].flatMap((k) => inkTraces(k));
  for (let i = 0; i < 600; i++) {
    const t = all[i % all.length];
    const ox = (i % 20) * 70 - 100, oy = Math.floor(i / 20) * 60 - 100;
    const xy = t.pts.flatMap((p) => [Math.round(((p.x - t.pts[0].x) * 0.3 + ox + 200) * 100) / 100, Math.round(((p.y - t.pts[0].y) * 0.3 + oy + 200) * 100) / 100]);
    v.board.strokes.push({ id: `s${i}`, tool: "pen", color: "#1f1f24", w: 2.4, xy });
  }
  v.changed();
  await v.flush();
});
await page.goto("about:blank");
await page.goto(`${url}#/b/${slug}`);
await page.waitForFunction(() => !!window.__board?.debug);
await page.waitForTimeout(1500);

const dir = join(VAULT, "boards", slug);
const mtime = (f) => {
  try {
    return statSync(join(dir, f)).mtimeMs;
  } catch {
    return 0;
  }
};
const line = (y) => Array.from({ length: 60 }, (_, i) => ({ x: 300 + i * 5, y: y + 6 * Math.sin(i / 4), t: i * 6 }));
const fresh = [];
for (let k = 0; k < 6; k++) {
  const up = await page.evaluate((p) => window.__penPath(p), line(420 + k * 30));
  let o = 0, v = 0;
  for (const t0 = Date.now(); Date.now() - t0 < 6000; ) {
    if (!o && mtime("overview.png") >= up) o = Date.now() - up;
    if (!v && mtime("view.png") >= up) v = Date.now() - up;
    if (o && v) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  fresh.push({ overview: o || Infinity, view: v || Infinity });
  await page.waitForTimeout(300);
}
// Does the save hold up the page (a pen coming down meanwhile)? The longest gap between frames around one.
const gap = await page.evaluate(async () => {
  // (From the lift: the synthetic pen itself busy-waits between its samples.)
  const pts = Array.from({ length: 40 }, (_, i) => ({ x: 300 + i * 5, y: 700, t: i * 6 }));
  await window.__penPath(pts);
  let last = performance.now(), worst = 0, run = true;
  const tick = () => {
    const t = performance.now();
    worst = Math.max(worst, t - last);
    last = t;
    if (run) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  await new Promise((r) => setTimeout(r, 2500));
  run = false;
  return Math.round(worst);
});
console.log(JSON.stringify({ longestFrameGapMs: gap }));
// The PNGs are encoded in a worker on an OffscreenCanvas (iPadOS 16.4+); a WebKit without one (Playwright's Windows
// build) encodes them on the page, and then the encode is the gap.
const offscreen = await page.evaluate(() => typeof OffscreenCanvas === "function");
if (offscreen) check(gap <= 120, "the save after a lift (the board, its pictures) never holds the page up for long", `longest gap between frames ${gap} ms`);
else console.log(`note: this WebKit has no OffscreenCanvas, so the PNGs were encoded on the page: longest gap between frames ${gap} ms (on the iPad the encode runs in a worker)`);
const worst = Math.max(...fresh.map((f) => Math.max(f.overview, f.view)));
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const pics = logged.filter((e) => e.ev === "board.pictures" || e.type === "board.pictures" || e.event === "board.pictures");
console.log(JSON.stringify({ fresh, pictures: pics.slice(-3) }));
// They wait for the pen to rest (view.ts PICTURES_IDLE_MS, 2 s) and then take what drawing them takes.
check(worst <= 4000, "pen-up → fresh overview.png and view.png on the box within 4 s: 2 s of rest, then drawn (600 strokes on the board)", `median ${med(fresh.map((f) => f.overview))} / ${med(fresh.map((f) => f.view))} ms, worst ${worst} ms`);
check(Math.min(...fresh.map((f) => Math.min(f.overview, f.view))) >= 1900, "…and never before the pen has rested 2 s (they are not drawn between strokes)");

// Writing on (a stroke every 0.6 s for 6 s, the pen lifting between): no picture is drawn until the pen rests.
{
  await page.waitForTimeout(4000); // the pictures after the strokes above have landed
  const start = Date.now();
  let lastUp = 0;
  for (let k = 0; k < 10; k++) {
    lastUp = await page.evaluate((p) => window.__penPath(p), line(470 + k * 12).slice(0, 30));
    await page.waitForTimeout(400);
  }
  const during = Math.max(mtime("overview.png"), mtime("view.png"));
  let after = 0;
  for (const t0 = Date.now(); Date.now() - t0 < 6000 && !after; await new Promise((r) => setTimeout(r, 20))) if (mtime("overview.png") > lastUp && mtime("view.png") > lastUp) after = Date.now() - lastUp;
  check(during < start, "writing on for 6 s, a stroke every 0.6 s: no picture was made between the strokes", during >= start ? `one written ${Math.round(during - start)} ms into the writing` : "");
  check(after >= 1900 && after <= 4000, "…they come 2–4 s after the last stroke", `${after} ms`);
}

// LookAtScreen's picture.
const look = await page.evaluate(async () => {
  const v = window.__board;
  const t0 = performance.now();
  const blob = await v.snapshotView();
  const ms = performance.now() - t0;
  const img = await createImageBitmap(blob);
  const b64 = await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1]);
    fr.readAsDataURL(blob);
  });
  return { ms: Math.round(ms), w: img.width, h: img.height, bytes: blob.size, b64 };
});
writeFileSync(join(OUT, "look-at-screen.jpg"), Buffer.from(look.b64, "base64"));
check(look.w > look.h * 1.4, "LookAtScreen's picture holds the view and the whole board side by side", `${look.w}×${look.h}, ${Math.round(look.bytes / 1024)} KB`);
check(look.ms <= 400, "…taken on the iPad in well under half a second", `${look.ms} ms`);
console.log(`screenshots: ${OUT}`);
await browser.close();
console.log(failed() ? `${failed()} check(s) failed` : "all checks passed");
process.exit(failed() ? 1 : 0);
