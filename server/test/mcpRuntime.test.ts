// Real pi + official SDK protocol tests; no model calls, no UI proof, no keys.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpRuntime } from "../mcp/runtime";
import { PiProc } from "../engine/pi/proc";
import type { ToolSpec } from "../engine/pi/backend";

const spec: ToolSpec = { type: "function", name: "Echo", description: "Protocol test", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } };
const runtimes: McpRuntime[] = [];
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((c) => c.close())); await Promise.all(runtimes.splice(0).map((r) => r.close())); });
function runtime() { const r = new McpRuntime(); runtimes.push(r); return r; }
async function connect(bootstrap: { url: string; authorization: string }) {
  const c = new Client({ name: "independent-client", version: "test" }); clients.push(c);
  const transport = new StreamableHTTPClientTransport(new URL(bootstrap.url), { requestInit: { headers: { Authorization: bootstrap.authorization } } });
  await c.connect(transport);
  return { c, transport };
}

describe("revocable process scopes and stateful HTTP", () => {
  it("cancels across separate HTTP requests using the SDK session", async () => {
    let begin!: () => void, abort!: () => void;
    const began = new Promise<void>((r) => { begin = r; });
    const aborted = new Promise<void>((r) => { abort = r; });
    const r = runtime();
    const binding = await r.bind({ specs: [spec], call: async (_name, _args, ctx) => {
      begin();
      await new Promise<void>((resolve) => { ctx.signal.addEventListener("abort", () => { abort(); resolve(); }, { once: true }); });
      return { ok: false, text: "cancelled" };
    } }, {});
    const { c } = await connect(binding.bootstrap);
    const controller = new AbortController();
    const pending = c.callTool({ name: "Echo", arguments: { text: "wait" } }, undefined, { signal: controller.signal });
    const rejected = expect(pending).rejects.toBeDefined();
    await began; controller.abort(); await rejected; await aborted;
  });

  it("does not let a restricted capability borrow a privileged MCP session", async () => {
    const r = runtime();
    const full = await r.bind({ specs: [spec], call: async () => ({ ok: true, text: "full" }) }, { env: () => ({ TEST_ONLY: "not-a-real-key" }) });
    const restricted = await r.bind({ specs: [], call: async () => { throw new Error("must not run"); } }, {});
    const { transport } = await connect(full.bootstrap);
    const response = await fetch(restricted.bootstrap.url, { headers: { Authorization: restricted.bootstrap.authorization, "Mcp-Session-Id": transport.sessionId!, Accept: "text/event-stream" } });
    expect(response.status).toBe(404);
    expect((await fetch(new URL("/context/env", restricted.bootstrap.url), { method: "POST", headers: { Authorization: restricted.bootstrap.authorization }, body: "{}" })).status).toBe(404);
    expect((await fetch(full.bootstrap.url)).status).toBe(401);
    await full.revoke();
    expect((await fetch(full.bootstrap.url, { headers: { Authorization: full.bootstrap.authorization } })).status).toBe(401);
  });

  it("revocation aborts in-flight operations and invalidates the private services", async () => {
    let begin!: () => void, abort!: () => void;
    const began = new Promise<void>((r) => { begin = r; });
    const aborted = new Promise<void>((r) => { abort = r; });
    const r = runtime();
    const binding = await r.bind({ specs: [spec], call: async (_n, _a, ctx) => {
      begin(); await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => { abort(); resolve(); }, { once: true }));
      return { ok: false, text: "revoked" };
    } }, { fileWrite: async () => true });
    const { c } = await connect(binding.bootstrap);
    const controller = new AbortController();
    const pending = c.callTool({ name: "Echo", arguments: { text: "wait" } }, undefined, { signal: controller.signal });
    const caught = pending.catch(() => undefined);
    await began; await binding.revoke(); await aborted; controller.abort(); await caught;
    expect((await fetch(new URL("/context/file-write", binding.bootstrap.url), { method: "POST", headers: { Authorization: binding.bootstrap.authorization }, body: "{}" })).status).toBe(401);
  });

  it("uses native pinned pi MCP, not tool re-registration or an editor bridge", async () => {
    const root = mkdtempSync(join(tmpdir(), "vc-native-mcp-"));
    const agentDir = join(root, "agent"); mkdirSync(agentDir);
    // Deterministic local provider fixture, not a UI/mockup or a model request.
    // Native pi still parses the provider tool call and owns the entire pipeline.
    let requests = 0;
    const provider = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const first = requests++ === 0;
      const declared = body.tools?.map((t: any) => t.function?.name) ?? [];
      const delta = first && declared.includes("mcp__vault_chat__Echo")
        ? { role: "assistant", tool_calls: [{ index: 0, id: "native-call", type: "function", function: { name: "mcp__vault_chat__Echo", arguments: JSON.stringify({ text: "native-pi" }) } }] }
        : { role: "assistant", content: first ? "MCP not declared" : "finished" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.end(chunk(delta, null) + chunk({}, first && "tool_calls" in delta ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { test: { baseUrl: `http://127.0.0.1:${(provider.address() as {port: number}).port}/v1`, apiKey: "test-only-not-a-key", api: "openai-completions", models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] } } }));
    const binding = await runtime().bind({ specs: [spec], call: async (_name, args) => ({ ok: true, text: String(args.text) }) }, { fileWrite: async () => true, env: () => ({}) });
    // Explicit pinned installation, never the invoking agent's env/config/keys.
    const prefix = process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0");
    const cli = join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    const proc = new PiProc({
      argv: [process.execPath, cli, "--mode", "rpc", "--no-session", "-ne", "-e", "builtin:mcp", "-e", resolve("server/engine/pi/ext/vc.mjs"), "--model", "test/test", "-na", "--offline", "-ns", "-np", "--no-themes"],
      cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" }, key: null,
      bootstrap: JSON.stringify({ ...binding.bootstrap, tools: true }),
    });
    try {
      proc.start();
      expect((await proc.request({ type: "get_state" }, 30_000).catch((error) => { throw new Error(`${error.message}: ${proc.stderrTail}`); })).success).toBe(true);
      const settled = new Promise<void>((r) => proc.on("event", (e) => { if (e.type === "agent_settled") r(); }));
      const response = await proc.request({ type: "prompt", message: "Call Echo" }, 30_000);
      expect(response.success).toBe(true); await settled;
      const messages = (await proc.request({ type: "get_messages" })).data.messages;
      expect(messages.find((m: any) => m.role === "toolResult")).toMatchObject({ toolCallId: "native-call", toolName: "mcp__vault_chat__Echo", content: [{ type: "text", text: "native-pi" }] });
      expect(requests).toBe(2);
    } finally {
      await proc.close(); await binding.revoke();
      await new Promise<void>((r) => provider.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
