#!/usr/bin/env node
// A stand-in for the Anthropic Messages API for the recorded self-test tour (test/selftest/tour.json): the app's
// own local server runs the real Claude Code CLI with ANTHROPIC_BASE_URL pointed here (and a made-up
// ANTHROPIC_API_KEY, which this never reads), so a chat turn, a Ctrl/Cmd+L ask and a Ctrl/Cmd+K edit get a
// reply with no account, no key and no spend. The reply streams a word at a time so the recording shows it arrive.
// Plain Node, no dependencies: CI starts it before the app.
//
//   node test/selftest/fake-anthropic.mjs <port> [log file]   (FAKE_DUMP=<file>: also write the text each request was matched on)
//
// Every request's path, model and whether it carried tools goes to the log (never a header: nothing secret is
// sent here anyway). server/test/claudeFakeApi.ts is the scriptable one the server tests use.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.argv[2] || 18765);
const logFile = process.argv[3];
const REPLY = "Hello from the fake model: this reply streams in a word at a time, so the tour can watch it arrive.";
const WORD_MS = 90;
let n = 0;

// The first-run tutorial's asks (test/selftest/tutorial.json), played as a real agent would: tool calls the real CLI
// runs (Bash in the vault, the app's own Show and ProposeEdit tools, found by name in the request's tool list; one the
// request does not offer is left out), then a short reply. Matched on the user's own words.
const NOTE = [
  "# The Broad Street Pump (1854)",
  "",
  "- Cholera killed more than 500 people in ten days in Soho, London.",
  "- Most doctors blamed bad air (miasma), not water.",
  "- John Snow mapped every death and where each household drew its water.",
  "- The deaths pile up around the Broad Street pump: the cause was the water.",
  "- The pump handle came off on 8 September 1854.",
  "",
  "The map (page 2) makes the case in one look: the bars stack up around one pump.",
  "",
].join("\n");
const FLASHCARDS = `export const meta = { name: "Flashcards", description: "Quizzes you on Welcome/broad-street.md. Each answer is saved in its state (answers), for the agent to read." };
export function mount(el, api) {
  const answers = [];
  let cards = [];
  let at = 0;
  const box = document.createElement("div");
  box.setAttribute("data-el", "flashcards");
  box.style.cssText = "position:fixed;right:24px;top:72px;z-index:44;width:300px;padding:14px;border-radius:12px;background:hsl(var(--card));color:hsl(var(--card-foreground));border:1px solid hsl(var(--border));box-shadow:0 10px 30px rgba(0,0,0,.3);font:13px/1.5 system-ui,sans-serif";
  document.body.appendChild(box);
  api.effect(() => box.remove());
  const draw = () => {
    box.replaceChildren();
    const head = document.createElement("div");
    head.style.cssText = "font-weight:650;margin-bottom:6px";
    head.textContent = "Flashcards: " + answers.filter((a) => a.knew).length + " of " + answers.length + " known";
    box.append(head);
    const card = cards[at % Math.max(1, cards.length)] || "Loading the note...";
    const face = document.createElement("div");
    face.style.cssText = "padding:10px;border-radius:8px;background:hsl(var(--accent));min-height:48px";
    face.textContent = card;
    box.append(face);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;margin-top:10px";
    for (const [label, knew] of [["I knew it", true], ["Not yet", false]]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.setAttribute("data-card-answer", knew ? "knew" : "not-yet");
      b.style.cssText = "all:unset;cursor:pointer;padding:4px 10px;border-radius:7px;border:1px solid hsl(var(--border))";
      api.listen(b, "click", () => {
        answers.push({ card, knew, at: new Date().toISOString() });
        emit.emit("answered", { card, knew });
        at++;
        draw();
      });
      row.append(b);
    }
    box.append(row);
  };
  const emit = api.offer({
    state: { answers: { description: "Every answer so far: the card, whether the user knew it, when.", read: () => answers } },
    events: { answered: { description: "An answer was given." } },
  });
  void api.host.readFile("Welcome/broad-street.md").then((t) => {
    cards = String(t || "").split("\\n").filter((l) => /^\\s*[-*]\\s+/.test(l)).map((l) => l.replace(/^\\s*[-*]\\s+/, ""));
    draw();
  });
  draw();
}`;
const SCRIPTS = [
  { when: /what is this map telling me/i, reply: "It shows the deaths piling up around the Broad Street pump (page 2) and thinning out with distance from it, even near other pumps: the cholera came from the water, not the air." },
  {
    when: /one-page note on this paper/i,
    tools: [
      { name: "Bash", input: { command: `mkdir -p Welcome && cat > Welcome/broad-street.md <<'VCEOF'\n${NOTE}VCEOF`, description: "Write the note" } },
      { suffix: "__Show", input: { path: "Welcome/broad-street.md", pane: "right", where: "laptop" } },
    ],
    reply: "Wrote Welcome/broad-street.md and opened it next to the paper.",
  },
  { when: /make this shorter/i, tools: [{ suffix: "__ProposeEdit", input: { action: "replace", newText: "Snow mapped each death and its water source." } }], reply: "Proposed a shorter line." },
  {
    when: /flashcard tool/i,
    tools: [{ name: "Bash", input: { command: `mkdir -p .vault-chat/plugins && cat > .vault-chat/plugins/flashcards.js <<'VCEOF'\n${FLASHCARDS}\nVCEOF`, description: "Make the flashcard plugin" } }],
    reply: "Your flashcards are open on the right. Each answer is saved; ask me how you did.",
  },
  // StartJob on a Mac (test/selftest/startjob.json): the job writes a proof file in the vault; its end comes back as
  // a wake turn ("Job <id> finished: exit 0.") that this answers, so the chat shows the end was reported.
  {
    when: /run a test job in the background/i,
    tools: [{ suffix: "__StartJob", input: { command: "echo job-ran-on-mac > job-proof.txt; uname -s >> job-proof.txt; sleep 3; echo job-end-line", name: "mac-proof", timeout: "10m" } }],
    reply: "Started the test job.",
  },
  { when: /Job mac-proof-[a-z0-9]+ finished: exit 0/i, reply: "The test job finished on this Mac: exit 0." },
  { when: /delete the tutorial/i, tools: [{ name: "Bash", input: { command: "rm -f .vault-chat/plugins/tutorial.js", description: "Delete the tutorial plugin" } }], reply: "Deleted the tutorial. Welcome/ and your note are still there." },
];

