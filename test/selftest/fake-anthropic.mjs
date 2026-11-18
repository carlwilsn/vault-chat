#!/usr/bin/env node
// A stand-in for the Anthropic Messages API for the recorded self-test tour (test/selftest/tour.json): the app's
// own local server runs the real Claude Code CLI with ANTHROPIC_BASE_URL pointed here (and a made-up
// ANTHROPIC_API_KEY, which this never reads), so a chat turn, a Ctrl/Cmd+L ask and a Ctrl/Cmd+K edit get a
// reply with no account, no key and no spend. The reply streams a word at a time so the recording shows it arrive.
// Plain Node, no dependencies: CI starts it before the app.
//
//   node test/selftest/fake-anthropic.mjs <port> [log file]
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
    const usage = { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json", "request-id": `req_fake${id}` });
      return res.end(JSON.stringify({ id: `msg_fake${id}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: REPLY }], stop_reason: "end_turn", stop_sequence: null, usage }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": `req_fake${id}` });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: `msg_fake${id}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    const words = REPLY.split(/(?<= )/);
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
