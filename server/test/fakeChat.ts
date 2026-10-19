// A fake OpenRouter for the pi engine: POST /chat/completions streamed the way
// pi's openai-completions provider reads it (SSE chunks, tool_calls deltas, a
// final usage chunk with OpenRouter's `usage.cost`, and the x-generation-id
// header), GET /generation?id= (404 on the first try of each id, like the
// real one), /models, plus non-streaming /responses (CONTEXT's recap and
// verifier) and /chat/completions (WebSearch). Each model call asks
// `respond(body, n)` what to do.
import { createServer, type Server } from "node:http";

export type ChatStep =
  | { text: string; delayMs?: number; noCost?: boolean }
  | { call: { name: string; args: unknown }; text?: string; delayMs?: number; noCost?: boolean }
  | { status: number; body?: string };

export type FakeChat = {
  url: string;
  /** Every streamed /chat/completions body pi sent. */
  calls: any[];
  /** Every generation id the fake answered, with its cost. */
  costs: Map<string, number>;
  /** Ids looked up through /generation (after the first 404). */
  lookups: string[];
  respond: (body: any, n: number) => ChatStep;
  close: () => Promise<void>;
};

export const CHAT_COST = 0.0021;

/** All text of a chat-completions request (messages' content, tool results). */
export function chatText(body: any): string {
  const out: string[] = [];
  for (const m of body?.messages ?? []) {
    if (typeof m?.content === "string") out.push(m.content);
    else if (Array.isArray(m?.content)) for (const c of m.content) if (typeof c?.text === "string") out.push(c.text);
  }
  return out.join("\n");
}

/** The newest user message's text (Carl's: the "you" layer pi sends after it, as a user message, is skipped). */
export function lastUser(body: any): string {
  const ms: any[] = body?.messages ?? [];
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (m?.role !== "user") continue;
    const t = typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n");
    if (t.startsWith("<you>")) continue;
    return t;
  }
  return "";
}

/** The last message, when it is a tool result: its text. */
export function lastToolResult(body: any): string | null {
  const ms: any[] = body?.messages ?? [];
  const m = ms[ms.length - 1];
  if (m?.role !== "tool") return null;
  if (typeof m.content === "string") return m.content;
  return (m.content ?? []).map((c: any) => c?.text ?? "").join("\n");
}

export async function fakeChat(): Promise<FakeChat> {
  const state: FakeChat = { url: "", calls: [], costs: new Map(), lookups: [], respond: () => ({ text: "ok" }), close: async () => {} };
  const firstLookup = new Set<string>();
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      if (req.method === "GET" && path.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "test/fake-model", context_length: 400000, architecture: { input_modalities: ["text", "image"] }, pricing: {} }] }));
        return;
      }
      if (req.method === "GET" && path.endsWith("/generation")) {
        const id = url.searchParams.get("id") ?? "";
        if (!state.costs.has(id) || !firstLookup.has(id)) {
          firstLookup.add(id);
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "not found" } }));
          return;
        }
        state.lookups.push(id);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { id, total_cost: state.costs.get(id) } }));
        return;
      }
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* {} */
      }
      if (path.endsWith("/responses")) {
        // CONTEXT's recap / verifier calls.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "gen-ctx", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"verdict":"pass","notes":["fake verifier"]}' }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost: 0.0001 } }));
        return;
      }
      if (!path.endsWith("/chat/completions")) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "gen-web", choices: [{ message: { role: "assistant", content: "fake web answer https://example.com" } }], usage: { cost: 0.0001 } }));
        return;
      }
      n++;
      state.calls.push(body);
      const step = state.respond(body, n);
      if ("status" in step) {
        res.writeHead(step.status, { "content-type": "application/json" });
        res.end(step.body ?? JSON.stringify({ error: { message: "fake error" } }));
        return;
      }
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      const id = `gen-pi-${n}-${Date.now().toString(36)}`;
      state.costs.set(id, CHAT_COST);
      res.writeHead(200, { "content-type": "text/event-stream", "x-generation-id": id });
      const chunk = (o: any) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, ...o })}\n\n`);
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
      const text = "text" in step ? step.text : undefined;
      if (text) {
        // Two deltas, so streaming is exercised.
        const half = Math.ceil(text.length / 2);
        chunk({ choices: [{ index: 0, delta: { content: text.slice(0, half) }, finish_reason: null }] });
        chunk({ choices: [{ index: 0, delta: { content: text.slice(half) }, finish_reason: null }] });
      }
      if ("call" in step) {
        chunk({
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: step.call.name, arguments: JSON.stringify(step.call.args) } }] }, finish_reason: null }],
        });
      }
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "call" in step ? "tool_calls" : "stop" }] });
      chunk({
        choices: [],
        usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 0 }, ...(step.noCost ? {} : { cost: CHAT_COST }) },
      });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  state.url = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
  state.close = () =>
    new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return state;
}
