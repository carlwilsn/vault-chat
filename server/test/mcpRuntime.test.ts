// Real pi + official SDK protocol tests; no model calls, no UI proof, no keys.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpRuntime } from "../mcp/runtime";
import { PiProc } from "../engine/pi/proc";
import type { ToolSpec } from "../engine/pi/backend";
import { pdfPagesAnswer, pdfPagesSpec } from "../engine/extraTools";
import { filesystemBinding } from "../mcp/filesystem";
import { makePdf, textPage } from "./pdfgen";

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

  it.each(["Echo", "PdfPages", "read", "write", "bash"])("uses native pinned pi MCP for %s, including provider context/binary attachments", async (tool) => {
    const root = mkdtempSync(join(tmpdir(), "vc-native-mcp-"));
    const agentDir = join(root, "agent"); mkdirSync(agentDir);
    // Deterministic local provider fixture, not a UI/mockup or a model request.
    // Native pi still parses the provider tool call and owns the entire pipeline.
    let requests = 0;
    const payloads: any[] = [];
    const source = makePdf([textPage("Not requested", []), textPage("Requested page", ["Native MCP PDF bytes"])]);
    writeFileSync(join(root, "source.pdf"), source);
    const nativeName = `mcp__vault_chat__${tool}`;
    writeFileSync(join(root, "note.txt"), "shared file read");
    const args = tool === "PdfPages" ? { path: "source.pdf", pages: "2" } : tool === "read" ? { path: "note.txt" } : tool === "write" ? { path: "written.txt", content: "shared file write" } : tool === "bash" ? { command: "printf 'native-first\\n'; sleep 0.5; printf 'native-final\\n'", timeout: 5 } : { text: "native-pi" };
    const prefix = process.env.VC_TEST_PI_DIR ?? join(homedir(), ".local/state/vault-chat-server/pi/1.1.0");
    const cli = join(prefix, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    const fs = await filesystemBinding({ cli, node: process.execPath, script: resolve("server/engine/pi/ext/filesystem.mjs"), cwd: root, home: root, outer: null, shell: null, denyRead: [], denyWrite: [], allowed: ["read", "write", "bash"], env: () => ({}), fileWrite: async () => true });
    const provider = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      payloads.push(body);
      const first = requests++ === 0;
      const declared = body.tools?.map((t: any) => t.function?.name) ?? [];
      const delta = first && declared.includes(nativeName)
        ? { role: "assistant", tool_calls: [{ index: 0, id: "native-call", type: "function", function: { name: nativeName, arguments: JSON.stringify(args) } }] }
        : { role: "assistant", content: first ? "MCP not declared" : "finished" };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      res.end(chunk(delta, null) + chunk({}, first && "tool_calls" in delta ? "tool_calls" : "stop") + "data: [DONE]\n\n");
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { test: { baseUrl: `http://127.0.0.1:${(provider.address() as {port: number}).port}/v1`, apiKey: "test-only-not-a-key", api: "openai-completions", models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }] } } }));
    const seenSince: (number | null)[] = [];
    const binding = await runtime().bind({
      specs: tool === "read" || tool === "write" || tool === "bash" ? fs.specs.filter((s) => s.name === tool) : [tool === "PdfPages" ? pdfPagesSpec : spec],
      call: async (name, args, context) => tool === "PdfPages" ? pdfPagesAnswer(root, args) : tool === "read" || tool === "write" || tool === "bash" ? fs.call(name, args, context) : { ok: true, text: String(args.text) },
    }, {
      fileWrite: async () => true, env: () => ({}),
      you: async (since) => { seenSince.push(since); return { text: "<you>Focus: native-context.pdf</you>", until: 123 }; },
    });
    // Explicit pinned installation, never the invoking agent's env/config/keys.
    const proc = new PiProc({
      argv: [process.execPath, cli, "--mode", "rpc", "--no-session", "-ne", "-e", "builtin:mcp", "-e", resolve("server/engine/pi/ext/vc.mjs"), "--model", "test/test", "-na", "--offline", "-ns", "-np", "--no-themes", "--tools", nativeName],
      cwd: root, env: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1", VC_PI_YOU: "1" }, key: null,
      bootstrap: JSON.stringify({ ...binding.bootstrap, tools: true }),
    });
    try {
      proc.start();
      expect((await proc.request({ type: "get_state" }, 30_000).catch((error) => { throw new Error(`${error.message}: ${proc.stderrTail}`); })).success).toBe(true);
      const events: any[] = [];
      let endSeen = false;
      const settled = new Promise<void>((r) => proc.on("event", (e) => {
        events.push(e);
        if (e.type === "tool_execution_end") endSeen = true;
        if (e.type === "tool_execution_update") expect(endSeen).toBe(false);
        if (e.type === "agent_settled") r();
      }));
      const response = await proc.request({ type: "prompt", message: `Call ${tool}` }, 30_000);
      expect(response.success).toBe(true); await settled;
      const messages = (await proc.request({ type: "get_messages" })).data.messages;
      const result = messages.find((m: any) => m.role === "toolResult");
      expect(result).toMatchObject({ toolCallId: "native-call", toolName: nativeName, isError: false });
      expect(seenSince).toEqual([null]);
      expect(JSON.stringify(payloads[0].messages)).toContain("<you>Focus: native-context.pdf</you>");
      if (tool === "PdfPages") {
        expect(result.content[0].text).toContain("[PDF pages attached:");
        const parts = payloads[1].messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === "file");
        expect(parts).toHaveLength(1);
        expect(parts[0].file.file_data).toMatch(/^data:application\/pdf;base64,/);
        const bytes = Buffer.from(parts[0].file.file_data.split(",")[1], "base64");
        const pdfjs = await import("pdfjs-dist");
        const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
        try {
          expect(doc.numPages).toBe(1);
          const page = await doc.getPage(1);
          expect(JSON.stringify(await page.getTextContent())).toContain("Requested page");
          expect(JSON.stringify(await page.getTextContent())).not.toContain("Not requested");
        } finally { await doc.destroy(); }
      } else if (tool === "read") expect(result.content[0].text).toContain("shared file read");
      else if (tool === "write") expect(readFileSync(join(root, "written.txt"), "utf8")).toBe("shared file write");
      else if (tool === "bash") {
        const previews = events.filter((e) => e.type === "tool_execution_update");
        expect(previews.some((e) => e.partialResult?.content?.[0]?.text === "native-first\n")).toBe(true);
        expect(result.content[0].text).toBe("native-first\nnative-final\n");
        expect(events.findIndex((e) => e.type === "tool_execution_update")).toBeLessThan(events.findIndex((e) => e.type === "tool_execution_end"));
      } else expect(result.content).toEqual([{ type: "text", text: "native-pi" }]);
      expect(payloads[0].tools.map((t: any) => t.function.name)).toEqual([nativeName]);
      expect(requests).toBe(2);
    } finally {
      await proc.close(); await binding.revoke();
      await new Promise<void>((r) => provider.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
