// Screenshots of the chat composer while the agent works and of an attached
// outside file (preview/scenarios/steer.ts), in the muted preview browser, each
// with the measured state it shows. → preview-proof/midturn/ (shots + result.json)
//   node preview/tools/midturn-shots.mjs [--url http://127.0.0.1:1520/before]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "./browser.mjs";

const argv = process.argv.slice(2);
const at = argv.indexOf("--url");
const origin = at >= 0 ? argv[at + 1] : "http://127.0.0.1:1520/before";
const out = join(process.cwd(), "preview-proof", "midturn");
mkdirSync(out, { recursive: true });
const results = [];
const fail = [];

async function open(id) {
  const { browser, page, log } = await launch({ width: 1100, height: 800 });
  await page.goto(`${origin}/?scenario=${id}&side=before&narrate=0&overlay=0`, { timeout: 240000, waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__preview?.stepsDone, null, { timeout: 240000 });
  await page.waitForTimeout(700);
  return { browser, page, log };
}

const intentsOf = (page) => page.evaluate(() => window.__preview.boxPosts().map((p) => ({ url: p.path, body: p.body ?? {} })));

const button = (page) =>
  page.evaluate(() => ({
    send: !!document.querySelector('[data-el="composer-send"]'),
    stop: !!document.querySelector('[data-el="composer-stop"]'),
    sendDisabled: document.querySelector('[data-el="composer-send"]')?.disabled ?? null,
    placeholder: document.querySelector("textarea[placeholder]")?.getAttribute("placeholder"),
  }));

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) fail.push(name);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
}

