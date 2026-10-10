// A fake OpenRouter for CONTEXT's tests: POST /responses (Responses API,
// non-streaming, with usage.cost) answered by a script, GET /models a catalog.
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { configureContext, resetContextConfig } from "../config";

export type FakeReq = { model: string; instructions?: string; input: any; tools?: any[]; [k: string]: unknown };
export type FakeReply = { text?: string; calls?: { name: string; arguments: unknown }[]; cost?: number; status?: number; delayMs?: number };

export type FakeModel = {
  base: string;
  requests: FakeReq[];
  auth: string[];
  script: (req: FakeReq, n: number) => FakeReply;
  close: () => Promise<void>;
};

export async function startFakeModel(
  script: (req: FakeReq, n: number) => FakeReply,
  catalog: { id: string; context_length: number }[] = [],
): Promise<FakeModel> {
  const fake: FakeModel = { base: "", requests: [], auth: [], script, close: async () => {} };
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.method === "GET" && req.url === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: catalog }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/responses") {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body) as FakeReq;
      fake.requests.push(parsed);
      fake.auth.push(String(req.headers.authorization ?? ""));
      const r = fake.script(parsed, n++);
      if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
      if (r.status && r.status !== 200) {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "scripted failure" } }));
        return;
      }
      const output: any[] = [];
      for (const [i, c] of (r.calls ?? []).entries()) {
        output.push({ type: "function_call", id: `fc_${n}_${i}`, call_id: `call_${n}_${i}`, name: c.name, arguments: JSON.stringify(c.arguments) });
      }
      if (r.text !== undefined) {
        output.push({ type: "message", role: "assistant", id: `msg_${n}`, status: "completed", content: [{ type: "output_text", text: r.text, annotations: [] }] });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `gen-fake-${n}`,
          object: "response",
          status: "completed",
          model: parsed.model,
          output,
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, cost: r.cost ?? 0.001 },
        }),
      );
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  fake.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((ok) => server.close(() => ok()));
  return fake;
}

/** All input text of a request, flattened (for assertions). */
export function inputText(req: FakeReq): string {
  const parts: string[] = [];
  const walk = (v: any) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if (typeof v.text === "string") parts.push(v.text);
      if (typeof v.output === "string") parts.push(v.output);
      if (v.content) walk(v.content);
    }
  };
  walk(req.input);
  return parts.join("\n");
}

/** A temp vault with `.vault-chat/`, CONTEXT configured on it. */
export function tempVault(base?: string): { vault: string; cleanup: () => void } {
  const vault = mkdtempSync(join(tmpdir(), "vc-context-"));
  mkdirSync(join(vault, ".vault-chat", "conversations"), { recursive: true });
  resetContextConfig();
  configureContext({ vault, apiKey: () => "sk-test-not-a-key", ...(base ? { baseUrl: base } : {}) });
  return { vault, cleanup: () => rmSync(vault, { recursive: true, force: true }) };
}

export function writeConv(vault: string, meta: Record<string, unknown>, messages: Record<string, unknown>[] = []): void {
  const lines = [JSON.stringify(meta), ...messages.map((m) => JSON.stringify(m))];
  writeFileSync(join(vault, ".vault-chat", "conversations", `${meta.id}.jsonl`), lines.join("\n") + "\n");
}