const textOf = (m) => (typeof m?.content === "string" ? m.content : (m?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"));
const hasText = (m) => m?.role === "user" && (typeof m.content === "string" || (m.content ?? []).some((b) => b.type === "text"));
/** What to send for this request: a script's next tool call, its reply, or the plain reply. */
function plan(body) {
  const msgs = body.messages ?? [];
  let u = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (hasText(msgs[i]) && !(msgs[i].content ?? []).some?.((b) => b.type === "tool_result")) { u = i; break; }
  // Without the turn's context of what the user did elsewhere (<you>: it quotes earlier asks).
  const said = (u >= 0 ? textOf(msgs[u]) : "").replace(/<you>[\s\S]*?<\/you>/g, "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  // Several asks in the text (a quoted earlier one): the one said last is this one.
  const at = (re) => [...said.matchAll(new RegExp(re.source, "gi"))].reduce((m, x) => Math.max(m, x.index ?? -1), -1);
  const script = SCRIPTS.map((s) => ({ s, i: at(s.when) })).filter((x) => x.i >= 0).sort((a, b) => b.i - a.i)[0]?.s;
  if (process.env.FAKE_DUMP) appendFileSync(process.env.FAKE_DUMP, `\n===== ${new Date().toISOString()}\n${said}\n`);
  if (!script) return { text: REPLY };
  const names = (body.tools ?? []).map((t) => t.name);
  const tools = (script.tools ?? []).map((t) => ({ ...t, name: t.name && names.includes(t.name) ? t.name : names.find((x) => t.suffix && x.endsWith(t.suffix)) })).filter((t) => t.name);
  // A scripted tool the request does not offer is left out: say which tools it did offer, so a missing one shows.
  if (tools.length < (script.tools ?? []).length) log(`  missing ${(script.tools ?? []).map((t) => t.name ?? t.suffix).join(",")}; offered: ${names.map((n) => n.replace(/^mcp__[^_]+__/, "")).join(",")}`);
  const done = msgs.slice(u + 1).filter((m) => m.role === "assistant").length;
  return done < tools.length ? { tool: tools[done], script } : { text: script.reply };
}

const log = (line) => {
  if (logFile) appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
};

createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", async () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      /* not JSON */
    }
    log(`${req.method} ${req.url} model=${body.model ?? "-"} tools=${(body.tools ?? []).length} stream=${!!body.stream}`);
    if (req.url?.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"input_tokens":42}');
    }
    if (!req.url?.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end("{}");
    }
    const id = ++n;
    const p = plan(body);
    log(`  -> ${p.tool ? `tool ${p.tool.name}` : `text ${p.text.slice(0, 40)}`}`);
    const usage = { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json", "request-id": `req_fake${id}` });
      return res.end(JSON.stringify({ id: `msg_fake${id}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: p.text ?? REPLY }], stop_reason: "end_turn", stop_sequence: null, usage }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": `req_fake${id}` });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: `msg_fake${id}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    if (p.tool) {
      const tid = `toolu_fake${id}`;
      ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: tid, name: p.tool.name, input: {} } });
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(p.tool.input) } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
      ev("message_stop", {});
      return res.end();
    }
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    const words = p.text.split(/(?<= )/);
    for (const w of words) {
      if (res.destroyed) return;
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: w } });
      await new Promise((r) => setTimeout(r, WORD_MS));
    }
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: words.length } });
    ev("message_stop", {});
    res.end();
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`fake Anthropic API on http://127.0.0.1:${port}`);
  log(`listening on ${port}`);
});
