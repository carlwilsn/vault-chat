// Nothing shown in the chat ever disappears (Carl: "chat replies sometimes
// disappear and then pop back"). The real page, the conv-a world (a box vault),
// the fake box played the way the real one behaves: its /conversation reads the
// file (status "idle" through the run, the reply landing in the file after its
// event, answers 250 ms late), a mid-turn re-read, a box restart in the middle
// of the turn (a forced resync) and the git sync merging an older copy of the
// conversation file. Every animation frame records the texts the chat shows
// (Carl's bubbles, the replies, the live stream); the check fails if a text on
// one frame is gone from the next.
//   node preview/tools/noflicker-check.mjs [--url http://127.0.0.1:1600/before] [--panel]
// Needs the preview server running.
import { launch, sideBase } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const base = opt("url", null) ?? (await sideBase(1600));
const panel = argv.includes("--panel");
const C = "x-full";

const { browser, page, log } = await launch({ width: 1400, height: 900 });
let failed = 0;
try {
  await page.goto(`${base}/?scenario=conv-a&side=before&narrate=0&steps=0`);
  await page.waitForFunction(() => window.__preview?.ready, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  if (!panel) {
    await page.keyboard.press("Control+Shift+F");
    await page.waitForSelector("[data-el='chats-sidebar']");
  }
  await page.evaluate(() => window.__preview.play(0)); // open the conversation
  await page.waitForTimeout(1500);

  const store = await page.evaluateHandle(async () => {
    const url = performance.getEntriesByType("resource").map((e) => e.name).find((n) => /\/src\/store\.ts/.test(n));
    return (await import(url)).useStore;
  });
  // The conversation file as this disk has it before the turn (what the sync brings back later).
  const older = await page.evaluate(
    ({ s, C }) => {
      const st = s.getState();
      const c = st.conversations.find((x) => x.id === C);
      const msgs = (st.activeConversationId === C ? st.messages : c.messages).filter((m) => !m.boxPending && !m.boxLocal);
      const meta = { id: C, title: c.title, createdAt: c.createdAt, lastActivityAt: c.lastActivityAt + 1, source: c.source, status: "idle" };
      return [JSON.stringify(meta), ...msgs.map((m) => JSON.stringify(m))].join("\n") + "\n";
    },
    { s: store, C },
  );

  // The recorder: every frame, the texts the chat shows.
  await page.evaluate(() => {
    const w = window;
    w.__frames = [];
    const norm = (t) => t.replace(/\s+/g, " ").replace(/^…/, "").trim();
    const tick = () => {
      const texts = [...document.querySelectorAll(".prose-user, .prose-chat")].map((e) => norm(e.textContent ?? "")).filter(Boolean);
      const prev = w.__frames.at(-1);
      if (!prev || prev.texts.join("\u0001") !== texts.join("\u0001")) w.__frames.push({ t: Math.round(performance.now()), texts });
      w.__raf = requestAnimationFrame(tick);
    };
    tick();
  });

  const play = (st) => page.evaluate((x) => window.__preview.boxPlay(x), st);
  const wait = (ms) => page.waitForTimeout(ms);
  const ASK = "Does the 4-bit cache change the eval numbers at 32k?";
  const REPLY = "No: the survey reports perplexity within 0.05 of the full cache up to 32k tokens, so the eval numbers stay where they are. The kernel change is local and the harness does not move.";
  const rt = (text, prev = "") => ({ type: "runtime", convId: C, text, offset: prev.length, delta: text.slice(prev.length), len: text.length, tool: "", steps: [] });
  const umid = "m_nf_user";
  const amid = "m_nf_reply";

  // The real box's file: status idle through the run, answers a beat late.
  await play({ fileIdle: true, detailDelayMs: 250 });
  // Carl's turn: on the box, running.
  await play({
    append: { [C]: [{ role: "user", content: ASK, mid: umid }] },
    status: { [C]: "running" },
    events: [{ type: "status", convId: C, status: "running" }, { type: "message", convId: C, role: "user", content: ASK, mid: umid, tools: [] }],
  });
  await wait(900);
  // The reply streams in pieces; a meta change mid-turn re-reads the thread.
  let sent = "";
  const cuts = [24, 60, 95];
  for (const n of cuts) {
    const t = REPLY.slice(0, n);
    await play({ events: [rt(t, n === cuts[0] ? "" : sent)] });
    sent = t;
    await wait(350);
    if (n === 60) await play({ events: [{ type: "meta", convId: C }] });
  }
  // The box restarts mid-turn (a self-update): the laptop resyncs whole.
  await play({ restart: true });
  await wait(3500);
  // The turn goes on in the new process; then the reply is stored: its event
  // now, the file 600 ms later.
  await play({ events: [rt(REPLY.slice(0, 140))] });
  await wait(400);
  await play({ status: { [C]: "idle" }, events: [{ type: "message", convId: C, role: "assistant", content: REPLY, mid: amid, tools: [] }, { type: "status", convId: C, status: "idle" }] });
  await wait(600);
  await play({ append: { [C]: [{ role: "assistant", content: REPLY, mid: amid }] } });
  await wait(1200);
  // The git sync merges the box's older copy of the conversation file in.
  await play({ merge: { [`.vault-chat/conversations/${C}.jsonl`]: older }, events: [{ type: "vault_changed" }] });
  await wait(3000);

  const frames = await page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__frames;
  });
  if (argv.includes("--frames")) for (const f of frames) console.log(f.t, f.texts.length, f.texts.slice(-3).map((x) => x.slice(0, 50)).join(" | "));
  const gone = [];
  for (let i = 1; i < frames.length; i++) {
    for (const t of frames[i - 1].texts) {
      const probe = t.slice(-120);
      if (!frames[i].texts.some((x) => x.includes(probe))) gone.push(`${frames[i].t} ms: "${t.slice(0, 70)}" gone (frame ${i}/${frames.length})`);
    }
  }
  const last = frames.at(-1)?.texts ?? [];
  const shownOnce = (s) => last.filter((x) => x.includes(s)).length === 1;
  const checks = [
    ["frames recorded", frames.length > 5, `${frames.length}`],
    ["nothing shown ever disappeared", gone.length === 0, gone.slice(0, 6).join("\n       ")],
    ["Carl's message shown once at the end", shownOnce(ASK), ""],
    ["the reply shown once at the end", shownOnce(REPLY.slice(-60)), ""],
  ];
  for (const [what, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  }
} finally {
  await browser.close();
}
const errs = log.console.filter((m) => m.type === "error").concat(log.pageErrors);
for (const e of errs) console.log(`  console: ${String(e.text).split("\n")[0].slice(0, 200)}`);
process.exit(failed ? 1 : 0);
