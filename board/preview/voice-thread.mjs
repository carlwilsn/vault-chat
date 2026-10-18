// Voice on the board keeps ONE conversation (board/src/voice.ts), in WebKit as Carl's iPad (Mac UA, touch): the
// mic is tapped, a line is said (the box saves it as a voice conversation), the call drops from the other side
// (the pill turns red with the reason, the board's log says who closed it and why), the mic is tapped again —
// and the call, its lines and the next restart all stay in that same conversation on the box. Then a reload.
// The ElevenLabs SDK is the preview's fake (?voice=fake); the list of chats and the saved lines are the box's.
//
//   npx tsx board/preview/box.ts 7442 &  ;  VC_BOX=http://127.0.0.1:7442 npm run dev:board
//   PLAYWRIGHT_CORE=preview/node_modules/playwright-core node board/preview/voice-thread.mjs [board url] [box url]
import { ipadPage, checker } from "./ipad.mjs";

const url = process.argv[2] ?? "http://localhost:1431/board/";
const box = process.argv[3] ?? "http://127.0.0.1:7442";
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

const conversations = async () => (await (await fetch(`${box}/conversations`)).json()).conversations ?? [];
const conversation = async (id) => (await fetch(`${box}/conversation?id=${encodeURIComponent(id)}&n=200`)).json();
const lines = (c) => (c.messages ?? []).filter((m) => !m.system).map((m) => m.content);

await page.goto(url);
await page.evaluate(() => localStorage.clear());
const slug = await page.evaluate(async () => (await (await fetch("/api/v1/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Voice ${Date.now() % 100000}` }) })).json()).slug);
const open = async () => {
  await page.goto("about:blank");
  await page.goto(`${url}?voice=fake#/b/${slug}`);
  await page.waitForFunction(() => !!window.__board?.debug && !!window.__voice);
};
await open();
const before = await conversations();
const voiceBefore = new Set(before.filter((c) => c.source === "voice").map((c) => c.id));
// The first start continues the most recent chat: a voice conversation goes on as it is; any other gets one of its own.
const recent = before.filter((c) => !["ask", "worker", "mission"].includes(c.source)).sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0];
const newVoice = recent?.source === "voice" ? 0 : 1;

const tapMic = async () => {
  const b = await page.locator('[data-act="voice"]').boundingBox();
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
};
const phase = () => page.evaluate(() => window.__voice.state.phase);
const waitPhase = (p) => page.waitForFunction((x) => window.__voice.state.phase === x, p, { timeout: 8000 });
const thread = () => page.evaluate(() => window.__voice.thread);
const say = (role, text) => page.evaluate(([r, t]) => window.__voiceFake.say(r, t), [role, text]);

// ---- start, a line, its conversation
await tapMic();
await waitPhase("live");
check((await phase()) === "live", "a tap on the mic: live");
await say("user", "Can you see what's on my board?");
await say("agent", "Yes, an empty board.");
await page.waitForFunction(() => !!window.__voice.thread, null, { timeout: 5000 }).catch(() => {});
const t1 = await thread();
const made = (await conversations()).filter((c) => c.source === "voice" && !voiceBefore.has(c.id));
check(!!t1 && made.length === newVoice && t1 === (newVoice ? made[0].id : recent.id), newVoice ? "the first line made one voice conversation, and it is the board's thread" : "the first start went on in the most recent chat (a voice conversation), now the board's thread", JSON.stringify({ t1, recent: recent?.id, made: made.map((c) => c.id) }));
check((await page.evaluate(() => window.__voice.state.chat?.id)) === t1, "the pill names that conversation");

// ---- the call drops from the other side
await page.evaluate(() => window.__voiceFake.drop("pc connection lost"));
await waitPhase("error");
const red = await page.locator('[data-voice="error"] .v-reason').textContent();
check(/Voice disconnected \(pc connection lost\)\. Tap the mic to go on with this chat\./.test(red ?? ""), "the drop is said, with its reason", red);

// ---- the mic again: the same conversation
await tapMic();
await waitPhase("live");
check((await thread()) === t1, "the restart continues the same conversation", await thread());
check((await page.evaluate(() => window.__voice.state.chat?.id)) === t1, "…and the pill still names it");
await say("user", "Hello, can you hear me?");
await page.waitForTimeout(800);
const after = (await conversations()).filter((c) => c.source === "voice" && !voiceBefore.has(c.id));
check(after.length === newVoice, "no second voice conversation was made", JSON.stringify(after.map((c) => c.id)));
const c1 = await conversation(t1);
check(["Can you see what's on my board?", "Yes, an empty board.", "Hello, can you hear me?"].every((l) => lines(c1).includes(l)), "both sessions' lines are in that one conversation", JSON.stringify(lines(c1)));

// ---- ended with the mic, a reload, the mic: still the same
await tapMic();
await waitPhase("idle");
await open();
await tapMic();
await waitPhase("live");
check((await thread()) === t1, "after a reload the mic continues the same conversation", await thread());
await say("user", "Still here.");
await page.waitForTimeout(800);
check(lines(await conversation(t1)).includes("Still here."), "…and its lines go on there");
check((await conversations()).filter((c) => c.source === "voice" && !voiceBefore.has(c.id)).length === newVoice, "…still one voice conversation");
await tapMic();
await waitPhase("idle");

// ---- the log says who closed each session and why
// Leaving the page sends what the log holds (pagehide).
await page.goto("about:blank");
await page.waitForTimeout(800);
const closes = logged.filter((e) => e.ev === "voice.close");
check(closes.some((e) => e.by === "remote" && e.reason === "error" && e.message === "pc connection lost" && e.code === 1006 && e.conv === t1), "voice.close: the drop, from the other side, with its reason and code", JSON.stringify(closes));
check(closes.filter((e) => e.by === "mic").length >= 2, "voice.close: the mic's ends");

await browser.close();
console.log(failed() ? `${failed()} check(s) failed` : "all checks passed");
process.exit(failed() ? 1 : 0);
