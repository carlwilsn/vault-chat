// TEST ONLY: a scripted stand-in for the Anthropic Messages API, so a test can
// drive the real Claude Code CLI with fixed replies and no network, model or
// key. It speaks only what the CLI needs: streaming /v1/messages and
// /v1/messages/count_tokens.
//
// The script is written in the prompt: `CALL <tool> <json>` makes the reply a
// tool call; anything else gets a plain text reply naming what it last saw, so
// a test can tell which message a turn was answering.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeApi = {
  url: string;
  /** Every request body the CLI sent, in order. */
  requests: any[];
  close: () => Promise<void>;
};

const textOf = (c: any): string => (typeof c === "string" ? c : (c ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n"));
const isToolResult = (m: any) => m?.role === "user" && Array.isArray(m.content) && m.content.some((b: any) => b?.type === "tool_result");

/** The reply this request should get: a tool call the prompt asked for, or text. */
function decide(body: any): { tool?: { name: string; input: any }; text?: string } {
  const msgs: any[] = body.messages ?? [];
  const hasTools = (body.tools ?? []).length > 0;
  // The last real (non tool-result) user message that carries a CALL directive.
  let di = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user" || isToolResult(m)) continue;
    if (/CALL \S+ \{/.test(textOf(m.content))) {
      di = i;
      break;
    }
    if (textOf(m.content).trim()) break;
  }
  if (hasTools && di >= 0) {
    const steps = textOf(msgs[di].content).match(/CALL \S+ \{.*?\}/gms) ?? [];
    const done = msgs.slice(di + 1).filter((m) => m.role === "assistant" && (m.content ?? []).some?.((b: any) => b.type === "tool_use")).length;
    if (done < steps.length) {
      const m = /CALL (\S+) (\{.*\})/s.exec(steps[done]!)!;
      return { tool: { name: m[1]!, input: JSON.parse(m[2]!) } };
    }
  }
  const lastUser = [...msgs].reverse().find((m) => m.role === "user" && !isToolResult(m));
  // The host puts its context above the message; the last non-empty line is what was asked.
  const asked = textOf(lastUser?.content).split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return { text: `REPLY to: ${asked.slice(-120)}` };
}

export async function fakeAnthropic(o: { delayMs?: number } = {}): Promise<FakeApi> {
  const requests: any[] = [];
  let n = 0;
  const srv: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      let body: any = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* not JSON */
      }
      if (req.url?.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end('{"input_tokens":42}');
      }
      if (!req.url?.startsWith("/v1/messages")) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end("{}");
      }
      const id = ++n;
      requests.push(body);
      const d = decide(body);
      const usage = { input_tokens: 1000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": `req_fake${id}` });
      const ev = (type: string, data: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev("message_start", { message: { id: `msg_fake${id}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
      if (d.tool) {
        ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_fake${id}`, name: d.tool.name, input: {} } });
        ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(d.tool.input) } });
      } else {
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
        ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: d.text } });
      }
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: d.tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
      ev("message_stop", {});
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}
