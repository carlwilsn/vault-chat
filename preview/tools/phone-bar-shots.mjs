// The phone's thread bar, drawer and composer in the real phone app (mock box), at 390 and 320 px:
//   node preview/tools/phone-bar-shots.mjs <out> <tag> [--url http://127.0.0.1:1431/phone/]
// Writes <out>/<width>-<view>-<tag>.png for: the thread (top bar + composer), the left panel (Main's row),
// and (after) the thread right after one tap on Clear, and the "+" with a PDF attached.
import { launch } from "./browser.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const out = resolve(argv[0] ?? "preview-proof/phone-bar");
const tag = argv[1] ?? "after";
const ui = (() => {
  const i = argv.indexOf("--url");
  return i >= 0 ? argv[i + 1] : "http://127.0.0.1:1431/phone/";
})();
mkdirSync(out, { recursive: true });

for (const width of [390, 320]) {
  const { browser, page, log } = await launch({ width, height: 760, isMobile: true, deviceScaleFactor: 2 });
  const shot = async (name) => page.screenshot({ path: join(out, `${width}-${name}-${tag}.png`) });
  await page.goto(ui + "?mock=1", { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("#titleBtn", { timeout: 120000 });
  // Main with something in it: one exchange (the mock box answers a send).
  await page.fill("#input", "What's due this week?");
  await page.tap("#sendBtn");
  await page.waitForFunction(() => document.querySelectorAll("#msgs .amsg").length > 0, null, { timeout: 8000 });
  await page.waitForTimeout(500);
  await shot("thread");
  // The left panel: Main's row.
  await page.tap("#convBtn");
  await page.waitForTimeout(700);
  await shot("drawer");
  if (tag !== "before" && width === 390) {
    // Main's glyph: three candidates (Lucide, the laptop's set) in the real row, side by side.
    const OPTS = {
      "message-circle": '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>',
      "message-square-text": '<path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/><path d="M7 11h10"/><path d="M7 15h6"/><path d="M7 7h8"/>',
      house: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    };
    const row = page.locator('[data-el="thread-main"]');
    const cells = [];
    for (const [name, paths] of Object.entries(OPTS)) {
      await page.evaluate((h) => { document.querySelector('[data-el="thread-main"] .mainico').innerHTML = h; }, paths);
      cells.push({ name, png: (await row.screenshot()).toString("base64") });
    }
    const cmp = await browser.newPage({ viewport: { width: 1200, height: 260 }, deviceScaleFactor: 2 });
    await cmp.setContent('<body style="margin:0;background:#000;color:#aaa;font:14px system-ui;display:flex;gap:16px;padding:16px">' + cells.map((c) => '<div><img style="width:370px;border:1px solid #333;border-radius:8px" src="data:image/png;base64,' + c.png + '"><div style="margin-top:8px">' + c.name + "</div></div>").join("") + "</body>");
    await cmp.screenshot({ path: join(out, "main-icon-options.png") });
    await cmp.close();
    await page.evaluate((h) => { document.querySelector('[data-el="thread-main"] .mainico').innerHTML = h; }, OPTS["message-circle"]);
  }
  await page.mouse.click(width - 20, 400);
  await page.waitForTimeout(700);
  if (tag !== "before") {
    // "+": a PDF picked (the iOS Files path: the one input, any type) — a chip in the composer.
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    await page.setInputFiles("#imgInput", { name: "Discussion 5 notes.pdf", mimeType: "application/pdf", buffer: pdf });
    await page.waitForSelector("#pendImgs .pfile.ready", { timeout: 8000 });
    await shot("attach");
    // Sent: the files go by their box path (files[]), the bubble shows the chip.
    await page.evaluate(() => { const f = window.fetch; window.__sent = []; window.fetch = (u, o) => { if (String(u).includes("/api/v2/intent")) window.__sent.push(JSON.parse(o.body)); return f(u, o); }; });
    await page.fill("#input", "What's on page 2?");
    await page.tap("#sendBtn");
    await page.waitForSelector("#msgs .m.user .mfile", { timeout: 8000 });
    await page.waitForTimeout(800);
    await shot("sent");
    const sent = await page.evaluate(() => window.__sent);
    writeFileSync(join(out, `${width}-sent-intent-${tag}.json`), JSON.stringify(sent, null, 1));
    if (!sent.length || !sent[0].files?.[0]?.startsWith(".vault-chat/attachments/")) throw new Error("the send did not carry the box path: " + JSON.stringify(sent));
    // Clear: one tap in the bar.
    await page.tap("#clearBtn");
    await page.waitForTimeout(400);
    await shot("cleared");
  }
  writeFileSync(join(out, `${width}-log-${tag}.json`), JSON.stringify(log, null, 1));
  await browser.close();
}
console.log("shots →", out);
