// The full test conversation, checked (preview/scenarios/convFull.ts): loads
// conv-a (laptop with a box), conv-b (laptop local) and conv-c (phone) — and
// their second-option twins — plays each stage, and asserts in the DOM that
// every element rendered, nothing twice, and no console errors. Screenshots
// per stage → preview-proof/.
//   node preview/conv-check.mjs [--only conv-a,conv-c] [--url http://127.0.0.1:1521/after]
// Needs the preview running (npm run preview), like test.mjs.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./tools/browser.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "preview-proof");
mkdirSync(OUT, { recursive: true });
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const ORIGIN = opt("url", process.env.PREVIEW_AFTER ?? "http://127.0.0.1:1521/after");
const ONLY = (opt("only", "") ?? "").split(",").filter(Boolean);
const ALLOWED = [/Download the React DevTools/];

const FIRST = "Here is the KV-cache section, written for the writeup.";
const LAST = "That is the whole section; the table and the bound are what the writeup needs.";

let fails = 0;
let passes = 0;
const results = [];
function check(run, name, ok, detail = "") {
  results.push({ run, name, ok: !!ok, detail });
  if (ok) passes++;
  else fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${run.padEnd(11)} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

/** Everything the DOM shows that the checks look at, in one read. */
async function snapshot(page) {
  return page.evaluate(() => {
    const qa = (s) => [...document.querySelectorAll(s)];
    const text = (s) => qa(s).map((e) => e.textContent ?? "");
    const dial = qa("[title^='Context:']")[0]?.getAttribute("title") ?? "";
    return {
      divider: qa("[data-el='divider']").length,
      dividerText: text("[data-el='divider']").join(" "),
      thinking: qa("[data-el='thinking']").length,
      thinkingLive: /Thinking…/.test(document.body.innerText),
      toggle: qa("[data-el='thinking-toggle']").length,
      toolCalls: text("[data-el='tool-calls'] summary"),
      legacySubagentRecords: qa("[data-el='tool-calls'] .text-primary").filter((e) => e.textContent === "Subagent").length,
      todos: text("[data-el='todos']"),
      todosPinned: qa("[data-el='todos-pinned']").length,
      subagents: qa("[data-el='subagent']").map((e) => ({ sid: e.getAttribute("data-sid"), state: e.getAttribute("data-state"), text: e.textContent })),
      subagentCards: qa("[data-el='subagents']").map((e) => e.getAttribute("data-variant")),
      stream: text("[data-el='stream']").join(""),
      tables: qa(".prose-chat table").length,
      code: qa(".prose-chat pre code").length,
      katex: qa(".prose-chat .katex").length,
      katexDisplay: qa(".prose-chat .katex-display").length,
      ask: qa("[data-el='ask-options']").map((e) => e.getAttribute("data-live")),
      askOptions: text("[data-el='ask-option']"),
      ongoing: qa("[data-ongoing]").map((e) => ({ tone: e.getAttribute("data-ongoing"), text: e.textContent })),
      verdict: text("[data-el='verdict']"),
      replyCost: text("[data-el='reply-cost']"),
      totalCost: text("[data-el='total-cost']"),
      dial,
      userImages: qa(".prose-user").length ? qa("img[alt^='captured']").length : 0,
      body: document.body.innerText,
    };
  });
}

/** The thread scrolled to its end (what was just added), then the screen. */
async function shot(page, name) {
  await page.evaluate(() => {
    const t = document.querySelector("#msgs") ?? [...document.querySelectorAll(".overflow-auto")].find((e) => e.querySelector(".prose-chat"));
    if (t) t.scrollTop = t.scrollHeight;
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

function consoleProblems(log, also = []) {
  const ok = [...ALLOWED, ...also];
  return [...log.console.filter((m) => m.type === "error" && !ok.some((r) => r.test(m.text))).map((m) => m.text.slice(0, 200)), ...log.pageErrors.map((e) => e.text.slice(0, 200))];
}

// ---------------------------------------------------------------- A / B (desktop)

async function desktop(id, alt) {
  const run = id;
  const { browser, page, log } = await launch({ width: 1400, height: 900 });
  try {
    await page.goto(`${ORIGIN}/?scenario=${id}&side=after&base=synthetic&steps=0&narrate=0`, { timeout: 30000 });
    await page.waitForFunction(() => window.__preview?.ready, null, { timeout: 30000 });
    const play = async (i) => {
      await page.evaluate((n) => window.__preview.play(n), i);
      await page.waitForTimeout(500);
    };
    const subagentsOnce = (s, stage) => {
      const ids = s.subagents.map((x) => x.sid);
      check(run, `${stage}: subagents — two, none twice, no legacy "Subagent" tool records`, ids.length === 2 && new Set(ids).size === 2 && s.legacySubagentRecords === 0, JSON.stringify(ids));
    };
    if (id.startsWith("conv-a")) {
      await play(0);
      let s = await snapshot(page);
      check(run, "roll-over: the summarized-earlier divider", s.divider === 1 && /Earlier conversation summarized/.test(s.dividerText));
      await page.click("[data-el='divider'] summary");
      s = await snapshot(page);
      check(run, "roll-over: expands to the recap", /Where we are/.test(s.dividerText));
      await shot(page, `${run}-0-rollover`);

      await play(1);
      s = await snapshot(page);
      check(run, "thinking streams live", s.thinkingLive);
      check(run, "no brain toggle", s.toggle === 0);
      check(run, "to-do list (first version) shown", alt ? s.todosPinned === 1 && /0\/4/.test(s.todos.join()) : /0\/4/.test(s.todos.join()));
      subagentsOnce(s, "spawn");
      const st = s.subagents.map((x) => x.state).sort().join(",");
      check(run, `one subagent done (${alt ? "cost, " : "no cost, "}summary), one running`, st === "completed,running" && s.subagents.some((x) => (alt ? /\$0\.09/.test(x.text) : !/\$/.test(x.text)) && /Six methods/.test(x.text)), st);
      check(run, `subagents shown ${alt ? "as the strip" : "inline"}`, s.subagentCards.length >= 1 && s.subagentCards.every((v) => v === (alt ? "strip" : "inline")), s.subagentCards.join());
      await shot(page, `${run}-1-subagents`);

      await play(2);
      s = await snapshot(page);
      check(run, "the streamed reply is whole (a 6,700-character reply keeps its start, past the old 6,000 tail)", s.stream.includes(FIRST) && s.stream.includes(LAST), `${s.stream.length} chars rendered`);
      check(run, "to-do list updated (second version)", /2\/4/.test(s.todos.join()));
      await shot(page, `${run}-2-stream`);

      await play(3);
      s = await snapshot(page);
      check(run, "markdown: a table and code", s.tables >= 1 && s.code >= 1);
      check(run, "math: inline ($ and \\(\\)) and display ($$ and \\[\\])", s.katex >= 8 && s.katexDisplay >= 2, `${s.katex} inline, ${s.katexDisplay} display`);
      check(run, "the reply keeps its thinking (the collapsed Thought line)", s.thinking >= 1 && s.toggle === 0);
      check(run, "tool calls (5, no duplicates)", s.toolCalls.some((t) => /5 tool calls/.test(t)), s.toolCalls.join(" | "));
      subagentsOnce(s, "done");
      check(run, "both subagents done", s.subagents.every((x) => x.state === "completed"));
      check(run, alt ? "to-do list updated twice; finished, it unpins" : "to-do list updated twice (4/4)", alt ? s.todosPinned === 0 && s.todos.length === 0 : /4\/4/.test(s.todos.join()), JSON.stringify(s.todos));
      check(run, alt ? "cost: the conversation total at the top, none per reply" : "no cost in the chat", alt ? s.totalCost.length === 1 && s.replyCost.length === 0 : s.totalCost.length === 0 && s.replyCost.length === 0, JSON.stringify([s.replyCost, s.totalCost]));
      check(run, `AskUser: ${alt ? "numbered buttons" : "option cards"}, live`, s.ask.length === 1 && s.ask[0] === "1" && s.askOptions.length === 2, JSON.stringify(s.ask));
      await shot(page, `${run}-3-reply-ask`);

      await play(4);
      s = await snapshot(page);
      const posts = await page.evaluate(() => window.__preview.boxPosts());
      check(run, "AskUser answered through /answer", posts.some((p) => p.path === "/answer" && p.body.text === "Only 4-bit KV"), JSON.stringify(posts.map((p) => p.path)));
      check(run, "the answer shows, the options go quiet", /Only 4-bit KV/.test(s.body) && s.ask[0] === "0");
      check(run, "sleeping: the ongoing line with its next time", s.ongoing.some((o) => o.tone === "waiting" && /next \d/.test(o.text)), JSON.stringify(s.ongoing));
      await shot(page, `${run}-4-sleeping`);

      await play(5);
      s = await snapshot(page);
      check(run, "the wake arrives", /Wake: Checking the writeup build/.test(s.body));
      check(run, "an error", /The turn failed: Provider returned error 502/.test(s.body));
      await shot(page, `${run}-5-wake-error`);

      await play(6);
      s = await snapshot(page);
      const posts2 = await page.evaluate(() => window.__preview.boxPosts());
      check(run, "retry: Carl's \"Try again\" and the reply", /Try again/.test(s.body) && /Retried: the writeup builds/.test(s.body));
      check(run, "an image sent to the box (images[] in /message) and shown", posts2.some((p) => p.path === "/message" && Array.isArray(p.body.images) && p.body.images.length === 1 && p.body.images[0].mime === "image/png") && s.userImages >= 1, `${s.userImages} image(s)`);
      check(run, `Done: the verifier's verdict ${alt ? "in the ongoing line" : "at the end of the thread"}`, s.verdict.some((v) => /Verifier passed/i.test(v) || /verifier passed/.test(v)) && (alt ? s.ongoing.some((o) => o.tone === "done") : true), JSON.stringify(s.verdict));
      const m = /Context: ([\d,]+) of ([\d,]+) tokens \((\d+)%\)/.exec(s.dial);
      check(run, "the context dial reads the box's window, near its limit", !!m && m[2] === "200,000" && Number(m[3]) >= 85, s.dial);
      check(run, alt ? "cost shown" : "no cost anywhere (ongoing line, thread)", alt ? s.totalCost.some((t) => /\$0\.52/.test(t)) : s.replyCost.length === 0 && s.totalCost.length === 0 && !s.ongoing.some((o) => /\$/.test(o.text)), JSON.stringify([s.replyCost, s.totalCost, s.ongoing]));
      subagentsOnce(s, "end");
      await shot(page, `${run}-6-done`);
    } else {
      // conv-b: laptop local
      await play(0);
      // Stage 1 streams for a while: catch it mid-stream.
      const p1 = page.evaluate(() => window.__preview.play(1));
      let mid = "";
      for (let i = 0; i < 200; i++) {
        mid = await page.evaluate(() => document.querySelector("[data-el='stream']")?.textContent ?? "");
        if (mid.length > 3000) break;
        await page.waitForTimeout(100);
      }
      check(run, "the reply streams with its start", mid.length > 3000 && mid.includes(FIRST), `${mid.length} chars rendered mid-stream`);
      await shot(page, `${run}-1-stream`);
      await p1;
      await page.waitForTimeout(600);
      let s = await snapshot(page);
      check(run, "markdown: a table and code", s.tables >= 1 && s.code >= 1);
      check(run, "math: inline ($ and \\(\\)) and display ($$ and \\[\\])", s.katex >= 8 && s.katexDisplay >= 2, `${s.katex} inline, ${s.katexDisplay} display`);
      check(run, "the reply keeps its thinking (saved with it)", s.thinking >= 1);
      check(run, "tool calls (TodoWrite ×3, Read)", s.toolCalls.some((t) => /4 tool calls/.test(t)), s.toolCalls.join(" | "));
      const llm = await page.evaluate(() => window.__preview.llm().filter((x) => x.script === "conv-first").length);
      check(run, "to-do list updated twice (3 versions, 4/4 saved on the conversation)", /4\/4/.test(s.todos.join()) && llm >= 5, `${llm} model calls`);
      await shot(page, `${run}-1-reply`);

      await play(2);
      s = await snapshot(page);
      check(run, "AskUser: option cards on the reply, live", s.ask.length === 1 && s.ask[0] === "1" && s.askOptions.length === 2, JSON.stringify(s.ask));
      check(run, "cost under the reply (OpenRouter)", s.replyCost.length >= 1, JSON.stringify(s.replyCost));
      await shot(page, `${run}-2-ask`);

      await play(3);
      s = await snapshot(page);
      check(run, "AskUser answered (the pick sent as the next message)", /Only 4-bit KV/.test(s.body) && s.ask[0] === "0" && /Going with the 4-bit section only/.test(s.body));
      const m = /\((\d+)%\)/.exec(s.dial);
      check(run, "the context dial near its limit", !!m && Number(m[1]) >= 85, s.dial);
      await shot(page, `${run}-3-context`);

      await play(4);
      s = await snapshot(page);
      check(run, "the next send summarized the earlier conversation (divider)", s.divider >= 1);
      check(run, "an error, then a retry that works", /502|upstream connect error/.test(s.body) && /Retried: the writeup builds/.test(s.body));
      await shot(page, `${run}-4-compaction-error-retry`);

      await play(5);
      s = await snapshot(page);
      check(run, "an image sent and answered", s.userImages >= 1 && /The curve looks right/.test(s.body), `${s.userImages} image(s)`);
      check(run, "cost on each OpenRouter reply", s.replyCost.length >= 4, JSON.stringify(s.replyCost));
      await shot(page, `${run}-5-image`);
    }
  } catch (e) {
    check(run, "ran to the end", false, String(e?.message ?? e).split("\n")[0]);
    await shot(page, `${run}-error`).catch(() => {});
  }
  const probs = await page.evaluate(() => (window.__preview ? { unknown: window.__preview.unknown(), refused: window.__preview.refused().map((r) => `${r.kind} ${r.url}`), stepError: window.__preview.stepError } : null)).catch(() => null);
  // conv-b's error turn is a scripted 502: the AI SDK logs its retries giving up.
  const cons = consoleProblems(log, id === "conv-b" ? [/upstream connect error or disconnect\/reset before headers/] : []);
  check(run, id === "conv-b" ? "no console errors (but the scripted 502's)" : "no console errors", cons.length === 0, cons.join(" | "));
  check(run, "nothing unfaked, refused or outbound", probs && !probs.unknown.length && !probs.refused.length && !log.outbound.length, JSON.stringify({ ...probs, outbound: log.outbound }));
  await browser.close();
}

// ---------------------------------------------------------------- C (phone)

// A 1×1 PNG (the model check's): a real image for the photo button.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function phone(id, alt) {
  const run = id;
  const { browser, page, log } = await launch({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
  try {
    await page.goto(`${ORIGIN}/phone?scenario=${id}&base=synthetic&conv=x-full&narrate=0`, { timeout: 30000 });
    await page.waitForFunction(() => window.__previewPhone?.ready && document.querySelector("#msgs .amsg"), null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const snap = () =>
      page.evaluate(() => {
        const qa = (s) => [...document.querySelectorAll(s)];
        const text = (s) => qa(s).map((e) => e.textContent ?? "");
        return {
          divider: qa("[data-el='divider']").length,
          thinking: qa("[data-el='thinking']").length,
          thinkingShown: qa("[data-el='thinking']").filter((e) => e.offsetParent !== null).length,
          subagents: qa("[data-el='subagent']").map((e) => ({ sid: e.getAttribute("data-sid"), state: e.getAttribute("data-state"), text: e.textContent })),
          subagentCards: qa("[data-el='subagents']").map((e) => e.getAttribute("data-variant")),
          todos: text("[data-el='todos']"),
          stream: text(".amsg.stream").join(""),
          streamKatex: qa(".amsg.stream .katex").length,
          tables: qa("#msgs table").length,
          code: qa("#msgs pre code").length,
          katex: qa("#msgs .katex").length,
          katexDisplay: qa("#msgs .katex-display").length,
          steps: text(".steps-h"),
          options: qa(".delib-opt.inline").map((e) => ({ t: e.textContent, dead: e.classList.contains("dead"), chosen: e.classList.contains("chosen") })),
          ongoing: document.querySelector("#ongoing")?.textContent ?? "",
          ongoingVerdict: !!document.querySelector("#ongoing[data-el='verdict']"),
          verdict: text("[data-el='verdict']"),
          replyCost: text("[data-el='reply-cost']"),
          totalCost: text("[data-el='total-cost']"),
          userImages: qa(".m.user .mimgs img").length,
          body: document.body.innerText,
        };
      });
    const next = async (n = 1, ms = 1200) => {
      for (let i = 0; i < n; i++) {
        await page.evaluate(() => window.__vcPhoneNext());
        await page.waitForTimeout(ms);
      }
    };
    const send = async (t) => {
      await page.fill("#input", t);
      await page.tap("#sendBtn");
      await page.waitForTimeout(700);
    };
    const subagentsOnce = (s, stage) => {
      const ids = s.subagents.map((x) => x.sid);
      check(run, `${stage}: subagents — two, none twice`, ids.length === 2 && new Set(ids).size === 2, JSON.stringify(ids));
    };

    let s = await snap();
    check(run, "roll-over: the summarized-earlier divider", s.divider === 1);
    await page.tap("[data-el='divider'] .xh");
    await page.waitForTimeout(300);
    check(run, "roll-over: expands to the recap", await page.evaluate(() => /Where we are/.test(document.querySelector("[data-el='divider']")?.textContent ?? "")));
    await shot(page, `${run}-0-rollover`);

    await send("Write the KV-cache section for the writeup from the attention survey — the methods, a table, and the math for the 4-bit cache.");
    await next(3);
    s = await snap();
    check(run, `to-do list (first version) ${alt ? "pinned above the composer" : "in the thread"}`, /0\/4/.test(s.todos.join()) && (alt ? await page.evaluate(() => !!document.querySelector("#pinned [data-el='todos']")) : true));
    subagentsOnce(s, "spawn");
    check(run, `one subagent done (${alt ? "cost, " : "no cost, "}summary), one running`, s.subagents.map((x) => x.state).sort().join() === "completed,running" && s.subagents.some((x) => (alt ? /\$0\.09/.test(x.text) : !/\$/.test(x.text)) && /Six methods/.test(x.text)));
    check(run, `subagents shown ${alt ? "as the strip" : "inline"}`, s.subagentCards.length >= 1 && s.subagentCards.every((v) => v === (alt ? "strip" : "inline")), s.subagentCards.join());
    await shot(page, `${run}-1-subagents`);

    await next(1);
    s = await snap();
    check(run, "the streamed reply is whole (a 6,700-character reply keeps its start, past the old 6,000 tail)", s.stream.includes(FIRST) && s.stream.includes(LAST), `${s.stream.length} chars rendered`);
    check(run, "math typeset while streaming", s.streamKatex >= 8, `${s.streamKatex}`);
    check(run, "to-do list updated (second version)", /2\/4/.test(s.todos.join()), JSON.stringify(s.todos));
    await shot(page, `${run}-2-stream`);

    await next(1);
    s = await snap();
    check(run, "markdown: a table and code", s.tables >= 1 && s.code >= 1);
    check(run, "math: inline ($ and \\(\\)) and display ($$ and \\[\\])", s.katex >= 8 && s.katexDisplay >= 2, `${s.katex} inline, ${s.katexDisplay} display`);
    check(run, "the reply keeps its thinking (the collapsed Thought pill)", s.thinking >= 1 && s.thinkingShown >= 1);
    check(run, "no Show thinking row in the menu", await page.evaluate(() => !document.getElementById("thinkRow")));
    check(run, "tool calls (5 steps)", s.steps.some((t) => /5 steps/.test(t)), s.steps.join(" | "));
    subagentsOnce(s, "done");
    check(run, alt ? "to-do list updated twice; finished, it unpins" : "to-do list updated twice (4/4)", alt ? s.todos.length === 0 : /4\/4/.test(s.todos.join()), JSON.stringify(s.todos));
    check(run, alt ? "cost: the total in the header" : "no cost in the chat", alt ? s.totalCost.length === 1 && s.replyCost.length === 0 : s.totalCost.length === 0 && s.replyCost.length === 0, JSON.stringify([s.replyCost, s.totalCost]));
    await shot(page, `${run}-3-reply`);

    await next(1);
    s = await snap();
    check(run, "AskUser: option cards, live", s.options.length === 2 && s.options.every((o) => !o.dead));
    await page.tap(".delib-opt.inline[data-ans='Only 4-bit KV']");
    await page.waitForTimeout(700);
    const posts = await page.evaluate(() => window.__vcPhonePosts.filter((p) => /\/message/.test(p.url)).map((p) => p.body.text));
    check(run, "AskUser answered (the pick sent)", posts.includes("Only 4-bit KV"), JSON.stringify(posts));
    await next(1);
    s = await snap();
    check(run, "sleeping: the ongoing line with its next time", /next \d/.test(s.ongoing), s.ongoing);
    await shot(page, `${run}-4-sleeping`);

    await next(2);
    s = await snap();
    check(run, "the wake arrives", /Wake: Checking the writeup build/.test(s.body));
    check(run, "an error", /The turn failed: Provider returned error 502/.test(s.body));
    await send("Try again");
    await next(1);
    s = await snap();
    check(run, "retry: Carl's \"Try again\" and the reply", /Retried: the writeup builds/.test(s.body));
    await shot(page, `${run}-5-error-retry`);

    await page.setInputFiles("#imgInput", { name: "loss.png", mimeType: "image/png", buffer: PNG });
    await page.waitForTimeout(600);
    const pend = await page.evaluate(() => document.querySelectorAll("#pendImgs img").length);
    check(run, "a photo picked shows above the composer", pend === 1);
    await send("Does this loss curve look right?");
    const imgPosts = await page.evaluate(() => window.__vcPhonePosts.filter((p) => /\/message/.test(p.url) && Array.isArray(p.body.images) && p.body.images.length).map((p) => p.body.images[0].mime));
    s = await snap();
    check(run, "an image sent (images[] in /message) and shown", imgPosts.length === 1 && s.userImages >= 1, JSON.stringify(imgPosts));
    await next(1);
    s = await snap();
    check(run, `Done: the verifier's verdict ${alt ? "in the ongoing line" : "at the end of the thread"}`, alt ? s.ongoingVerdict && /verifier passed/.test(s.ongoing) : s.verdict.some((v) => /verifier passed/.test(v)), JSON.stringify([s.verdict, s.ongoing]));
    check(run, alt ? "cost shown" : "no cost anywhere (ongoing line, thread)", alt ? s.totalCost.some((t) => /\$0\.52/.test(t)) : s.replyCost.length === 0 && s.totalCost.length === 0 && !/\$/.test(s.ongoing), JSON.stringify([s.replyCost, s.totalCost, s.ongoing]));
    subagentsOnce(s, "end");
    await shot(page, `${run}-6-done`);
  } catch (e) {
    check(run, "ran to the end", false, String(e?.message ?? e).split("\n")[0]);
    await shot(page, `${run}-error`).catch(() => {});
  }
  const cons = consoleProblems(log);
  check(run, "no console errors", cons.length === 0, cons.join(" | "));
  const refused = await page.evaluate(() => window.__previewPhone?.refused ?? []).catch(() => []);
  check(run, "nothing refused or outbound", !refused.length && !log.outbound.length, JSON.stringify([refused, log.outbound]));
  await browser.close();
}

const RUNS = [
  ["conv-a", () => desktop("conv-a", false)],
  ["conv-a-alt", () => desktop("conv-a-alt", true)],
  ["conv-b", () => desktop("conv-b", false)],
  ["conv-c", () => phone("conv-c", false)],
  ["conv-c-alt", () => phone("conv-c-alt", true)],
];
for (const [id, fn] of RUNS) if (!ONLY.length || ONLY.includes(id)) await fn();
writeFileSync(join(OUT, "conv-check.json"), JSON.stringify({ at: new Date().toISOString(), origin: ORIGIN, passes, fails, results }, null, 1));
console.log(`\n${passes}/${passes + fails} checks passed`);
process.exit(fails ? 1 : 0);
