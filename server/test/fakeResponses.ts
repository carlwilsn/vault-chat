// A fake OpenRouter that speaks the Responses API the way Codex uses it
// (POST /responses, SSE), with usage.cost, plus GET /generation?id= (the
// ledger's lookup, 404 for the first try of each id like the real one),
// /models, and non-streaming /responses + /chat/completions for CONTEXT's
// recap/verifier and WebSearch. Each model call asks `respond(body)` what to do.
import { createServer, type Server } from "node:http";

export type Step =
  | { text: string; delayMs?: number }
  | { call: { name: string; args: unknown }; text?: string; delayMs?: number }
  | { status: number; body?: string };

export type FakeResponses = {
  url: string;
  /** Every /responses body Codex sent (streaming ones). */
  calls: any[];
  /** Cost per call, by response id. */
  costs: Map<string, number>;
  respond: (body: any, n: number) => Step;
  /** Refuse requests that carry a `namespace` tool. */
  rejectNamespace: boolean;
  /** Plain text of all input items of a request. */
  inputText: (body: any) => string;
  close: () => Promise<void>;
};

export const COST_PER_CALL = 0.0012;

function inputText(body: any): string {
  const out: string[] = [];
  const walk = (v: any) => {
    if (v == null) return;
    if (typeof v === "string") return void out.push(v);
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === "object") {
      if (typeof v.text === "string") out.push(v.text);
      if (typeof v.output === "string") out.push(v.output);
      if (Array.isArray(v.output)) walk(v.output);
      if (v.content) walk(v.content);
    }
  };
  walk(body?.input);
  return out.join("\n");
}

export async function fakeResponses(): Promise<FakeResponses> {
  const state: FakeResponses = {
    url: "",
    calls: [],
    costs: new Map(),
    respond: () => ({ text: "ok" }),
    rejectNamespace: false,
    inputText,
    close: async () => {},
  };
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
        res.end(
          JSON.stringify({
            data: [
              { id: "test/fake-model", context_length: 400000, supported_parameters: ["tools"], architecture: { input_modalities: ["text"] }, pricing: {} },
              { id: "openai/gpt-6.1-sol", context_length: 1050000, supported_parameters: ["tools"], architecture: { input_modalities: ["text", "image", "file"] }, pricing: { input_cache_read: "0.0000001" } },
            ],
          }),
        );
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
      if (path.endsWith("/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "gen-chat", choices: [{ message: { role: "assistant", content: "fake web answer https://example.com" } }], usage: { cost: 0.0001 } }));
        return;
      }
      if (!path.endsWith("/responses")) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      if (!body.stream) {
        // CONTEXT's recap / verifier calls.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "gen-ctx", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"verdict":"pass","notes":["fake verifier"]}' }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cost: 0.0001 } }));
        return;
      }
      n++;
      state.calls.push(body);
      // Like some OpenRouter endpoints (Codex #32318): a `namespace` tool is refused.
      if (state.rejectNamespace && JSON.stringify(body.tools ?? []).includes('"type":"namespace"')) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "No endpoints found that support the native `namespace` tool type.", code: 404 } }));
        return;
      }
      const step = state.respond(body, n);
      if ("status" in step) {
        res.writeHead(step.status, { "content-type": "application/json" });
        res.end(step.body ?? JSON.stringify({ error: { message: "fake error" } }));
        return;
      }
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      const id = `gen-${n}`;
      state.costs.set(id, COST_PER_CALL);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type: string, o: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
      const base = { id, object: "response", status: "in_progress", output: [] as any[] };
      ev("response.created", { response: base });
      const output: any[] = [];
      let idx = 0;
      const text = "text" in step ? step.text : undefined;
      if (text) {
        const item = { type: "message", id: `msg_${n}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
        ev("response.output_item.added", { output_index: idx, item: { ...item, content: [] } });
        ev("response.output_text.delta", { output_index: idx, content_index: 0, item_id: item.id, delta: text });
        ev("response.output_item.done", { output_index: idx, item });
        output.push(item);
        idx++;
      }
      if ("call" in step) {
        const item = { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: step.call.name, arguments: JSON.stringify(step.call.args), status: "completed" };
        ev("response.output_item.added", { output_index: idx, item });
        ev("response.output_item.done", { output_index: idx, item });
        output.push(item);
      }
      ev("response.completed", {
        response: {
          ...base,
          status: "completed",
          output,
          usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1020, cost: COST_PER_CALL },
        },
      });
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
