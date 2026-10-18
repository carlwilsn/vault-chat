// What the chat shows is the box's feed, in its order, on every frame (Carl:
// "the order of messages is fucked up"). The real page, conv-a's world (a box
// vault), the fake box (src/convlog/memoryBox.ts: pi's entries and live events)
// driven through one whole turn: Carl's message, thinking, two tool calls in
// parallel, a steer while they run (delivered by pi after them), a reply that
// streams through an outage (the box unreachable, then back: the client resumes
// from its cursor) and a box restart (its pollers cut), then lands. Every
// animation frame records where each piece is in the chat; the check fails if
// on any frame two pieces are in a different order than the feed's, if a piece
// shown on one frame is gone from the next, or if the last frame is not the
// feed exactly.
//   node preview/tools/order-check.mjs [--url http://127.0.0.1:1700/before]
// Needs the preview server running.
import { launch, sideBase } from "./browser.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const base = opt("url", null) ?? (await sideBase(1600));
const C = "x-full";
// One marker per piece (the order the feed must have them in).
const PIECES = ["ORDASK", "ORDTHINK", "papers/ord-a.md", "papers/ord-b.md", "ORDSTEER", "ORDREPLY"];

const { browser, page, log } = await launch({ width: 1400, height: 900 });
let failed = 0;
try {
  await page.goto(`${base}/?scenario=conv-a&side=before&narrate=0&steps=0`, { timeout: 180000 });
  await page.waitForFunction(() => window.__preview?.ready, null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.keyboard.press("Control+Shift+F");
  await page.waitForSelector("[data-el='chats-sidebar']");
  await page.evaluate(() => window.__preview.play(0)); // open the conversation
  await page.waitForTimeout(1500);

  // The page's own modules: the chat controller (Carl's keys) and the fake box.
  await page.evaluate(async () => {
    const find = (re) => performance.getEntriesByType("resource").map((e) => e.name).find((n) => re.test(n));
    const w = window;
    w.__chat = await import(find(/\/src\/chat-controller\.ts/));
    w.__host = await import(find(/\/runtime\/backend\/host\.ts/));
    w.__store = (await import(find(/\/src\/store\.ts/))).useStore;
  });

  // The recorder: on every frame, where each piece is in the chat (its last occurrence: the thread, not the list's title).
  await page.evaluate((PIECES) => {
    const w = window;
    w.__frames = [];
    const tick = () => {
      // The live tool ticker (one running call at a time, "n/total") is a status line, not the thread: left out.
      let text = document.body.textContent ?? "";
      for (const tk of document.querySelectorAll("[data-el='live-tool']")) {
        const r = document.createRange();
        r.setStart(document.body, 0);
        r.setEndBefore(tk);
        const off = r.toString().length;
        const len = (tk.textContent ?? "").length;
        text = text.slice(0, off) + " ".repeat(len) + text.slice(off + len);
      }
      const at = Object.fromEntries(PIECES.map((p) => [p, text.lastIndexOf(p)]).filter(([, i]) => i >= 0));
      const key = JSON.stringify(Object.keys(at).sort((a, b) => at[a] - at[b]));
      const prev = w.__frames.at(-1);
      if (!prev || prev.key !== key) w.__frames.push({ t: Math.round(performance.now()), key, order: JSON.parse(key) });
      if (w.__store?.getState().boxChat?.reachable === false) w.__wasDown = true;
      w.__raf = requestAnimationFrame(tick);
    };
    tick();
  }, PIECES);

  const box = (fn, arg) => page.evaluate(({ src, arg, C }) => new Function("box", "C", "arg", src)(window.__host.fakeBoxLog(), C, arg), { src: fn, arg, C });
  const play = (st) => page.evaluate((x) => window.__host.boxPlay(x), st);
  const wait = (ms) => page.waitForTimeout(ms);

  // Carl asks (his message shows at once, then the box's echo takes its place).
  await page.evaluate(() => window.__chat.sendMessage("ORDASK: compare the two KV-cache papers."));
  await wait(800);
  // Thinking, streamed.
  await box(`const b = box.open(C, "thinking"); globalThis.__th = b; b.delta("ORDTHINK two papers, ");`);
  await wait(400);
  await box(`globalThis.__th.delta("compare their memory."); globalThis.__th.end();`);
  await wait(400);
  // Two tool calls in parallel.
  await box(`box.tool(C, "ord_a", "read", { path: "papers/ord-a.md" }); box.tool(C, "ord_b", "read", { path: "papers/ord-b.md" });`);
  await wait(600);
  // Carl steers while they run.
  await page.evaluate(() => window.__chat.sendMidTurn("steer", "ORDSTEER only the 4-bit results."));
  await wait(600);
  await box(`box.toolDone(C, "ord_a", "paper A text");`);
  await wait(300);
  await box(`box.toolDone(C, "ord_b", "paper B text");`);
  // pi delivers the steer after the tool calls.
  await box(`const s = box.intents.filter((x) => x.type === "steer").at(-1); box.deliver(C, s.clientId);`);
  await wait(500);
  // The reply streams…
  await box(`const r = box.open(C, "assistant"); globalThis.__reply = r; r.delta("ORDREPLY at 4 bits, ");`);
  await wait(800);
  // …the box goes away, the turn goes on, it comes back (the client resumes from its cursor)…
  await play({ down: true });
  await wait(2500);
  await box(`globalThis.__reply.delta("A keeps perplexity within 0.05; ");`);
  await wait(1000);
  await play({ down: false });
  await wait(3500);
  // …the box restarts (its pollers cut), and the turn finishes.
  await play({ restart: true });
  await box(`globalThis.__reply.delta("B loses 0.3."); globalThis.__reply.end(); box.endTurn(C);`);
  await wait(4000);

  const frames = await page.evaluate(() => {
    cancelAnimationFrame(window.__raf);
    return window.__frames;
  });
  const wasDown = await page.evaluate(() => !!window.__wasDown);
  const shownLast = await page.evaluate(() => window.__store.getState().messages.map((m) => m.content).join(" | "));
  if (argv.includes("--frames")) for (const f of frames) console.log(f.t, f.order.join(" < "));
  const rank = new Map(PIECES.map((p, i) => [p, i]));
  const bad = [];
  frames.forEach((f, i) => {
    for (let k = 1; k < f.order.length; k++) if (rank.get(f.order[k]) < rank.get(f.order[k - 1])) bad.push(`frame ${i} (${f.t} ms): ${f.order[k - 1]} before ${f.order[k]}`);
    if (i > 0) for (const p of frames[i - 1].order) if (!f.order.includes(p)) bad.push(`frame ${i} (${f.t} ms): ${p} disappeared`);
  });
  const last = frames.at(-1)?.order ?? [];
  const checks = [
    ["frames recorded", frames.length > 5, `${frames.length}`],
    ["the outage was seen (the box unreachable, then back)", wasDown, ""],
    ["every frame in the feed's order, nothing shown ever disappeared", bad.length === 0, bad.slice(0, 8).join("\n       ")],
    ["the last frame is the whole turn, in the feed's order", JSON.stringify(last) === JSON.stringify(PIECES), last.join(" < ")],
    ["the reply landed whole", /ORDREPLY at 4 bits, A keeps perplexity within 0\.05; B loses 0\.3\./.test(shownLast), ""],
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