// 1. Mid-turn, text typed: Send.
{
  const { browser, page } = await open("steer-typing");
  const b = await button(page);
  check("mid-turn with text: the button is Send", b.send && !b.stop && b.sendDisabled === false && !/steer|queue/i.test(b.placeholder ?? ""), b);
  await page.screenshot({ path: join(out, "1-midturn-text-send.png") });
  await browser.close();
}
// 2. Mid-turn, empty: Stop; Esc stops.
{
  const { browser, page } = await open("steer-empty");
  const b = await button(page);
  check("mid-turn, empty: the button is Stop", b.stop && !b.send, b);
  await page.screenshot({ path: join(out, "2-midturn-empty-stop.png") });
  await page.focus("textarea[placeholder]");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  const types = (await intentsOf(page)).map((p) => p.body.type);
  check("Esc stops", types.includes("stop"), { types });
  await browser.close();
}
// 3. A message sent mid-turn: in the thread at once, pending; Send now on hover.
{
  const { browser, page } = await open("steer-sent");
  const st = await page.evaluate(() => {
    const w = document.querySelector('[data-el="waiting-message"]');
    return {
      waiting: w?.textContent ?? null,
      mark: !!w?.querySelector('[data-el="waiting-mark"]'),
      chips: !!document.querySelector('[data-el="pending-chips"]'),
      composerEmpty: document.querySelector("textarea[placeholder]")?.value === "",
    };
  });
  check("a message sent mid-turn shows as sent, marked pending, no chip above the composer", !!st.waiting?.includes("Only look in the courses folder.") && st.mark && !st.chips && st.composerEmpty, st);
  await page.screenshot({ path: join(out, "3-midturn-message-pending.png") });
  const hidden = await page.evaluate(() => getComputedStyle(document.querySelector('[data-el="waiting-actions"]')).opacity);
  await page.hover('[data-el="waiting-message"] .rounded-2xl');
  await page.waitForTimeout(400);
  const vis = await page.evaluate(() => getComputedStyle(document.querySelector('[data-el="waiting-actions"]')).opacity);
  check("Send now / Edit / Cancel: hidden until hover", hidden === "0" && vis === "1", { before: hidden, onHover: vis });
  await page.screenshot({ path: join(out, "4-hover-send-now.png") });
  await page.click('[data-el="send-now"]');
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({
    waiting: !!document.querySelector('[data-el="waiting-message"]'),
    stopped: document.body.innerText.includes("Stopped."),
    last: [...document.querySelectorAll(".prose-user")].map((e) => e.textContent).at(-1),
  }));
  const types = (await intentsOf(page)).map((p) => p.body.type);
  check("Send now: delivered at once as the next turn (no Stopped line)", !after.waiting && types.includes("now") && !after.stopped && !!after.last?.includes("Only look in the courses folder."), { ...after, types });
  await page.screenshot({ path: join(out, "5-after-send-now.png") });
  await browser.close();
}
// 4. Taken at the next step: an ordinary message.
{
  const { browser, page } = await open("steer-delivered");
  const st = await page.evaluate(() => ({
    waiting: !!document.querySelector('[data-el="waiting-message"]'),
    users: [...document.querySelectorAll(".prose-user")].map((e) => e.textContent),
    answered: document.body.innerText.includes("Sticking to courses/"),
  }));
  check("delivered at the next step: an ordinary message, answered", !st.waiting && st.users.some((u) => u.includes("Only look in the courses folder.")) && st.answered, st);
  await page.screenshot({ path: join(out, "6-delivered.png") });
  await browser.close();
}
// 5. An outside PDF attached: chip in the composer; sent, bytes uploaded, the box's path in the message.
{
  const { browser, page } = await open("attach-outside");
  const chip = await page.evaluate(() => document.querySelector('[data-el="attached-file"]')?.textContent ?? null);
  check("the outside PDF is a chip in the composer", !!chip?.includes("Discussion_5_Supplementary Notes.pdf"), { chip });
  await page.screenshot({ path: join(out, "7-attach-chip.png") });
  await page.click('[data-el="composer-send"]');
  await page.waitForTimeout(1500);
  const posts = await intentsOf(page);
  const up = posts.find((p) => p.url.includes("/api/v2/attachment"));
  const intent = posts.find((p) => p.body.type === "send");
  const bubbleFile = await page.evaluate(() => document.querySelector('[data-el="message-files"]')?.textContent ?? null);
  const sent = {
    uploaded: up ? { name: up.body.name, bytes: Math.floor((up.body.dataBase64?.length ?? 0) * 0.75) } : null,
    files: intent?.body.files ?? null,
    text: intent?.body.text ?? null,
    laptopPathSent: JSON.stringify(intent?.body ?? {}).includes("Downloads"),
    bubbleFile,
  };
  check(
    "sent: the bytes go to the box, the message names the box path, no laptop path",
    sent.uploaded?.name === "Discussion_5_Supplementary Notes.pdf" && sent.uploaded.bytes > 100 && /^\.vault-chat\/attachments\/.+Discussion_5_Supplementary Notes\.pdf$/.test(sent.files?.[0] ?? "") && !sent.laptopPathSent && !!bubbleFile,
    sent,
  );
  // The agent's answer: scripted here (the fake box); the real box reading the PDF is server/test/attachments.test.ts.
  await page.evaluate(async (conv) => {
    window.__preview.boxPlay({
      log: (box) => {
        box.tool(conv, "pdf-1", "PdfRead", { path: "/home/carl/vault/.vault-chat/attachments/2026-10-13/Discussion_5_Supplementary Notes.pdf" }, "Page 1 of 1:\nGauss law: the flux through a closed surface is Q over epsilon zero.");
        box.say(conv, "It states Gauss's law: the electric flux through any closed surface equals the enclosed charge over epsilon zero.\n\n$$\\oint \\mathbf{E}\\cdot d\\mathbf{A} = \\frac{Q_{enc}}{\\varepsilon_0}$$");
        box.endTurn(conv);
      },
    });
  }, intent?.body.convId);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, "8-attach-answered.png") });
  await browser.close();
}

writeFileSync(join(out, "result.json"), JSON.stringify({ origin, results, ok: fail.length === 0 }, null, 2));
console.log(fail.length ? `FAILED: ${fail.join("; ")}` : "all passed");
process.exit(fail.length ? 1 : 0);
